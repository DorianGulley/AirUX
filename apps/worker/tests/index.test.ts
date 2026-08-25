import { timingSafeEqual } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { hashAgentCredentialToken } from "../src/agent-credential-token.js";
import worker from "../src/index.js";
import { ScheduledCleanupError } from "../src/scheduled-cleanup.js";
import { TEST_ENV } from "./fixtures.js";

const CREDENTIAL_ID = "dc0fb4f8-652b-4e12-8899-e12c34afbcde";
const REVIEWER_ID = "fa2a3aca-e4c6-40fe-bb92-e422f3350806";
const AGENT_TOKEN = `airux_agent_v1.${CREDENTIAL_ID}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

function authenticatedReviewerResponse() {
  return Response.json({
    id: REVIEWER_ID,
    app_metadata: { provider: "github", providers: ["github"] },
  });
}

describe("AirUX Worker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
  });

  it("reports health without allowing the response to be cached", async () => {
    const response = worker.fetch(
      new Request("https://airux.app/api/v1/health"),
      TEST_ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects unsupported health-check methods", async () => {
    const response = worker.fetch(
      new Request("https://airux.app/api/v1/health", { method: "POST" }),
      TEST_ENV,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Method not allowed",
      },
    });
  });

  it("returns only public browser configuration", async () => {
    const response = worker.fetch(
      new Request("https://airux.app/api/v1/config"),
      TEST_ENV,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const responseForSecretCheck = response.clone();
    await expect(response.json()).resolves.toEqual({
      supabase: {
        url: TEST_ENV.SUPABASE_URL,
        publishable_key: TEST_ENV.SUPABASE_PUBLISHABLE_KEY,
      },
    });
    expect(await responseForSecretCheck.text()).not.toContain(
      TEST_ENV.SUPABASE_SECRET_KEY,
    );
  });

  it("rejects unsupported browser-configuration methods", async () => {
    const response = worker.fetch(
      new Request("https://airux.app/api/v1/config", { method: "POST" }),
      TEST_ENV,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "invalid_request",
        message: "Method not allowed",
      },
    });
  });

  it("exposes the Stream webhook only as a POST endpoint", async () => {
    const response = worker.fetch(
      new Request("https://airux.app/api/v1/webhooks/cloudflare-stream"),
      TEST_ENV,
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("returns the versioned API not-found response for unknown routes", async () => {
    const response = worker.fetch(
      new Request("https://airux.app/api/v1/unknown"),
      TEST_ENV,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "not_found",
        message: "Not found",
      },
    });
  });

  it("requires a reviewer session for credential management", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(
      new Request("https://airux.app/api/v1/agent-credentials"),
      TEST_ENV,
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it("does not accept an agent credential on reviewer routes", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const agentCredential =
      "airux_agent_v1.dc0fb4f8-652b-4e12-8899-e12c34afbcde.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

    const response = await worker.fetch(
      new Request("https://airux.app/api/v1/agent-credentials", {
        headers: { authorization: `Bearer ${agentCredential}` },
      }),
      TEST_ENV,
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
  });

  it("passes the authenticated reviewer to credential listing", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") {
        return authenticatedReviewerResponse();
      }
      if (url.pathname === "/rest/v1/agent_credentials") {
        expect(url.searchParams.get("user_id")).toBe(`eq.${REVIEWER_ID}`);
        return Response.json([]);
      }
      return new Response(null, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(
      new Request("https://airux.app/api/v1/agent-credentials", {
        headers: { authorization: "Bearer header.payload.signature" },
      }),
      TEST_ENV,
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(response.json()).resolves.toEqual({ credentials: [] });
  });

  it("rate limits reviewer authentication before calling Supabase", async () => {
    const fetcher = vi.fn();
    const limiter = {
      limit: vi.fn(async () => ({ success: false })),
    };
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(
      new Request("https://airux.app/api/v1/agent-credentials", {
        headers: {
          authorization: "Bearer header.payload.signature",
          "cf-connecting-ip": "203.0.113.7",
        },
      }),
      { ...TEST_ENV, REVIEWER_AUTH_RATE_LIMITER: limiter },
    );

    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({
      key: "reviewer-ip:203.0.113.7",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: { code: "rate_limited", message: "Too many requests" },
    });
  });

  it("rate limits credential creation by authenticated reviewer", async () => {
    const fetcher = vi.fn(async () => authenticatedReviewerResponse());
    const limiter = {
      limit: vi.fn(async () => ({ success: false })),
    };
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(
      new Request("https://airux.app/api/v1/agent-credentials", {
        method: "POST",
        headers: { authorization: "Bearer header.payload.signature" },
      }),
      { ...TEST_ENV, CREDENTIAL_CREATE_RATE_LIMITER: limiter },
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({
      key: `reviewer:${REVIEWER_ID}`,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
  });

  it("fails closed when a rate-limit binding is unavailable", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(
      new Request("https://airux.app/api/v1/agent-credentials"),
      {
        ...TEST_ENV,
        REVIEWER_AUTH_RATE_LIMITER: {
          limit: vi.fn(async () => Promise.reject(new Error("private detail"))),
        },
      },
    );

    expect(fetcher).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Service unavailable" },
    });
  });

  it("advertises credential-management methods", async () => {
    const collection = worker.fetch(
      new Request("https://airux.app/api/v1/agent-credentials", {
        method: "DELETE",
      }),
      TEST_ENV,
    );
    expect(collection.status).toBe(405);
    expect(collection.headers.get("allow")).toBe("GET, POST");

    const revocation = worker.fetch(
      new Request(
        `https://airux.app/api/v1/agent-credentials/${CREDENTIAL_ID}/revoke`,
      ),
      TEST_ENV,
    );
    expect(revocation.status).toBe(405);
    expect(revocation.headers.get("allow")).toBe("POST");
  });

  it("requires an agent credential for Review routes", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    for (const request of [
      new Request("https://airux.app/api/v1/agent/reviews"),
      new Request(`https://airux.app/api/v1/agent/reviews/${CREDENTIAL_ID}`),
      new Request(
        `https://airux.app/api/v1/agent/reviews/${CREDENTIAL_ID}/cancel`,
        { method: "POST" },
      ),
    ]) {
      const response = await worker.fetch(request, TEST_ENV);
      expect(response.status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rate limits Review creation by authenticated agent credential", async () => {
    Object.defineProperty(crypto.subtle, "timingSafeEqual", {
      configurable: true,
      value: (left: ArrayBufferView, right: ArrayBufferView) =>
        timingSafeEqual(
          Buffer.from(left.buffer, left.byteOffset, left.byteLength),
          Buffer.from(right.buffer, right.byteOffset, right.byteLength),
        ),
    });
    const secretHash = await hashAgentCredentialToken(AGENT_TOKEN);
    const fetcher = vi.fn(async () =>
      Response.json([
        {
          id: CREDENTIAL_ID,
          user_id: REVIEWER_ID,
          secret_hash: secretHash,
        },
      ]),
    );
    const limiter = {
      limit: vi.fn(async () => ({ success: false })),
    };
    vi.stubGlobal("fetch", fetcher);

    const response = await worker.fetch(
      new Request("https://airux.app/api/v1/agent/reviews", {
        method: "POST",
        headers: {
          authorization: `Bearer ${AGENT_TOKEN}`,
          "content-type": "application/json",
        },
        body: "{}",
      }),
      { ...TEST_ENV, AGENT_REVIEW_CREATE_RATE_LIMITER: limiter },
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(limiter.limit).toHaveBeenCalledExactlyOnceWith({
      key: `agent-credential:${CREDENTIAL_ID}`,
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    await expect(response.json()).resolves.toEqual({
      error: { code: "rate_limited", message: "Too many requests" },
    });
  });

  it("advertises agent Review methods before authentication", () => {
    const collection = worker.fetch(
      new Request("https://airux.app/api/v1/agent/reviews", {
        method: "DELETE",
      }),
      TEST_ENV,
    );
    expect(collection.status).toBe(405);
    expect(collection.headers.get("allow")).toBe("GET, POST");

    const detail = worker.fetch(
      new Request(`https://airux.app/api/v1/agent/reviews/${CREDENTIAL_ID}`, {
        method: "POST",
      }),
      TEST_ENV,
    );
    expect(detail.status).toBe(405);
    expect(detail.headers.get("allow")).toBe("GET");

    const cancellation = worker.fetch(
      new Request(
        `https://airux.app/api/v1/agent/reviews/${CREDENTIAL_ID}/cancel`,
      ),
      TEST_ENV,
    );
    expect(cancellation.status).toBe(405);
    expect(cancellation.headers.get("allow")).toBe("POST");
  });

  it("requires a reviewer session for reviewer Review routes", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    for (const request of [
      new Request(`https://airux.app/api/v1/reviews/${CREDENTIAL_ID}`),
      new Request(`https://airux.app/api/v1/reviews/${CREDENTIAL_ID}`, {
        method: "DELETE",
      }),
      new Request(
        `https://airux.app/api/v1/reviews/${CREDENTIAL_ID}/decision`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ expected_version: 1, outcome: "approved" }),
        },
      ),
      new Request(
        `https://airux.app/api/v1/evidence/${CREDENTIAL_ID}/playback-token`,
        { method: "POST" },
      ),
    ]) {
      const response = await worker.fetch(request, TEST_ENV);
      expect(response.status).toBe(401);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("advertises reviewer Review methods before authentication", () => {
    const detail = worker.fetch(
      new Request(`https://airux.app/api/v1/reviews/${CREDENTIAL_ID}`, {
        method: "POST",
      }),
      TEST_ENV,
    );
    expect(detail.status).toBe(405);
    expect(detail.headers.get("allow")).toBe("GET, DELETE");

    const decision = worker.fetch(
      new Request(`https://airux.app/api/v1/reviews/${CREDENTIAL_ID}/decision`),
      TEST_ENV,
    );
    expect(decision.status).toBe(405);
    expect(decision.headers.get("allow")).toBe("POST");

    const playback = worker.fetch(
      new Request(
        `https://airux.app/api/v1/evidence/${CREDENTIAL_ID}/playback-token`,
      ),
      TEST_ENV,
    );
    expect(playback.status).toBe(405);
    expect(playback.headers.get("allow")).toBe("POST");
  });

  it("runs scheduled cleanup at the Cron event timestamp", async () => {
    const scheduledTime = Date.parse("2026-08-22T04:30:00.000Z");
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe(
          "https://example.supabase.co/rest/v1/rpc/prepare_due_evidence_cleanup",
        );
        expect(JSON.parse(String(init?.body))).toEqual({
          p_due_before: "2026-08-22T04:30:00.000Z",
          p_limit: 25,
        });
        return Response.json([]);
      },
    );
    vi.stubGlobal("fetch", fetcher);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await worker.scheduled(
      { scheduledTime, cron: "*/15 * * * *", noRetry: vi.fn() },
      TEST_ENV,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledExactlyOnceWith({
      event: "scheduled_cleanup_completed",
      selected: 0,
      deleted: 0,
      failed: 0,
    });
  });

  it("records cleanup when Stream reports that the video is already gone", async () => {
    const scheduledTime = Date.parse("2026-08-22T04:30:00.000Z");
    const evidenceId = "347a6473-e510-4d6a-918f-b2bd56d942b7";
    const reviewId = "8d4ddde8-b58f-4c2c-b37f-b3ea1fb312da";
    const completed: string[] = [];
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/rpc/prepare_due_evidence_cleanup")) {
          return Response.json([
            {
              evidence_id: evidenceId,
              review_id: reviewId,
              stream_video_id: "already-deleted-video",
              evidence_status: "deleting",
              review_status: "expired",
            },
          ]);
        }
        const body = JSON.parse(String(init?.body));
        completed.push(body.p_evidence_id);
        return Response.json([
          {
            evidence_id: evidenceId,
            review_id: reviewId,
            status: "deleted",
            deleted_at: "2026-08-22T04:29:59.000Z",
          },
        ]);
      },
    );
    const notFound = new Error(
      "Not Found: The requested resource or operation was not found.",
    );
    const deleteVideo = vi.fn(async () => Promise.reject(notFound));
    const stream = {
      video: vi.fn(() => ({ delete: deleteVideo })),
    } as StreamBinding;
    vi.stubGlobal("fetch", fetcher);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    await worker.scheduled(
      { scheduledTime, cron: "*/15 * * * *", noRetry: vi.fn() },
      { ...TEST_ENV, STREAM: stream },
    );

    expect(stream.video).toHaveBeenCalledExactlyOnceWith(
      "already-deleted-video",
    );
    expect(deleteVideo).toHaveBeenCalledOnce();
    expect(completed).toEqual([evidenceId]);
  });

  it("records only bounded cleanup metrics when scheduled cleanup fails", async () => {
    const scheduledTime = Date.parse("2026-08-22T04:30:00.000Z");
    const privateFailure = "private database response";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(privateFailure, { status: 503 })),
    );
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      worker.scheduled(
        { scheduledTime, cron: "*/15 * * * *", noRetry: vi.fn() },
        TEST_ENV,
      ),
    ).rejects.toBeInstanceOf(ScheduledCleanupError);

    expect(error).toHaveBeenCalledExactlyOnceWith({
      event: "scheduled_cleanup_failed",
      stage: "execution",
      selected: 0,
      deleted: 0,
      failed: 0,
    });
    expect(error.mock.calls.flat().join(" ")).not.toContain(privateFailure);
  });

  it("records a safe cleanup configuration failure", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      worker.scheduled(
        {
          scheduledTime: Date.parse("2026-08-22T04:30:00.000Z"),
          cron: "*/15 * * * *",
          noRetry: vi.fn(),
        },
        { ...TEST_ENV, SUPABASE_SECRET_KEY: "private invalid value" },
      ),
    ).rejects.toThrow("Scheduled cleanup configuration unavailable");

    expect(error).toHaveBeenCalledExactlyOnceWith({
      event: "scheduled_cleanup_failed",
      stage: "configuration",
      selected: 0,
      deleted: 0,
      failed: 0,
    });
    expect(error.mock.calls.flat().join(" ")).not.toContain(
      "private invalid value",
    );
  });

  it("fails closed without exposing invalid configuration", async () => {
    const response = worker.fetch(
      new Request("https://airux.app/api/v1/health"),
      { ...TEST_ENV, SUPABASE_SECRET_KEY: "" },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "internal_error",
        message: "Service unavailable",
      },
    });
  });
});
