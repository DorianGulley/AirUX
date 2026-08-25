import { timingSafeEqual } from "node:crypto";

import {
  cancelAgentReviewResponseSchema,
  createPlaybackTokenResponseSchema,
  createReviewResponseSchema,
  decideReviewerReviewResponseSchema,
  getReviewerReviewResponseSchema,
} from "@airux/shared/v1";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { hashAgentCredentialToken } from "../src/agent-credential-token.js";
import worker from "../src/index.js";
import { TEST_ENV } from "./fixtures.js";

const REVIEWER_A_ID = "00000000-0000-4000-8000-000000000001";
const REVIEWER_B_ID = "00000000-0000-4000-8000-000000000002";
const CREDENTIAL_A_ID = "10000000-0000-4000-8000-000000000001";
const CREDENTIAL_B_ID = "10000000-0000-4000-8000-000000000002";
const PENDING_REVIEW_A_ID = "20000000-0000-4000-8000-000000000001";
const PENDING_REVIEW_B_ID = "20000000-0000-4000-8000-000000000002";
const CREATED_REVIEW_ID = "20000000-0000-4000-8000-000000000003";
const MISSING_REVIEW_ID = "20000000-0000-4000-8000-000000000099";
const PENDING_EVIDENCE_A_ID = "30000000-0000-4000-8000-000000000001";
const PENDING_EVIDENCE_B_ID = "30000000-0000-4000-8000-000000000002";
const CREATED_EVIDENCE_ID = "30000000-0000-4000-8000-000000000003";
const DECISION_ID = "40000000-0000-4000-8000-000000000001";
const REVIEWER_A_TOKEN = "reviewer-a.payload.signature";
const AGENT_A_TOKEN = `airux_agent_v1.${CREDENTIAL_A_ID}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const CREATED_AT = "2026-08-20T08:00:00.000Z";
const SUBMITTED_AT = "2026-08-20T08:01:00.000Z";
const EXPIRES_AT = "2026-08-23T08:01:00.000Z";
const RESOLVED_AT = "2026-08-20T08:02:00.000Z";
let streamSigningJwk = "";

const CREATE_BODY = {
  client_request_id: "contract-agent-run",
  title: "Review the responsive layout",
  claim: "The navigation works at mobile width.",
  criteria: [{ id: "layout", prompt: "The navigation remains visible." }],
  evidence: {
    kind: "browser_video",
    media_type: "video/webm",
    size_bytes: 1_024,
  },
};

interface StoredReview {
  readonly id: string;
  readonly user_id: string;
  readonly agent_credential_id: string;
  readonly client_request_id: string;
  readonly title: string;
  readonly claim: string;
  readonly criteria: typeof CREATE_BODY.criteria;
  status: "draft" | "pending" | "approved" | "changes_requested" | "cancelled";
  version: number;
  readonly created_at: string;
  readonly submitted_at: string | null;
  readonly expires_at: string;
  resolved_at: string | null;
  deleted_at: string | null;
}

interface StoredEvidence {
  readonly id: string;
  readonly review_id: string;
  readonly kind: "browser_video";
  status: "awaiting_upload" | "ready" | "deleting";
  stream_video_id: string | null;
  readonly media_type: "video/webm";
  readonly size_bytes: number;
  readonly duration_ms: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly failure_code: null;
  delete_after: string;
}

interface StoredDecision {
  readonly id: string;
  readonly review_id: string;
  readonly user_id: string;
  readonly outcome: "approved" | "changes_requested";
  readonly comment: string | null;
  readonly created_at: string;
}

function installTimingSafeEqual() {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value: (left: ArrayBufferView, right: ArrayBufferView) =>
      timingSafeEqual(
        Buffer.from(left.buffer, left.byteOffset, left.byteLength),
        Buffer.from(right.buffer, right.byteOffset, right.byteLength),
      ),
  });
}

function removeTimingSafeEqual() {
  Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
}

function pendingReview(
  id: string,
  userId: string,
  credentialId: string,
): StoredReview {
  return {
    id,
    user_id: userId,
    agent_credential_id: credentialId,
    client_request_id: `pending-${id}`,
    title: CREATE_BODY.title,
    claim: CREATE_BODY.claim,
    criteria: CREATE_BODY.criteria,
    status: "pending",
    version: 1,
    created_at: CREATED_AT,
    submitted_at: SUBMITTED_AT,
    expires_at: EXPIRES_AT,
    resolved_at: null,
    deleted_at: null,
  };
}

function pendingEvidence(id: string, reviewId: string): StoredEvidence {
  return {
    id,
    review_id: reviewId,
    kind: "browser_video",
    status: "ready",
    stream_video_id: `private-stream-${id}`,
    media_type: "video/webm",
    size_bytes: 1_024,
    duration_ms: 15_000,
    width: 1_280,
    height: 720,
    failure_code: null,
    delete_after: EXPIRES_AT,
  };
}

function equalFilter(url: URL, name: string) {
  return url.searchParams.get(name)?.replace(/^eq\./, "");
}

async function installContractBackend() {
  const credentialHashes = new Map([
    [CREDENTIAL_A_ID, await hashAgentCredentialToken(AGENT_A_TOKEN)],
  ]);
  const credentialOwners = new Map([
    [CREDENTIAL_A_ID, REVIEWER_A_ID],
    [CREDENTIAL_B_ID, REVIEWER_B_ID],
  ]);
  const reviews: StoredReview[] = [
    pendingReview(PENDING_REVIEW_A_ID, REVIEWER_A_ID, CREDENTIAL_A_ID),
    pendingReview(PENDING_REVIEW_B_ID, REVIEWER_B_ID, CREDENTIAL_B_ID),
  ];
  const evidence: StoredEvidence[] = [
    pendingEvidence(PENDING_EVIDENCE_A_ID, PENDING_REVIEW_A_ID),
    pendingEvidence(PENDING_EVIDENCE_B_ID, PENDING_REVIEW_B_ID),
  ];
  const decisions: StoredDecision[] = [];
  const deletedStreamIds: string[] = [];
  let streamSequence = 0;

  const createDirectUpload = vi.fn(async () => {
    streamSequence += 1;
    return {
      id: `stream-slot-${streamSequence}`,
      uploadURL: `https://upload.videodelivery.net/token-${streamSequence}`,
    };
  });
  const deleteVideo = vi.fn(async (id: string) => {
    deletedStreamIds.push(id);
  });
  const stream = {
    createDirectUpload,
    video: (id: string) => ({
      delete: () => deleteVideo(id),
      details: async () => ({
        id,
        readyToStream: true,
        requireSignedURLs: true,
        hlsPlaybackUrl: `https://customer-example.cloudflarestream.com/${id}/manifest/video.m3u8`,
      }),
    }),
  } as StreamBinding;

  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const body =
        init?.body === undefined ? null : JSON.parse(String(init.body));

      if (url.pathname === "/auth/v1/user") {
        const authorization = new Headers(init?.headers).get("authorization");
        const userId =
          authorization === `Bearer ${REVIEWER_A_TOKEN}` ? REVIEWER_A_ID : null;
        return userId === null
          ? new Response(null, { status: 401 })
          : Response.json({
              id: userId,
              app_metadata: { provider: "github", providers: ["github"] },
            });
      }

      if (url.pathname === "/rest/v1/agent_credentials") {
        const credentialId = equalFilter(url, "id");
        const userId = credentialOwners.get(credentialId ?? "");
        const secretHash = credentialHashes.get(credentialId ?? "");
        return Response.json(
          credentialId === undefined ||
            userId === undefined ||
            secretHash === undefined
            ? []
            : [{ id: credentialId, user_id: userId, secret_hash: secretHash }],
        );
      }

      if (url.pathname === "/rest/v1/rpc/create_agent_review") {
        const existing = reviews.find(
          (review) =>
            review.agent_credential_id === body.p_agent_credential_id &&
            review.client_request_id === body.p_client_request_id,
        );
        if (existing !== undefined) {
          const existingEvidence = evidence.find(
            (item) => item.review_id === existing.id,
          );
          const samePayload =
            existing.title === body.p_title &&
            existing.claim === body.p_claim &&
            JSON.stringify(existing.criteria) ===
              JSON.stringify(body.p_criteria) &&
            existingEvidence?.kind === body.p_evidence_kind &&
            existingEvidence.media_type === body.p_media_type &&
            existingEvidence.size_bytes === body.p_size_bytes;
          return samePayload
            ? Response.json([
                {
                  review_id: existing.id,
                  evidence_id: existingEvidence.id,
                  status: existing.status,
                  stream_video_id: existingEvidence.stream_video_id,
                  created: false,
                },
              ])
            : Response.json(
                { code: "P0001", message: "client request payload conflict" },
                { status: 400 },
              );
        }

        const review: StoredReview = {
          id: CREATED_REVIEW_ID,
          user_id: body.p_user_id,
          agent_credential_id: body.p_agent_credential_id,
          client_request_id: body.p_client_request_id,
          title: body.p_title,
          claim: body.p_claim,
          criteria: body.p_criteria,
          status: "draft",
          version: 0,
          created_at: CREATED_AT,
          submitted_at: null,
          expires_at: body.p_expires_at,
          resolved_at: null,
          deleted_at: null,
        };
        const item: StoredEvidence = {
          id: CREATED_EVIDENCE_ID,
          review_id: review.id,
          kind: body.p_evidence_kind,
          status: "awaiting_upload",
          stream_video_id: null,
          media_type: body.p_media_type,
          size_bytes: body.p_size_bytes,
          duration_ms: null,
          width: null,
          height: null,
          failure_code: null,
          delete_after: body.p_delete_after,
        };
        reviews.push(review);
        evidence.push(item);
        return Response.json([
          {
            review_id: review.id,
            evidence_id: item.id,
            status: review.status,
            stream_video_id: null,
            created: true,
          },
        ]);
      }

      if (url.pathname === "/rest/v1/rpc/replace_agent_review_upload") {
        const review = reviews.find(
          (item) =>
            item.id === body.p_review_id &&
            item.user_id === body.p_user_id &&
            item.agent_credential_id === body.p_agent_credential_id &&
            item.status === "draft",
        );
        const item = evidence.find(
          (candidate) =>
            candidate.id === body.p_evidence_id &&
            candidate.review_id === review?.id,
        );
        if (item === undefined) {
          return Response.json([]);
        }
        const previous = item.stream_video_id;
        item.stream_video_id = body.p_stream_video_id;
        return Response.json([
          { evidence_id: item.id, previous_stream_video_id: previous },
        ]);
      }

      if (url.pathname === "/rest/v1/rpc/cancel_agent_review") {
        const review = reviews.find(
          (item) =>
            item.id === body.p_review_id &&
            item.user_id === body.p_user_id &&
            item.agent_credential_id === body.p_agent_credential_id &&
            item.deleted_at === null,
        );
        if (review === undefined) {
          return Response.json([]);
        }
        if (review.status === "cancelled") {
          return Response.json([
            {
              review_id: review.id,
              status: review.status,
              version: review.version,
            },
          ]);
        }
        if (review.status !== "draft" && review.status !== "pending") {
          return Response.json(
            { code: "P0001", message: "review cannot be cancelled" },
            { status: 400 },
          );
        }
        review.status = "cancelled";
        review.version += 1;
        review.resolved_at = RESOLVED_AT;
        const item = evidence.find(
          (candidate) => candidate.review_id === review.id,
        );
        if (item === undefined) {
          return new Response(null, { status: 500 });
        }
        item.status = "deleting";
        item.delete_after = RESOLVED_AT;
        return Response.json([
          {
            review_id: review.id,
            status: review.status,
            version: review.version,
          },
        ]);
      }

      if (url.pathname === "/rest/v1/rpc/decide_reviewer_review") {
        const review = reviews.find(
          (item) =>
            item.id === body.p_review_id &&
            item.user_id === body.p_user_id &&
            item.deleted_at === null,
        );
        if (review === undefined) {
          return Response.json([]);
        }
        if (
          review.status !== "pending" ||
          review.version !== body.p_expected_version
        ) {
          return Response.json(
            { code: "P0001", message: "review decision conflict" },
            { status: 400 },
          );
        }
        const item = evidence.find(
          (candidate) => candidate.review_id === review.id,
        );
        if (item === undefined) {
          return new Response(null, { status: 500 });
        }
        const decision: StoredDecision = {
          id: DECISION_ID,
          review_id: review.id,
          user_id: review.user_id,
          outcome: body.p_outcome,
          comment: body.p_comment,
          created_at: RESOLVED_AT,
        };
        decisions.push(decision);
        review.status = decision.outcome;
        review.version += 1;
        review.resolved_at = RESOLVED_AT;
        return Response.json([
          {
            review_id: review.id,
            user_id: review.user_id,
            title: review.title,
            claim: review.claim,
            criteria: review.criteria,
            status: review.status,
            version: review.version,
            created_at: review.created_at,
            submitted_at: review.submitted_at,
            expires_at: review.expires_at,
            resolved_at: review.resolved_at,
            evidence_id: item.id,
            evidence_review_id: item.review_id,
            evidence_kind: item.kind,
            evidence_status: item.status,
            media_type: item.media_type,
            size_bytes: item.size_bytes,
            duration_ms: item.duration_ms,
            width: item.width,
            height: item.height,
            failure_code: item.failure_code,
            decision_id: decision.id,
            decision_user_id: decision.user_id,
            outcome: decision.outcome,
            comment: decision.comment,
            decision_created_at: decision.created_at,
          },
        ]);
      }

      if (url.pathname === "/rest/v1/rpc/delete_reviewer_review") {
        const review = reviews.find(
          (item) =>
            item.id === body.p_review_id && item.user_id === body.p_user_id,
        );
        if (review === undefined) {
          return Response.json([]);
        }
        const item = evidence.find(
          (candidate) => candidate.review_id === review.id,
        );
        if (item === undefined) {
          return new Response(null, { status: 500 });
        }
        if (
          review.deleted_at === null &&
          (review.status === "draft" || review.status === "pending")
        ) {
          review.status = "cancelled";
          review.version += 1;
          review.resolved_at = RESOLVED_AT;
        }
        review.deleted_at ??= RESOLVED_AT;
        item.status = "deleting";
        item.delete_after = RESOLVED_AT;
        return Response.json([
          {
            review_id: review.id,
            review_status: review.status,
            review_version: review.version,
            review_deleted_at: review.deleted_at,
            evidence_id: item.id,
            evidence_status: item.status,
            evidence_delete_after: item.delete_after,
          },
        ]);
      }

      if (url.pathname === "/rest/v1/reviews") {
        const reviewId = equalFilter(url, "id");
        const userId = equalFilter(url, "user_id");
        const credentialId = equalFilter(url, "agent_credential_id");
        return Response.json(
          reviews.filter(
            (review) =>
              (reviewId === undefined || review.id === reviewId) &&
              (userId === undefined || review.user_id === userId) &&
              (credentialId === undefined ||
                review.agent_credential_id === credentialId) &&
              review.deleted_at === null &&
              (url.searchParams.get("status") !== "in.(draft,pending)" ||
                review.status === "draft" ||
                review.status === "pending"),
          ),
        );
      }

      if (url.pathname === "/rest/v1/evidence") {
        const evidenceId = equalFilter(url, "id");
        const reviewId = equalFilter(url, "review_id");
        return Response.json(
          evidence.filter(
            (item) =>
              (evidenceId === undefined || item.id === evidenceId) &&
              (reviewId === undefined || item.review_id === reviewId),
          ),
        );
      }

      if (url.pathname === "/rest/v1/decisions") {
        const reviewId = equalFilter(url, "review_id");
        const userId = equalFilter(url, "user_id");
        return Response.json(
          decisions.filter(
            (decision) =>
              decision.review_id === reviewId &&
              (userId === undefined || decision.user_id === userId),
          ),
        );
      }

      return new Response(null, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", fetcher);

  return {
    env: {
      ...TEST_ENV,
      STREAM: stream,
      STREAM_SIGNING_JWK: streamSigningJwk,
    },
    reviews,
    evidence,
    decisions,
    deletedStreamIds,
    createDirectUpload,
  };
}

function agentRequest(
  path: string,
  token: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
) {
  return new Request(`https://airux.app${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function reviewerRequest(
  path: string,
  token: string,
  method: "GET" | "POST" | "DELETE" = "GET",
  body?: unknown,
) {
  return agentRequest(path, token, method, body);
}

beforeAll(async () => {
  installTimingSafeEqual();
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  streamSigningJwk = btoa(
    JSON.stringify(await crypto.subtle.exportKey("jwk", keys.privateKey)),
  );
});
afterAll(removeTimingSafeEqual);
afterEach(() => vi.unstubAllGlobals());

describe("Review API contracts", () => {
  it("rejects invalid agent and reviewer payloads before mutating state", async () => {
    const backend = await installContractBackend();

    const invalidCreate = await worker.fetch(
      agentRequest("/api/v1/agent/reviews", AGENT_A_TOKEN, "POST", {
        ...CREATE_BODY,
        unexpected: true,
      }),
      backend.env,
    );
    const invalidDecision = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}/decision`,
        REVIEWER_A_TOKEN,
        "POST",
        { expected_version: 1, outcome: "changes_requested" },
      ),
      backend.env,
    );

    expect(invalidCreate.status).toBe(400);
    expect(invalidDecision.status).toBe(400);
    expect(backend.reviews).toHaveLength(2);
    expect(backend.decisions).toHaveLength(0);
    expect(backend.createDirectUpload).not.toHaveBeenCalled();
  });

  it("keeps reviewer and agent authentication mechanisms separate", async () => {
    const backend = await installContractBackend();
    const agentOnReviewerRoute = await worker.fetch(
      agentRequest(`/api/v1/reviews/${PENDING_REVIEW_A_ID}`, AGENT_A_TOKEN),
      backend.env,
    );
    const reviewerOnAgentRoute = await worker.fetch(
      reviewerRequest(
        `/api/v1/agent/reviews/${PENDING_REVIEW_A_ID}`,
        REVIEWER_A_TOKEN,
      ),
      backend.env,
    );

    expect(agentOnReviewerRoute.status).toBe(401);
    expect(reviewerOnAgentRoute.status).toBe(401);
  });

  it("makes foreign Reviews indistinguishable from missing Reviews", async () => {
    const backend = await installContractBackend();
    const agentForeign = await worker.fetch(
      agentRequest(
        `/api/v1/agent/reviews/${PENDING_REVIEW_B_ID}`,
        AGENT_A_TOKEN,
      ),
      backend.env,
    );
    const agentMissing = await worker.fetch(
      agentRequest(`/api/v1/agent/reviews/${MISSING_REVIEW_ID}`, AGENT_A_TOKEN),
      backend.env,
    );
    const agentForeignCancellation = await worker.fetch(
      agentRequest(
        `/api/v1/agent/reviews/${PENDING_REVIEW_B_ID}/cancel`,
        AGENT_A_TOKEN,
        "POST",
      ),
      backend.env,
    );
    const agentMissingCancellation = await worker.fetch(
      agentRequest(
        `/api/v1/agent/reviews/${MISSING_REVIEW_ID}/cancel`,
        AGENT_A_TOKEN,
        "POST",
      ),
      backend.env,
    );
    const reviewerForeign = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_B_ID}`,
        REVIEWER_A_TOKEN,
      ),
      backend.env,
    );
    const reviewerMissing = await worker.fetch(
      reviewerRequest(`/api/v1/reviews/${MISSING_REVIEW_ID}`, REVIEWER_A_TOKEN),
      backend.env,
    );
    const reviewerForeignPlayback = await worker.fetch(
      reviewerRequest(
        `/api/v1/evidence/${PENDING_EVIDENCE_B_ID}/playback-token`,
        REVIEWER_A_TOKEN,
        "POST",
      ),
      backend.env,
    );
    const reviewerMissingPlayback = await worker.fetch(
      reviewerRequest(
        `/api/v1/evidence/30000000-0000-4000-8000-000000000099/playback-token`,
        REVIEWER_A_TOKEN,
        "POST",
      ),
      backend.env,
    );
    const foreignDecision = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_B_ID}/decision`,
        REVIEWER_A_TOKEN,
        "POST",
        { expected_version: 1, outcome: "approved" },
      ),
      backend.env,
    );
    const reviewerForeignDeletion = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_B_ID}`,
        REVIEWER_A_TOKEN,
        "DELETE",
      ),
      backend.env,
    );
    const reviewerMissingDeletion = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${MISSING_REVIEW_ID}`,
        REVIEWER_A_TOKEN,
        "DELETE",
      ),
      backend.env,
    );

    expect(agentForeign.status).toBe(404);
    expect(agentMissing.status).toBe(404);
    expect(await agentForeign.text()).toBe(await agentMissing.text());
    expect(agentForeignCancellation.status).toBe(404);
    expect(agentMissingCancellation.status).toBe(404);
    expect(await agentForeignCancellation.text()).toBe(
      await agentMissingCancellation.text(),
    );
    expect(reviewerForeign.status).toBe(404);
    expect(reviewerMissing.status).toBe(404);
    expect(await reviewerForeign.text()).toBe(await reviewerMissing.text());
    expect(reviewerForeignPlayback.status).toBe(404);
    expect(reviewerMissingPlayback.status).toBe(404);
    expect(await reviewerForeignPlayback.text()).toBe(
      await reviewerMissingPlayback.text(),
    );
    expect(foreignDecision.status).toBe(404);
    expect(reviewerForeignDeletion.status).toBe(404);
    expect(reviewerMissingDeletion.status).toBe(404);
    expect(await reviewerForeignDeletion.text()).toBe(
      await reviewerMissingDeletion.text(),
    );
    expect(backend.decisions).toHaveLength(0);
  });

  it("issues private playback only to the Review owner", async () => {
    const backend = await installContractBackend();
    const response = await worker.fetch(
      reviewerRequest(
        `/api/v1/evidence/${PENDING_EVIDENCE_A_ID}/playback-token`,
        REVIEWER_A_TOKEN,
        "POST",
      ),
      backend.env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = createPlaybackTokenResponseSchema.parse(await response.json());
    expect(body.playback.expires_at).toMatch(/Z$/);
    expect(body.playback.player_url).toContain(body.playback.token);
    expect(JSON.stringify(body)).not.toContain(PENDING_REVIEW_A_ID);
    expect(JSON.stringify(body)).not.toContain(PENDING_EVIDENCE_A_ID);
    expect(JSON.stringify(body)).not.toContain(REVIEWER_A_ID);
  });

  it("preserves creation and cancellation idempotency through the Worker", async () => {
    const backend = await installContractBackend();
    const first = await worker.fetch(
      agentRequest("/api/v1/agent/reviews", AGENT_A_TOKEN, "POST", CREATE_BODY),
      backend.env,
    );
    const firstBody = createReviewResponseSchema.parse(await first.json());
    const retry = await worker.fetch(
      agentRequest("/api/v1/agent/reviews", AGENT_A_TOKEN, "POST", CREATE_BODY),
      backend.env,
    );
    const retryBody = createReviewResponseSchema.parse(await retry.json());

    expect(first.status).toBe(201);
    expect(retry.status).toBe(200);
    expect(retryBody.review_id).toBe(firstBody.review_id);
    expect(retryBody.evidence_id).toBe(firstBody.evidence_id);
    expect(retryBody.upload_url).not.toBe(firstBody.upload_url);
    expect(backend.reviews).toHaveLength(3);
    expect(backend.deletedStreamIds).toEqual(["stream-slot-1"]);

    const payloadConflict = await worker.fetch(
      agentRequest("/api/v1/agent/reviews", AGENT_A_TOKEN, "POST", {
        ...CREATE_BODY,
        claim: "A different claim must not reuse this key.",
      }),
      backend.env,
    );
    expect(payloadConflict.status).toBe(409);
    expect(backend.createDirectUpload).toHaveBeenCalledTimes(2);

    const firstCancellation = await worker.fetch(
      agentRequest(
        `/api/v1/agent/reviews/${CREATED_REVIEW_ID}/cancel`,
        AGENT_A_TOKEN,
        "POST",
      ),
      backend.env,
    );
    const cancelled = cancelAgentReviewResponseSchema.parse(
      await firstCancellation.json(),
    );
    const cancellationRetry = await worker.fetch(
      agentRequest(
        `/api/v1/agent/reviews/${CREATED_REVIEW_ID}/cancel`,
        AGENT_A_TOKEN,
        "POST",
      ),
      backend.env,
    );
    const cancelledAgain = cancelAgentReviewResponseSchema.parse(
      await cancellationRetry.json(),
    );

    expect(firstCancellation.status).toBe(200);
    expect(cancellationRetry.status).toBe(200);
    expect(cancelled.review.status).toBe("cancelled");
    expect(cancelled.review.evidence.status).toBe("deleting");
    expect(cancelledAgain.review.version).toBe(cancelled.review.version);
    expect(cancelledAgain.review.evidence.status).toBe("deleting");
    expect(
      backend.evidence.find((item) => item.id === CREATED_EVIDENCE_ID)
        ?.delete_after,
    ).toBe(RESOLVED_AT);
  });

  it("immediately revokes access and idempotently schedules evidence cleanup", async () => {
    const backend = await installContractBackend();
    const firstDeletion = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}`,
        REVIEWER_A_TOKEN,
        "DELETE",
      ),
      backend.env,
    );
    const deletionRetry = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}`,
        REVIEWER_A_TOKEN,
        "DELETE",
      ),
      backend.env,
    );

    expect(firstDeletion.status).toBe(204);
    expect(deletionRetry.status).toBe(204);
    expect(firstDeletion.headers.get("cache-control")).toBe("no-store");
    const review = backend.reviews.find(
      (item) => item.id === PENDING_REVIEW_A_ID,
    );
    expect(review).toMatchObject({
      status: "cancelled",
      version: 2,
      resolved_at: RESOLVED_AT,
      deleted_at: RESOLVED_AT,
    });
    expect(
      backend.evidence.find((item) => item.id === PENDING_EVIDENCE_A_ID),
    ).toMatchObject({ status: "deleting", delete_after: RESOLVED_AT });

    const reviewerDetail = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}`,
        REVIEWER_A_TOKEN,
      ),
      backend.env,
    );
    const playback = await worker.fetch(
      reviewerRequest(
        `/api/v1/evidence/${PENDING_EVIDENCE_A_ID}/playback-token`,
        REVIEWER_A_TOKEN,
        "POST",
      ),
      backend.env,
    );
    const decision = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}/decision`,
        REVIEWER_A_TOKEN,
        "POST",
        { expected_version: 2, outcome: "approved" },
      ),
      backend.env,
    );
    const agentDetail = await worker.fetch(
      agentRequest(
        `/api/v1/agent/reviews/${PENDING_REVIEW_A_ID}`,
        AGENT_A_TOKEN,
      ),
      backend.env,
    );

    expect(reviewerDetail.status).toBe(404);
    expect(playback.status).toBe(404);
    expect(decision.status).toBe(404);
    expect(agentDetail.status).toBe(404);
    expect(backend.decisions).toHaveLength(0);
  });

  it("allows exactly one version-checked terminal Decision", async () => {
    const backend = await installContractBackend();
    const reviewerDetail = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}`,
        REVIEWER_A_TOKEN,
      ),
      backend.env,
    );
    const pending = getReviewerReviewResponseSchema.parse(
      await reviewerDetail.json(),
    );
    const approval = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}/decision`,
        REVIEWER_A_TOKEN,
        "POST",
        { expected_version: pending.review.version, outcome: "approved" },
      ),
      backend.env,
    );
    const approved = decideReviewerReviewResponseSchema.parse(
      await approval.json(),
    );
    const repeated = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}/decision`,
        REVIEWER_A_TOKEN,
        "POST",
        { expected_version: pending.review.version, outcome: "approved" },
      ),
      backend.env,
    );
    const alternate = await worker.fetch(
      reviewerRequest(
        `/api/v1/reviews/${PENDING_REVIEW_A_ID}/decision`,
        REVIEWER_A_TOKEN,
        "POST",
        {
          expected_version: approved.review.version,
          outcome: "changes_requested",
          comment: "A later outcome must not replace the first.",
        },
      ),
      backend.env,
    );

    expect(approval.status).toBe(200);
    expect(approved.review.status).toBe("approved");
    expect(approved.review.version).toBe(pending.review.version + 1);
    expect(repeated.status).toBe(409);
    expect(alternate.status).toBe(409);
    expect(backend.decisions).toEqual([
      expect.objectContaining({
        review_id: PENDING_REVIEW_A_ID,
        outcome: "approved",
      }),
    ]);
    expect(JSON.stringify(approved)).not.toContain(REVIEWER_A_ID);
    expect(JSON.stringify(approved)).not.toContain("private-stream");
  });
});
