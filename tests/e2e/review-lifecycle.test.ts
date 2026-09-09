import { execFileSync } from "node:child_process";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createAgentCredential } from "../../apps/web/src/credential-api.js";
import {
  getReviewerReview,
  submitReviewDecision,
} from "../../apps/web/src/review-api.js";
import worker from "../../apps/worker/src/index.js";
import {
  AiruxApiClient,
  AiruxApiError,
} from "../../packages/mcp/src/api-client.js";
import { TemporaryBrowserRecording } from "../../packages/mcp/src/browser-recording.js";
import {
  CreateReviewWorkflowError,
  createAiruxReview,
} from "../../packages/mcp/src/create-review.js";
import { getAiruxReview } from "../../packages/mcp/src/get-review.js";
import { listAiruxOpenReviews } from "../../packages/mcp/src/list-open-reviews.js";

const APP_ORIGIN = "http://127.0.0.1:8787";
const WEBHOOK_SECRET = "local-e2e-stream-webhook-secret";

interface LocalSupabaseStatus {
  readonly API_URL: string;
  readonly JWT_SECRET: string;
  readonly PUBLISHABLE_KEY: string;
  readonly SECRET_KEY: string;
}

interface TestContext {
  readonly agentApi: AiruxApiClient;
  readonly agentToken: string;
  readonly reviewerToken: string;
}

let localSupabase: LocalSupabaseStatus;
let env: Env;
let streamSequence = 0;
const createdReviewerIds = new Set<string>();
const createdReviewIds = new Set<string>();
const deletedStreamVideoIds: string[] = [];

function localSupabaseStatus() {
  try {
    return JSON.parse(
      execFileSync("pnpm", ["exec", "supabase", "status", "-o", "json"], {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    ) as LocalSupabaseStatus;
  } catch (error) {
    throw new Error(
      "Local Supabase is unavailable; run pnpm db:start and pnpm db:reset before pnpm test:e2e",
      { cause: error },
    );
  }
}

function adminHeaders() {
  return {
    apikey: localSupabase.SECRET_KEY,
    authorization: `Bearer ${localSupabase.SECRET_KEY}`,
    "content-type": "application/json",
  };
}

function reviewerAccessToken(reviewerId: string) {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    aud: "authenticated",
    exp: now + 3_600,
    iat: now,
    iss: "supabase-demo",
    role: "authenticated",
    sub: reviewerId,
  })}`;
  const signature = createHmac("sha256", localSupabase.JWT_SECRET)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

async function createReviewer() {
  const response = await fetch(`${localSupabase.API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      email: `m7-4-${randomUUID()}@example.test`,
      email_confirm: true,
      app_metadata: { provider: "github", providers: ["github"] },
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { id: string };
  createdReviewerIds.add(body.id);
  return { id: body.id, token: reviewerAccessToken(body.id) };
}

function workerFetch(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), APP_ORIGIN), init);
  return worker.fetch(request, env);
}

async function createTestContext(): Promise<TestContext> {
  const reviewer = await createReviewer();
  const issued = await createAgentCredential(
    "M7-4 lifecycle test",
    reviewer.token,
    workerFetch,
  );
  return {
    agentApi: new AiruxApiClient(
      { apiOrigin: APP_ORIGIN, agentToken: issued.token },
      workerFetch,
    ),
    agentToken: issued.token,
    reviewerToken: reviewer.token,
  };
}

function createRequest(clientRequestId = randomUUID()) {
  return {
    client_request_id: clientRequestId,
    title: "Review the complete AirUX lifecycle",
    claim: "The demonstrated interaction behaves as intended.",
    criteria: [
      { id: "complete", prompt: "The interaction completes successfully." },
    ],
    evidence: {
      kind: "browser_video" as const,
      media_type: "video/webm",
      size_bytes: 5,
    },
  };
}

async function createReview(context: TestContext) {
  const assignment = await context.agentApi.createReview(
    createRequest(),
    new AbortController().signal,
  );
  createdReviewIds.add(assignment.review_id);
  return assignment;
}

async function sendStreamWebhook(
  streamVideoId: string,
  status: "ready" | "error",
) {
  const body = JSON.stringify(
    status === "ready"
      ? {
          uid: streamVideoId,
          readyToStream: true,
          status: { state: "ready" },
          duration: 5,
          input: { width: 1_280, height: 720 },
        }
      : {
          uid: streamVideoId,
          status: { state: "error", errReasonCode: "ERR_TRANSCODE" },
        },
  );
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const signature = createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  const response = await workerFetch("/api/v1/webhooks/cloudflare-stream", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-signature": `time=${timestamp},sig1=${signature}`,
    },
    body,
  });
  expect(response.status).toBe(204);
}

async function updateRows(
  table: "reviews" | "evidence",
  id: string,
  values: Record<string, string>,
) {
  const response = await fetch(
    `${localSupabase.API_URL}/rest/v1/${table}?id=eq.${id}`,
    {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify(values),
    },
  );
  expect(response.status).toBe(204);
}

async function removeTestData() {
  const deleteRows = (table: string, query: string) =>
    fetch(`${localSupabase.API_URL}/rest/v1/${table}?${query}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });

  for (const reviewId of createdReviewIds) {
    await deleteRows("decisions", `review_id=eq.${reviewId}`);
    await deleteRows("evidence", `review_id=eq.${reviewId}`);
    await deleteRows("reviews", `id=eq.${reviewId}`);
  }
  for (const reviewerId of createdReviewerIds) {
    await deleteRows("agent_credentials", `user_id=eq.${reviewerId}`);
    await fetch(`${localSupabase.API_URL}/auth/v1/admin/users/${reviewerId}`, {
      method: "DELETE",
      headers: adminHeaders(),
    });
  }
}

beforeAll(() => {
  localSupabase = localSupabaseStatus();
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value: (left: ArrayBufferView, right: ArrayBufferView) =>
      timingSafeEqual(
        Buffer.from(left.buffer, left.byteOffset, left.byteLength),
        Buffer.from(right.buffer, right.byteOffset, right.byteLength),
      ),
  });
  env = {
    AIRUX_ENVIRONMENT: "local",
    AIRUX_APP_ORIGIN: APP_ORIGIN,
    SUPABASE_URL: localSupabase.API_URL,
    SUPABASE_PUBLISHABLE_KEY: localSupabase.PUBLISHABLE_KEY,
    SUPABASE_SECRET_KEY: localSupabase.SECRET_KEY,
    STREAM_SIGNING_JWK: "eyJrdHkiOiJSU0EifQ==",
    STREAM_SIGNING_KEY_ID: "local-e2e-signing-key",
    STREAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    STREAM: {
      createDirectUpload: async () => {
        streamSequence += 1;
        return {
          id: `e2e-stream-video-${streamSequence}`,
          uploadURL: `https://upload.videodelivery.net/e2e-${streamSequence}`,
        };
      },
      video: (id: string) => ({
        delete: async () => {
          deletedStreamVideoIds.push(id);
        },
      }),
    } as StreamBinding,
    REVIEWER_AUTH_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
    CREDENTIAL_CREATE_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
    AGENT_REVIEW_CREATE_RATE_LIMITER: {
      limit: async () => ({ success: true }),
    },
  };
});

afterAll(async () => {
  await removeTestData();
  Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
});

describe("MVP review lifecycle", () => {
  it("authenticates both clients, resumes an open Review, records one Decision, and deletes it", async () => {
    const context = await createTestContext();
    const assignment = await createReview(context);
    await sendStreamWebhook(`e2e-stream-video-${streamSequence}`, "ready");

    const resumedApi = new AiruxApiClient(
      { apiOrigin: APP_ORIGIN, agentToken: context.agentToken },
      workerFetch,
    );
    const open = await listAiruxOpenReviews({}, { api: resumedApi });
    expect(open.reviews).toEqual([
      expect.objectContaining({ id: assignment.review_id, status: "pending" }),
    ]);

    const pending = await getReviewerReview(
      assignment.review_id,
      context.reviewerToken,
      workerFetch,
    );
    const decided = await submitReviewDecision(
      assignment.review_id,
      context.reviewerToken,
      {
        expected_version: pending.version,
        outcome: "changes_requested",
        comment: "Show the keyboard interaction in the next recording.",
      },
      workerFetch,
    );
    expect(decided.status).toBe("changes_requested");

    await expect(
      getAiruxReview({ review_id: assignment.review_id }, { api: resumedApi }),
    ).resolves.toMatchObject({
      review_id: assignment.review_id,
      status: "changes_requested",
      decision: {
        comment: "Show the keyboard interaction in the next recording.",
      },
    });

    const deletion = await workerFetch(
      `/api/v1/reviews/${assignment.review_id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${context.reviewerToken}` },
      },
    );
    expect(deletion.status).toBe(204);
    await expect(
      resumedApi.getReview(assignment.review_id, new AbortController().signal),
    ).rejects.toMatchObject({ status: 404 });

    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry: () => {} },
      env,
    );
    expect(deletedStreamVideoIds).toContain(
      `e2e-stream-video-${streamSequence}`,
    );
  });

  it("surfaces a Stream processing failure without deleting the retryable recording", async () => {
    const context = await createTestContext();
    const removeRecording = vi.fn(async () => {});
    const recording = new TemporaryBrowserRecording(
      {
        directory: "/tmp/airux-m7-4-retryable",
        filePath: "/tmp/airux-m7-4-retryable/capture.webm",
        height: 720,
        sizeBytes: 5,
        width: 1_280,
      },
      removeRecording,
    );
    const clientRequestId = randomUUID();

    let error: unknown;
    try {
      await createAiruxReview(
        {
          client_request_id: clientRequestId,
          title: "Review a failed Stream upload",
          claim: "The upload failure remains retryable.",
          criteria: [{ id: "retry", prompt: "The recording can be retried." }],
          capture_plan: {
            start_url: "http://127.0.0.1:3000",
            viewport: { width: 1_280, height: 720 },
            max_duration_ms: 30_000,
            steps: [{ action: "pause", duration_ms: 250 }],
          },
        },
        {
          api: context.agentApi,
          capture: async () => recording,
          directUploadDependencies: {
            openFile: async () => new Blob(["video"], { type: "video/webm" }),
            fetcher: async () => {
              await sendStreamWebhook(
                `e2e-stream-video-${streamSequence}`,
                "error",
              );
              return new Response(null, { status: 200 });
            },
            sleep: async () => {},
          },
        },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(CreateReviewWorkflowError);
    expect(error).toMatchObject({ stage: "processing" });
    expect(removeRecording).not.toHaveBeenCalled();

    const open = await context.agentApi.listOpenReviews(
      new AbortController().signal,
    );
    const failed = open.reviews.find(
      (review) => review.client_request_id === clientRequestId,
    );
    expect(failed).toBeDefined();
    if (failed !== undefined) {
      createdReviewIds.add(failed.id);
      const detail = await context.agentApi.getReview(
        failed.id,
        new AbortController().signal,
      );
      expect(detail.review.evidence).toMatchObject({
        status: "failed",
        failure_code: "ERR_TRANSCODE",
      });
    }
  });

  it("expires due evidence through scheduled cleanup and returns the terminal result after resumption", async () => {
    const context = await createTestContext();
    const assignment = await createReview(context);
    const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1_000).toISOString();
    const expiredAt = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    await updateRows("reviews", assignment.review_id, {
      created_at: createdAt,
      expires_at: expiredAt,
    });
    await updateRows("evidence", assignment.evidence_id, {
      created_at: createdAt,
      delete_after: expiredAt,
    });

    await worker.scheduled(
      { scheduledTime: Date.now(), cron: "*/15 * * * *", noRetry: () => {} },
      env,
    );

    const resumedApi = new AiruxApiClient(
      { apiOrigin: APP_ORIGIN, agentToken: context.agentToken },
      workerFetch,
    );
    await expect(
      getAiruxReview({ review_id: assignment.review_id }, { api: resumedApi }),
    ).resolves.toMatchObject({
      review_id: assignment.review_id,
      status: "expired",
      decision: null,
    });
    await expect(
      listAiruxOpenReviews({}, { api: resumedApi }),
    ).resolves.toEqual({ reviews: [] });
    expect(deletedStreamVideoIds).toContain(
      `e2e-stream-video-${streamSequence}`,
    );
  });

  it("rejects a revoked agent credential at the real Worker and database boundary", async () => {
    const context = await createTestContext();
    const credentialId = context.agentToken.split(".")[1];
    expect(credentialId).toBeDefined();
    const response = await workerFetch(
      `/api/v1/agent-credentials/${credentialId}/revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${context.reviewerToken}` },
      },
    );
    expect(response.status).toBe(200);
    await expect(
      context.agentApi.listOpenReviews(new AbortController().signal),
    ).rejects.toBeInstanceOf(AiruxApiError);
  });
});
