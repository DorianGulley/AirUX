import { describe, expect, it, vi } from "vitest";

import {
  handleAgentReviewCancellation,
  handleAgentReviewCollection,
  handleAgentReviewGet,
  type ReviewStreamClient,
} from "../src/agent-reviews.js";
import { loadConfig } from "../src/config.js";
import { TEST_ENV } from "./fixtures.js";

const CONFIG = loadConfig(TEST_ENV);
const AGENT = {
  credentialId: "dc0fb4f8-652b-4e12-8899-e12c34afbcde",
  userId: "fa2a3aca-e4c6-40fe-bb92-e422f3350806",
};
const REVIEW_ID = "8d4ddde8-b58f-4c2c-b37f-b3ea1fb312da";
const EVIDENCE_ID = "347a6473-e510-4d6a-918f-b2bd56d942b7";
const NOW = new Date("2026-08-20T08:00:00Z");

const CREATE_BODY = {
  client_request_id: "agent-run-42",
  title: "Review the responsive layout",
  claim: "The navigation works at mobile width.",
  criteria: [{ id: "layout", prompt: "The navigation remains visible." }],
  evidence: {
    kind: "browser_video",
    media_type: "video/webm",
    size_bytes: 1_024,
  },
};

function createRequest(body: unknown = CREATE_BODY) {
  return new Request("https://airux.example/api/v1/agent/reviews", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createRow(overrides: Record<string, unknown> = {}) {
  return {
    review_id: REVIEW_ID,
    evidence_id: EVIDENCE_ID,
    status: "draft",
    stream_video_id: null,
    created: true,
    ...overrides,
  };
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REVIEW_ID,
    user_id: AGENT.userId,
    agent_credential_id: AGENT.credentialId,
    client_request_id: CREATE_BODY.client_request_id,
    title: CREATE_BODY.title,
    claim: CREATE_BODY.claim,
    criteria: CREATE_BODY.criteria,
    status: "pending",
    version: 1,
    created_at: "2026-08-20T08:00:00+00:00",
    submitted_at: "2026-08-20T08:01:00+00:00",
    expires_at: "2026-08-23T08:01:00+00:00",
    resolved_at: null,
    ...overrides,
  };
}

function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: EVIDENCE_ID,
    review_id: REVIEW_ID,
    kind: "browser_video",
    status: "ready",
    media_type: "video/webm",
    size_bytes: 1_024,
    failure_code: null,
    stream_video_id: "private-stream-id",
    delete_after: "2026-08-27T08:00:00+00:00",
    ...overrides,
  };
}

function streamClient(overrides: Partial<ReviewStreamClient> = {}) {
  return {
    createDirectUpload: vi.fn(async () => ({
      id: "new-stream-id",
      uploadURL: "https://upload.videodelivery.net/one-time-token",
    })),
    deleteVideo: vi.fn(async () => undefined),
    ...overrides,
  } satisfies ReviewStreamClient;
}

function detailFetcher(reviewOverrides: Record<string, unknown> = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/reviews") {
      return Response.json([reviewRow(reviewOverrides)]);
    }
    if (url.pathname === "/rest/v1/evidence") {
      return Response.json([evidenceRow()]);
    }
    if (url.pathname === "/rest/v1/decisions") {
      return Response.json([]);
    }
    return new Response(null, { status: 404 });
  });
}

describe("agent Review creation", () => {
  it("creates records before provisioning and attaching a private upload", async () => {
    const calls: string[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(url.pathname);
        if (url.pathname.endsWith("/rpc/create_agent_review")) {
          const body = JSON.parse(String(init?.body));
          expect(body).toEqual({
            p_user_id: AGENT.userId,
            p_agent_credential_id: AGENT.credentialId,
            p_client_request_id: CREATE_BODY.client_request_id,
            p_title: CREATE_BODY.title,
            p_claim: CREATE_BODY.claim,
            p_criteria: CREATE_BODY.criteria,
            p_evidence_kind: "browser_video",
            p_media_type: "video/webm",
            p_size_bytes: 1_024,
            p_expires_at: "2026-08-20T09:00:00.000Z",
            p_delete_after: "2026-08-20T09:00:00.000Z",
          });
          return Response.json([createRow()]);
        }
        if (url.pathname.endsWith("/rpc/replace_agent_review_upload")) {
          return Response.json([
            { evidence_id: EVIDENCE_ID, previous_stream_video_id: null },
          ]);
        }
        return new Response(null, { status: 404 });
      },
    );
    const stream = streamClient({
      createDirectUpload: vi.fn(async (params) => {
        calls.push("stream:createDirectUpload");
        expect(params).toEqual({
          maxDurationSeconds: 120,
          expiry: "2026-08-20T08:15:00.000Z",
          creator: AGENT.credentialId,
          meta: { review_id: REVIEW_ID, evidence_id: EVIDENCE_ID },
          requireSignedURLs: true,
        });
        return {
          id: "new-stream-id",
          uploadURL: "https://upload.videodelivery.net/one-time-token",
        };
      }),
    });

    const response = await handleAgentReviewCollection(
      createRequest(),
      AGENT,
      CONFIG,
      { fetcher, stream, now: () => NOW },
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(calls).toEqual([
      "/rest/v1/rpc/create_agent_review",
      "stream:createDirectUpload",
      "/rest/v1/rpc/replace_agent_review_upload",
    ]);
    const body = await response.json();
    expect(body).toEqual({
      review_id: REVIEW_ID,
      review_url: `https://airux.example/reviews/${REVIEW_ID}`,
      status: "draft",
      evidence_id: EVIDENCE_ID,
      upload_url: "https://upload.videodelivery.net/one-time-token",
      upload_expires_at: "2026-08-20T08:15:00.000Z",
    });
    expect(JSON.stringify(body)).not.toContain("new-stream-id");
    expect(JSON.stringify(body)).not.toContain(AGENT.userId);
    expect(JSON.stringify(body)).not.toContain(AGENT.credentialId);
  });

  it("reuses the Review on an identical retry and retires its old upload slot", async () => {
    const oldStreamId = "old-stream-id";
    const stream = streamClient();
    const deferred: Promise<unknown>[] = [];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json([
          createRow({ created: false, stream_video_id: oldStreamId }),
        ]),
      )
      .mockResolvedValueOnce(
        Response.json([
          {
            evidence_id: EVIDENCE_ID,
            previous_stream_video_id: oldStreamId,
          },
        ]),
      );

    const response = await handleAgentReviewCollection(
      createRequest(),
      AGENT,
      CONFIG,
      {
        fetcher,
        stream,
        now: () => NOW,
        waitUntil: (promise) => deferred.push(promise),
      },
    );

    expect(response.status).toBe(200);
    await Promise.all(deferred);
    expect(stream.deleteVideo).toHaveBeenCalledExactlyOnceWith(oldStreamId);
    await expect(response.json()).resolves.toMatchObject({
      review_id: REVIEW_ID,
      evidence_id: EVIDENCE_ID,
    });
  });

  it("rejects a reused key with different content as a conflict", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { code: "P0001", message: "client request payload conflict" },
        { status: 400 },
      ),
    );
    const stream = streamClient();

    const response = await handleAgentReviewCollection(
      createRequest(),
      AGENT,
      CONFIG,
      { fetcher, stream },
    );

    expect(response.status).toBe(409);
    expect(stream.createDirectUpload).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      error: { code: "conflict", message: "Review conflict" },
    });
  });

  it("rejects invalid input before creating records or Stream uploads", async () => {
    const fetcher = vi.fn();
    const stream = streamClient();
    const response = await handleAgentReviewCollection(
      createRequest({ ...CREATE_BODY, unexpected: true }),
      AGENT,
      CONFIG,
      { fetcher, stream },
    );

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    expect(stream.createDirectUpload).not.toHaveBeenCalled();
  });

  it("keeps the draft retryable when Stream provisioning fails", async () => {
    const stream = streamClient({
      createDirectUpload: vi.fn(async () =>
        Promise.reject(new Error("private provider detail")),
      ),
    });
    const response = await handleAgentReviewCollection(
      createRequest(),
      AGENT,
      CONFIG,
      {
        fetcher: vi.fn(async () => Response.json([createRow()])),
        stream,
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Service unavailable" },
    });
  });

  it("deletes a new Stream slot when its Evidence attachment loses a race", async () => {
    const stream = streamClient();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json([createRow()]))
      .mockResolvedValueOnce(Response.json([]));

    const response = await handleAgentReviewCollection(
      createRequest(),
      AGENT,
      CONFIG,
      { fetcher, stream },
    );

    expect(response.status).toBe(409);
    expect(stream.deleteVideo).toHaveBeenCalledExactlyOnceWith("new-stream-id");
  });
});

describe("agent Review reads and cancellation", () => {
  it("lists only open Reviews scoped to the authenticated credential", async () => {
    const fetcher = vi.fn(async () => Response.json([reviewRow()]));
    const response = await handleAgentReviewCollection(
      new Request("https://airux.example/api/v1/agent/reviews"),
      AGENT,
      CONFIG,
      { fetcher, stream: streamClient() },
    );

    expect(response.status).toBe(200);
    const [input] = fetcher.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.searchParams.get("user_id")).toBe(`eq.${AGENT.userId}`);
    expect(url.searchParams.get("agent_credential_id")).toBe(
      `eq.${AGENT.credentialId}`,
    );
    expect(url.searchParams.get("status")).toBe("in.(draft,pending)");
    expect(url.searchParams.get("deleted_at")).toBe("is.null");
    const body = await response.json();
    expect(body).toEqual({
      reviews: [
        {
          id: REVIEW_ID,
          review_url: `https://airux.example/reviews/${REVIEW_ID}`,
          client_request_id: CREATE_BODY.client_request_id,
          title: CREATE_BODY.title,
          status: "pending",
          version: 1,
          created_at: "2026-08-20T08:00:00.000Z",
          expires_at: "2026-08-23T08:01:00.000Z",
        },
      ],
    });
    expect(JSON.stringify(body)).not.toContain(AGENT.userId);
  });

  it("fails closed when a listed row crosses the credential boundary", async () => {
    const response = await handleAgentReviewCollection(
      new Request("https://airux.example/api/v1/agent/reviews"),
      AGENT,
      CONFIG,
      {
        fetcher: vi.fn(async () =>
          Response.json([
            reviewRow({
              agent_credential_id: "eb2d9347-652c-43ba-8e8c-81ac9a17d909",
            }),
          ]),
        ),
        stream: streamClient(),
      },
    );

    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(CREATE_BODY.title);
  });

  it("returns agent-safe detail with terminal feedback", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/rest/v1/reviews") {
        return Response.json([
          reviewRow({
            status: "changes_requested",
            version: 2,
            resolved_at: "2026-08-20T08:02:00+00:00",
          }),
        ]);
      }
      if (url.pathname === "/rest/v1/evidence") {
        return Response.json([evidenceRow()]);
      }
      if (url.pathname === "/rest/v1/decisions") {
        return Response.json([
          {
            review_id: REVIEW_ID,
            outcome: "changes_requested",
            comment: "The menu overlaps the heading.",
            created_at: "2026-08-20T08:02:00+00:00",
          },
        ]);
      }
      return new Response(null, { status: 404 });
    });

    const response = await handleAgentReviewGet(REVIEW_ID, AGENT, CONFIG, {
      fetcher,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      review: {
        id: REVIEW_ID,
        status: "changes_requested",
        decision: {
          outcome: "changes_requested",
          comment: "The menu overlaps the heading.",
        },
        evidence: { id: EVIDENCE_ID, status: "ready" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("private-stream-id");
    expect(JSON.stringify(body)).not.toContain("delete_after");
    expect(JSON.stringify(body)).not.toContain(AGENT.userId);
    expect(JSON.stringify(body)).not.toContain(AGENT.credentialId);
  });

  it("uses the same not-found response for malformed, missing, and foreign Reviews", async () => {
    const noFetch = vi.fn();
    const malformed = await handleAgentReviewGet("not-a-uuid", AGENT, CONFIG, {
      fetcher: noFetch,
    });
    expect(noFetch).not.toHaveBeenCalled();

    const missingFetcher = vi.fn(async () => Response.json([]));
    const missing = await handleAgentReviewGet(REVIEW_ID, AGENT, CONFIG, {
      fetcher: missingFetcher,
    });

    for (const response of [malformed, missing]) {
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({
        error: { code: "not_found", message: "Not found" },
      });
    }
  });

  it("cancels atomically and returns the resulting detail", async () => {
    const detail = detailFetcher({
      status: "cancelled",
      version: 2,
      resolved_at: "2026-08-20T08:03:00+00:00",
    });
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/rpc/cancel_agent_review")) {
          expect(JSON.parse(String(init?.body))).toEqual({
            p_review_id: REVIEW_ID,
            p_user_id: AGENT.userId,
            p_agent_credential_id: AGENT.credentialId,
          });
          return Response.json([
            { review_id: REVIEW_ID, status: "cancelled", version: 2 },
          ]);
        }
        return detail(input, init);
      },
    );

    const response = await handleAgentReviewCancellation(
      REVIEW_ID,
      AGENT,
      CONFIG,
      { fetcher },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      review: { id: REVIEW_ID, status: "cancelled", version: 2 },
    });
  });

  it("rejects cancellation after another terminal outcome", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { code: "P0001", message: "review cannot be cancelled" },
        { status: 400 },
      ),
    );
    const response = await handleAgentReviewCancellation(
      REVIEW_ID,
      AGENT,
      CONFIG,
      { fetcher },
    );

    expect(response.status).toBe(409);
  });
});
