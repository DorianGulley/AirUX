import {
  type DecisionRequest,
  decideReviewerReviewResponseSchema,
  decisionRequestSchema,
  getReviewerReviewResponseSchema,
  type ReviewerReview,
  reviewerReviewSchema,
} from "@airux/shared/v1";

import { jsonResponse } from "./api-response.js";
import {
  InvalidJsonBodyError,
  readJsonRequest,
  readJsonResponse,
} from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";
import type { AuthenticatedReviewer } from "./reviewer-auth.js";

const DATA_RESPONSE_LIMIT = 1024 * 1024;
const DATA_ERROR_RESPONSE_LIMIT = 16 * 1024;
const REQUEST_BODY_LIMIT = 8 * 1024;
const RPC_ERROR_CODE = "P0001";
const DECISION_CONFLICT_MESSAGE = "review decision conflict";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

class ReviewerReviewNotFoundError extends Error {}
class ReviewerReviewConflictError extends Error {}
class ReviewerReviewServiceError extends Error {}

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
    throw new ReviewerReviewServiceError();
  }
}

async function readRows(response: Response) {
  let body: unknown;
  try {
    body = await readJsonResponse(response, DATA_RESPONSE_LIMIT);
  } catch {
    throw new ReviewerReviewServiceError();
  }
  if (!Array.isArray(body)) {
    throw new ReviewerReviewServiceError();
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

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
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

function normalizeReview(
  reviewValue: unknown,
  evidenceValue: unknown,
  decisionValue: unknown,
  reviewer: AuthenticatedReviewer,
): ReviewerReview | null {
  const review = asRecord(reviewValue);
  const evidence = asRecord(evidenceValue);
  const decision = decisionValue === null ? null : asRecord(decisionValue);
  if (
    review === null ||
    evidence === null ||
    (decisionValue !== null && decision === null) ||
    review.user_id !== reviewer.id ||
    typeof review.id !== "string" ||
    evidence.review_id !== review.id ||
    (decision !== null &&
      (decision.review_id !== review.id || decision.user_id !== reviewer.id))
  ) {
    return null;
  }

  const parsed = reviewerReviewSchema.safeParse({
    id: review.id,
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
      duration_ms: evidence.duration_ms,
      width: evidence.width,
      height: evidence.height,
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

async function getSingleRow(url: URL, config: AiruxConfig, fetcher: Fetcher) {
  const response = await fetchData(
    url,
    { method: "GET", headers: dataApiHeaders(config) },
    fetcher,
  );
  if (!response.ok) {
    throw new ReviewerReviewServiceError();
  }
  const rows = await readRows(response);
  if (rows.length > 1) {
    throw new ReviewerReviewServiceError();
  }
  return rows[0] ?? null;
}

async function getReview(
  reviewId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  if (!UUID_PATTERN.test(reviewId)) {
    throw new ReviewerReviewNotFoundError();
  }

  const reviewUrl = dataApiUrl(config, "reviews");
  reviewUrl.searchParams.set(
    "select",
    "id,user_id,title,claim,criteria,status,version,created_at,submitted_at,expires_at,resolved_at",
  );
  reviewUrl.searchParams.set("id", `eq.${reviewId}`);
  reviewUrl.searchParams.set("user_id", `eq.${reviewer.id}`);
  reviewUrl.searchParams.set("deleted_at", "is.null");
  reviewUrl.searchParams.set("limit", "1");
  const review = await getSingleRow(reviewUrl, config, fetcher);
  if (review === null) {
    throw new ReviewerReviewNotFoundError();
  }

  const evidenceUrl = dataApiUrl(config, "evidence");
  evidenceUrl.searchParams.set(
    "select",
    "id,review_id,kind,status,media_type,size_bytes,duration_ms,width,height,failure_code",
  );
  evidenceUrl.searchParams.set("review_id", `eq.${reviewId}`);
  evidenceUrl.searchParams.set("limit", "1");

  const decisionUrl = dataApiUrl(config, "decisions");
  decisionUrl.searchParams.set(
    "select",
    "review_id,user_id,outcome,comment,created_at",
  );
  decisionUrl.searchParams.set("review_id", `eq.${reviewId}`);
  decisionUrl.searchParams.set("user_id", `eq.${reviewer.id}`);
  decisionUrl.searchParams.set("limit", "1");

  const [evidence, decision] = await Promise.all([
    getSingleRow(evidenceUrl, config, fetcher),
    getSingleRow(decisionUrl, config, fetcher),
  ]);
  if (evidence === null) {
    throw new ReviewerReviewServiceError();
  }
  const normalized = normalizeReview(review, evidence, decision, reviewer);
  if (normalized === null) {
    throw new ReviewerReviewServiceError();
  }
  return normalized;
}

function normalizeDecisionResult(
  value: unknown,
  reviewId: string,
  decision: DecisionRequest,
  reviewer: AuthenticatedReviewer,
) {
  const row = asRecord(value);
  const submittedAt = normalizeTimestamp(row?.submitted_at);
  const resolvedAt = normalizeTimestamp(row?.resolved_at);
  const decisionCreatedAt = normalizeTimestamp(row?.decision_created_at);
  const expectedComment = decision.comment ?? null;
  if (
    row === null ||
    row.review_id !== reviewId ||
    row.status !== decision.outcome ||
    row.version !== decision.expected_version + 1 ||
    submittedAt === null ||
    resolvedAt === null ||
    typeof row.decision_id !== "string" ||
    !UUID_PATTERN.test(row.decision_id) ||
    row.outcome !== decision.outcome ||
    row.comment !== expectedComment ||
    decisionCreatedAt === null
  ) {
    throw new ReviewerReviewServiceError();
  }

  const normalized = normalizeReview(
    {
      id: row.review_id,
      user_id: row.user_id,
      title: row.title,
      claim: row.claim,
      criteria: row.criteria,
      status: row.status,
      version: row.version,
      created_at: row.created_at,
      submitted_at: row.submitted_at,
      expires_at: row.expires_at,
      resolved_at: row.resolved_at,
    },
    {
      id: row.evidence_id,
      review_id: row.evidence_review_id,
      kind: row.evidence_kind,
      status: row.evidence_status,
      media_type: row.media_type,
      size_bytes: row.size_bytes,
      duration_ms: row.duration_ms,
      width: row.width,
      height: row.height,
      failure_code: row.failure_code,
    },
    {
      review_id: row.review_id,
      user_id: row.decision_user_id,
      outcome: row.outcome,
      comment: row.comment,
      created_at: row.decision_created_at,
    },
    reviewer,
  );
  if (normalized === null) {
    throw new ReviewerReviewServiceError();
  }
  return normalized;
}

async function writeDecision(
  request: Request,
  reviewId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  if (!UUID_PATTERN.test(reviewId)) {
    throw new ReviewerReviewNotFoundError();
  }
  const parsedRequest = decisionRequestSchema.safeParse(
    await readJsonRequest(request, REQUEST_BODY_LIMIT),
  );
  if (!parsedRequest.success) {
    throw new InvalidJsonBodyError();
  }

  const response = await fetchData(
    dataApiUrl(config, "rpc/decide_reviewer_review"),
    {
      method: "POST",
      headers: dataApiHeaders(config),
      body: JSON.stringify({
        p_review_id: reviewId,
        p_user_id: reviewer.id,
        p_expected_version: parsedRequest.data.expected_version,
        p_outcome: parsedRequest.data.outcome,
        p_comment: parsedRequest.data.comment ?? null,
      }),
    },
    fetcher,
  );
  if (!response.ok) {
    const message = await readRpcErrorMessage(response);
    if (message === DECISION_CONFLICT_MESSAGE) {
      throw new ReviewerReviewConflictError();
    }
    throw new ReviewerReviewServiceError();
  }
  const rows = await readRows(response);
  if (rows.length === 0) {
    throw new ReviewerReviewNotFoundError();
  }
  if (rows.length !== 1) {
    throw new ReviewerReviewServiceError();
  }
  return normalizeDecisionResult(
    rows[0],
    reviewId,
    parsedRequest.data,
    reviewer,
  );
}

function errorResponse(error: unknown) {
  if (error instanceof InvalidJsonBodyError) {
    return jsonResponse(
      { error: { code: "invalid_request", message: "Invalid request" } },
      400,
    );
  }
  if (error instanceof ReviewerReviewNotFoundError) {
    return jsonResponse(
      { error: { code: "not_found", message: "Not found" } },
      404,
    );
  }
  if (error instanceof ReviewerReviewConflictError) {
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

export async function handleReviewerReviewGet(
  reviewId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher = fetch,
) {
  try {
    return jsonResponse(
      getReviewerReviewResponseSchema.parse({
        review: await getReview(reviewId, reviewer, config, fetcher),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleReviewerReviewDecision(
  request: Request,
  reviewId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher = fetch,
) {
  try {
    return jsonResponse(
      decideReviewerReviewResponseSchema.parse({
        review: await writeDecision(
          request,
          reviewId,
          reviewer,
          config,
          fetcher,
        ),
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
