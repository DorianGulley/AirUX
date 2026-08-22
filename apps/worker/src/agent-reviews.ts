import {
  type AgentReview,
  type AgentReviewSummary,
  agentReviewSchema,
  agentReviewSummarySchema,
  CONTRACT_LIMITS,
  cancelAgentReviewResponseSchema,
  createReviewRequestSchema,
  createReviewResponseSchema,
  getAgentReviewResponseSchema,
  listOpenAgentReviewsResponseSchema,
} from "@airux/shared/v1";
import type { AuthenticatedAgent } from "./agent-auth.js";
import { jsonResponse } from "./api-response.js";
import {
  InvalidJsonBodyError,
  readJsonRequest,
  readJsonResponse,
} from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";
import { calculateExpiration, EXPIRATION_POLICY } from "./expiration-policy.js";

const DATA_RESPONSE_LIMIT = 1024 * 1024;
const DATA_ERROR_RESPONSE_LIMIT = 16 * 1024;
const REQUEST_BODY_LIMIT = 32 * 1024;
const RESULT_POLL_RETRY_AFTER_SECONDS = 2;
const MAX_VIDEO_DURATION_SECONDS = CONTRACT_LIMITS.captureDurationMs / 1000;
const RPC_ERROR_CODE = "P0001";
const PAYLOAD_CONFLICT_MESSAGE = "client request payload conflict";
const UPLOAD_STATE_CONFLICT_MESSAGE = "review is no longer accepting uploads";
const CANCELLATION_CONFLICT_MESSAGE = "review cannot be cancelled";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ReviewStreamClient {
  createDirectUpload(params: {
    readonly maxDurationSeconds: number;
    readonly expiry: string;
    readonly creator: string;
    readonly meta: Record<string, string>;
    readonly requireSignedURLs: boolean;
  }): Promise<{ readonly id: string; readonly uploadURL: string }>;
  deleteVideo(id: string): Promise<void>;
}

export interface AgentReviewDependencies {
  readonly stream: ReviewStreamClient;
  readonly fetcher?: Fetcher;
  readonly now?: () => Date;
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

interface CreateReviewRow {
  readonly reviewId: string;
  readonly evidenceId: string;
  readonly created: boolean;
}

class ReviewNotFoundError extends Error {}
class ReviewConflictError extends Error {}
class ReviewServiceError extends Error {}

function dataApiHeaders(config: AiruxConfig) {
  return {
    accept: "application/json",
    apikey: config.supabase.secretKey,
    "content-type": "application/json",
  };
}

function dataApiUrl(config: AiruxConfig, path: string) {
  return new URL(`/rest/v1/${path}`, config.supabase.url);
}

async function fetchData(url: URL, init: RequestInit, fetcher: Fetcher) {
  try {
    return await fetcher(url, { ...init, redirect: "manual" });
  } catch {
    throw new ReviewServiceError();
  }
}

async function readRows(response: Response) {
  let body: unknown;
  try {
    body = await readJsonResponse(response, DATA_RESPONSE_LIMIT);
  } catch {
    throw new ReviewServiceError();
  }
  if (!Array.isArray(body)) {
    throw new ReviewServiceError();
  }
  return body;
}

async function readRpcErrorMessage(response: Response) {
  let body: unknown;
  try {
    body = await readJsonResponse(response, DATA_ERROR_RESPONSE_LIMIT);
  } catch {
    return null;
  }
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const error = body as Record<string, unknown>;
  return error.code === RPC_ERROR_CODE && typeof error.message === "string"
    ? error.message
    : null;
}

function normalizeTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeNullableTimestamp(value: unknown) {
  return value === null ? null : normalizeTimestamp(value);
}

function reviewUrl(config: AiruxConfig, reviewId: string) {
  return new URL(`/reviews/${reviewId}`, config.appOrigin).toString();
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeCreateRow(value: unknown): CreateReviewRow | null {
  const row = asRecord(value);
  if (
    row === null ||
    typeof row.review_id !== "string" ||
    !UUID_PATTERN.test(row.review_id) ||
    typeof row.evidence_id !== "string" ||
    !UUID_PATTERN.test(row.evidence_id) ||
    row.status !== "draft" ||
    typeof row.created !== "boolean" ||
    (row.stream_video_id !== null && typeof row.stream_video_id !== "string")
  ) {
    return null;
  }
  return {
    reviewId: row.review_id,
    evidenceId: row.evidence_id,
    created: row.created,
  };
}

function normalizeSummary(
  value: unknown,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
): AgentReviewSummary | null {
  const row = asRecord(value);
  if (
    row === null ||
    row.user_id !== agent.userId ||
    row.agent_credential_id !== agent.credentialId ||
    typeof row.id !== "string"
  ) {
    return null;
  }
  const parsed = agentReviewSummarySchema.safeParse({
    id: row.id,
    review_url: reviewUrl(config, row.id),
    client_request_id: row.client_request_id,
    title: row.title,
    status: row.status,
    version: row.version,
    created_at: normalizeTimestamp(row.created_at),
    expires_at: normalizeTimestamp(row.expires_at),
  });
  return parsed.success ? parsed.data : null;
}

function normalizeReview(
  reviewValue: unknown,
  evidenceValue: unknown,
  decisionValue: unknown,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
): AgentReview | null {
  const review = asRecord(reviewValue);
  const evidence = asRecord(evidenceValue);
  const decision = decisionValue === null ? null : asRecord(decisionValue);
  if (
    review === null ||
    evidence === null ||
    (decisionValue !== null && decision === null) ||
    review.user_id !== agent.userId ||
    review.agent_credential_id !== agent.credentialId ||
    typeof review.id !== "string" ||
    evidence.review_id !== review.id ||
    (decision !== null && decision.review_id !== review.id)
  ) {
    return null;
  }

  const parsed = agentReviewSchema.safeParse({
    id: review.id,
    review_url: reviewUrl(config, review.id),
    client_request_id: review.client_request_id,
    title: review.title,
    claim: review.claim,
    criteria: review.criteria,
    status: review.status,
    version: review.version,
    created_at: normalizeTimestamp(review.created_at),
    submitted_at: normalizeNullableTimestamp(review.submitted_at),
    expires_at: normalizeTimestamp(review.expires_at),
    resolved_at: normalizeNullableTimestamp(review.resolved_at),
    evidence: {
      id: evidence.id,
      kind: evidence.kind,
      status: evidence.status,
      media_type: evidence.media_type,
      size_bytes: evidence.size_bytes,
      failure_code: evidence.failure_code,
    },
    decision:
      decision === null
        ? null
        : {
            outcome: decision.outcome,
            comment: decision.comment,
            created_at: normalizeTimestamp(decision.created_at),
          },
  });
  return parsed.success ? parsed.data : null;
}

async function createReviewRecord(
  body: ReturnType<typeof createReviewRequestSchema.parse>,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  fetcher: Fetcher,
  now: Date,
) {
  const expiresAt = calculateExpiration(now, EXPIRATION_POLICY.draftReviewMs);
  const response = await fetchData(
    dataApiUrl(config, "rpc/create_agent_review"),
    {
      method: "POST",
      headers: dataApiHeaders(config),
      body: JSON.stringify({
        p_user_id: agent.userId,
        p_agent_credential_id: agent.credentialId,
        p_client_request_id: body.client_request_id,
        p_title: body.title,
        p_claim: body.claim,
        p_criteria: body.criteria,
        p_evidence_kind: body.evidence.kind,
        p_media_type: body.evidence.media_type,
        p_size_bytes: body.evidence.size_bytes,
        p_expires_at: expiresAt,
        p_delete_after: expiresAt,
      }),
    },
    fetcher,
  );
  if (!response.ok) {
    const message = await readRpcErrorMessage(response);
    if (
      message === PAYLOAD_CONFLICT_MESSAGE ||
      message === UPLOAD_STATE_CONFLICT_MESSAGE
    ) {
      throw new ReviewConflictError();
    }
    throw new ReviewServiceError();
  }
  const rows = await readRows(response);
  const row = normalizeCreateRow(rows[0]);
  if (rows.length !== 1 || row === null) {
    throw new ReviewServiceError();
  }
  return row;
}

async function attachUpload(
  review: CreateReviewRow,
  streamVideoId: string,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  const response = await fetchData(
    dataApiUrl(config, "rpc/replace_agent_review_upload"),
    {
      method: "POST",
      headers: dataApiHeaders(config),
      body: JSON.stringify({
        p_review_id: review.reviewId,
        p_evidence_id: review.evidenceId,
        p_user_id: agent.userId,
        p_agent_credential_id: agent.credentialId,
        p_stream_video_id: streamVideoId,
      }),
    },
    fetcher,
  );
  if (!response.ok) {
    throw new ReviewServiceError();
  }
  const rows = await readRows(response);
  const row = asRecord(rows[0]);
  if (
    rows.length !== 1 ||
    row === null ||
    row.evidence_id !== review.evidenceId ||
    (row.previous_stream_video_id !== null &&
      typeof row.previous_stream_video_id !== "string")
  ) {
    throw new ReviewConflictError();
  }
  return row.previous_stream_video_id as string | null;
}

async function deleteStreamVideo(stream: ReviewStreamClient, id: string) {
  try {
    await stream.deleteVideo(id);
  } catch {
    // M6-5 provides durable deletion retries; this only cleans up replaced slots.
  }
}

async function createReview(
  request: Request,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  dependencies: AgentReviewDependencies,
) {
  const parsedRequest = createReviewRequestSchema.safeParse(
    await readJsonRequest(request, REQUEST_BODY_LIMIT),
  );
  if (!parsedRequest.success) {
    throw new InvalidJsonBodyError();
  }

  const fetcher = dependencies.fetcher ?? fetch;
  const now = (dependencies.now ?? (() => new Date()))();
  if (Number.isNaN(now.getTime())) {
    throw new ReviewServiceError();
  }
  const review = await createReviewRecord(
    parsedRequest.data,
    agent,
    config,
    fetcher,
    now,
  );
  const uploadExpiresAt = calculateExpiration(
    now,
    EXPIRATION_POLICY.uploadUrlMs,
  );

  let directUpload: Awaited<
    ReturnType<ReviewStreamClient["createDirectUpload"]>
  >;
  try {
    directUpload = await dependencies.stream.createDirectUpload({
      maxDurationSeconds: MAX_VIDEO_DURATION_SECONDS,
      expiry: uploadExpiresAt,
      creator: agent.credentialId,
      meta: {
        review_id: review.reviewId,
        evidence_id: review.evidenceId,
      },
      requireSignedURLs: true,
    });
    const uploadUrl = new URL(directUpload.uploadURL);
    if (
      directUpload.id.trim().length === 0 ||
      directUpload.id.length > CONTRACT_LIMITS.identifierLength ||
      uploadUrl.protocol !== "https:"
    ) {
      throw new ReviewServiceError();
    }
  } catch {
    throw new ReviewServiceError();
  }

  let previousStreamVideoId: string | null;
  try {
    previousStreamVideoId = await attachUpload(
      review,
      directUpload.id,
      agent,
      config,
      fetcher,
    );
  } catch (error) {
    await deleteStreamVideo(dependencies.stream, directUpload.id);
    throw error;
  }

  if (
    previousStreamVideoId !== null &&
    previousStreamVideoId !== directUpload.id
  ) {
    const cleanup = deleteStreamVideo(
      dependencies.stream,
      previousStreamVideoId,
    );
    dependencies.waitUntil?.(cleanup);
    if (dependencies.waitUntil === undefined) {
      await cleanup;
    }
  }

  return jsonResponse(
    createReviewResponseSchema.parse({
      review_id: review.reviewId,
      review_url: reviewUrl(config, review.reviewId),
      status: "draft",
      evidence_id: review.evidenceId,
      upload_url: directUpload.uploadURL,
      upload_expires_at: uploadExpiresAt,
    }),
    review.created ? 201 : 200,
  );
}

async function listOpenReviews(
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  const url = dataApiUrl(config, "reviews");
  url.searchParams.set(
    "select",
    "id,user_id,agent_credential_id,client_request_id,title,status,version,created_at,expires_at",
  );
  url.searchParams.set("user_id", `eq.${agent.userId}`);
  url.searchParams.set("agent_credential_id", `eq.${agent.credentialId}`);
  url.searchParams.set("status", "in.(draft,pending)");
  url.searchParams.set("deleted_at", "is.null");
  url.searchParams.set("order", "created_at.desc");
  const response = await fetchData(
    url,
    { method: "GET", headers: dataApiHeaders(config) },
    fetcher,
  );
  if (!response.ok) {
    throw new ReviewServiceError();
  }
  const rows = await readRows(response);
  const reviews = rows.map((row) => normalizeSummary(row, agent, config));
  if (reviews.some((review) => review === null)) {
    throw new ReviewServiceError();
  }
  return jsonResponse(
    listOpenAgentReviewsResponseSchema.parse({
      reviews: reviews as AgentReviewSummary[],
    }),
  );
}

async function getSingleRow(url: URL, config: AiruxConfig, fetcher: Fetcher) {
  const response = await fetchData(
    url,
    { method: "GET", headers: dataApiHeaders(config) },
    fetcher,
  );
  if (!response.ok) {
    throw new ReviewServiceError();
  }
  const rows = await readRows(response);
  if (rows.length > 1) {
    throw new ReviewServiceError();
  }
  return rows[0] ?? null;
}

async function getReview(
  reviewId: string,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  if (!UUID_PATTERN.test(reviewId)) {
    throw new ReviewNotFoundError();
  }

  const reviewUrl = dataApiUrl(config, "reviews");
  reviewUrl.searchParams.set(
    "select",
    "id,user_id,agent_credential_id,client_request_id,title,claim,criteria,status,version,created_at,submitted_at,expires_at,resolved_at",
  );
  reviewUrl.searchParams.set("id", `eq.${reviewId}`);
  reviewUrl.searchParams.set("user_id", `eq.${agent.userId}`);
  reviewUrl.searchParams.set("agent_credential_id", `eq.${agent.credentialId}`);
  reviewUrl.searchParams.set("deleted_at", "is.null");
  reviewUrl.searchParams.set("limit", "1");
  const review = await getSingleRow(reviewUrl, config, fetcher);
  if (review === null) {
    throw new ReviewNotFoundError();
  }

  const evidenceUrl = dataApiUrl(config, "evidence");
  evidenceUrl.searchParams.set(
    "select",
    "id,review_id,kind,status,media_type,size_bytes,failure_code",
  );
  evidenceUrl.searchParams.set("review_id", `eq.${reviewId}`);
  evidenceUrl.searchParams.set("limit", "1");

  const decisionUrl = dataApiUrl(config, "decisions");
  decisionUrl.searchParams.set(
    "select",
    "review_id,outcome,comment,created_at",
  );
  decisionUrl.searchParams.set("review_id", `eq.${reviewId}`);
  decisionUrl.searchParams.set("user_id", `eq.${agent.userId}`);
  decisionUrl.searchParams.set("limit", "1");

  const [evidence, decision] = await Promise.all([
    getSingleRow(evidenceUrl, config, fetcher),
    getSingleRow(decisionUrl, config, fetcher),
  ]);
  if (evidence === null) {
    throw new ReviewServiceError();
  }
  const normalized = normalizeReview(review, evidence, decision, agent, config);
  if (normalized === null) {
    throw new ReviewServiceError();
  }
  return normalized;
}

async function cancelReview(
  reviewId: string,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  if (!UUID_PATTERN.test(reviewId)) {
    throw new ReviewNotFoundError();
  }
  const response = await fetchData(
    dataApiUrl(config, "rpc/cancel_agent_review"),
    {
      method: "POST",
      headers: dataApiHeaders(config),
      body: JSON.stringify({
        p_review_id: reviewId,
        p_user_id: agent.userId,
        p_agent_credential_id: agent.credentialId,
      }),
    },
    fetcher,
  );
  if (!response.ok) {
    const message = await readRpcErrorMessage(response);
    if (message === CANCELLATION_CONFLICT_MESSAGE) {
      throw new ReviewConflictError();
    }
    throw new ReviewServiceError();
  }
  const rows = await readRows(response);
  const row = asRecord(rows[0]);
  if (rows.length === 0) {
    throw new ReviewNotFoundError();
  }
  if (
    rows.length !== 1 ||
    row === null ||
    row.review_id !== reviewId ||
    row.status !== "cancelled" ||
    typeof row.version !== "number"
  ) {
    throw new ReviewServiceError();
  }
  return getReview(reviewId, agent, config, fetcher);
}

function errorResponse(error: unknown) {
  if (error instanceof InvalidJsonBodyError) {
    return jsonResponse(
      { error: { code: "invalid_request", message: "Invalid request" } },
      400,
    );
  }
  if (error instanceof ReviewNotFoundError) {
    return jsonResponse(
      { error: { code: "not_found", message: "Not found" } },
      404,
    );
  }
  if (error instanceof ReviewConflictError) {
    return jsonResponse(
      { error: { code: "conflict", message: "Review conflict" } },
      409,
    );
  }
  return jsonResponse(
    { error: { code: "internal_error", message: "Service unavailable" } },
    503,
  );
}

export async function handleAgentReviewCollection(
  request: Request,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  dependencies: AgentReviewDependencies,
) {
  try {
    if (request.method === "POST") {
      return await createReview(request, agent, config, dependencies);
    }
    return await listOpenReviews(agent, config, dependencies.fetcher ?? fetch);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleAgentReviewGet(
  reviewId: string,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  dependencies: Omit<AgentReviewDependencies, "stream">,
) {
  try {
    const review = await getReview(
      reviewId,
      agent,
      config,
      dependencies.fetcher ?? fetch,
    );
    return jsonResponse(
      getAgentReviewResponseSchema.parse({
        review,
      }),
      200,
      review.status === "draft" || review.status === "pending"
        ? { "retry-after": String(RESULT_POLL_RETRY_AFTER_SECONDS) }
        : undefined,
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleAgentReviewCancellation(
  reviewId: string,
  agent: AuthenticatedAgent,
  config: AiruxConfig,
  dependencies: Omit<AgentReviewDependencies, "stream">,
) {
  try {
    return jsonResponse(
      cancelAgentReviewResponseSchema.parse({
        review: await cancelReview(
          reviewId,
          agent,
          config,
          dependencies.fetcher ?? fetch,
        ),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
