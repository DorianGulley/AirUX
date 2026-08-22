import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { handleStreamWebhook } from "../src/stream-webhook.js";
import { TEST_ENV } from "./fixtures.js";

const CONFIG = loadConfig(TEST_ENV);
const NOW = new Date("2026-08-20T21:45:00.000Z");
const TIMESTAMP = String(NOW.getTime() / 1000);
const STREAM_VIDEO_ID = "6b9e68b07dfee8cc2d116e4c51d6a957";

const READY_EVENT = {
  uid: STREAM_VIDEO_ID,
  readyToStream: true,
  status: { state: "ready", pctComplete: "100.000000" },
  duration: 15.5,
  input: { width: 1_280, height: 720 },
  meta: { review_id: "provider-metadata-is-not-trusted" },
};

async function signature(
  body: string,
  timestamp = TIMESTAMP,
  secret = TEST_ENV.STREAM_WEBHOOK_SECRET,
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}.${body}`),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function webhookRequest(
  value: unknown,
  options: {
    body?: string;
    signature?: string;
    timestamp?: string;
  } = {},
) {
  const body = options.body ?? JSON.stringify(value);
  const timestamp = options.timestamp ?? TIMESTAMP;
  const digest = options.signature ?? (await signature(body, timestamp));
  return new Request(
    "https://airux.example/api/v1/webhooks/cloudflare-stream",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-signature": `time=${timestamp},sig1=${digest}`,
      },
      body,
    },
  );
}

function processedRow(overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: "347a6473-e510-4d6a-918f-b2bd56d942b7",
    review_id: "8d4ddde8-b58f-4c2c-b37f-b3ea1fb312da",
    evidence_status: "ready",
    review_status: "pending",
    review_version: 1,
    ...overrides,
  };
}

describe("Stream webhook", () => {
  it("verifies exact body bytes and applies a ready notification", async () => {
    const body = `${JSON.stringify(READY_EVENT, null, 2)}\n`;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body))).toEqual({
          p_stream_video_id: STREAM_VIDEO_ID,
          p_target_status: "ready",
          p_failure_code: null,
          p_duration_ms: 15_500,
          p_width: 1_280,
          p_height: 720,
          p_pending_expires_at: "2026-08-23T21:45:00.000Z",
        });
        return Response.json([processedRow()]);
      },
    );

    const response = await handleStreamWebhook(
      await webhookRequest(READY_EVENT, { body }),
      CONFIG,
      { fetcher, now: () => NOW },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(fetcher).toHaveBeenCalledOnce();
    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe(
      "https://example.supabase.co/rest/v1/rpc/process_stream_webhook",
    );
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(new Headers(init?.headers).get("apikey")).toBe(
      TEST_ENV.SUPABASE_SECRET_KEY,
    );
  });

  it("records Stream processing errors without trusting error text", async () => {
    const event = {
      uid: STREAM_VIDEO_ID,
      readyToStream: false,
      status: {
        state: "error",
        errReasonCode: "ERR_MALFORMED_VIDEO",
        errReasonText: "private provider detail",
      },
    };
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          p_stream_video_id: STREAM_VIDEO_ID,
          p_target_status: "failed",
          p_failure_code: "ERR_MALFORMED_VIDEO",
          p_duration_ms: null,
          p_width: null,
          p_height: null,
          p_pending_expires_at: null,
        });
        expect(String(init?.body)).not.toContain("private provider detail");
        return Response.json([
          processedRow({
            evidence_status: "failed",
            review_status: "draft",
            review_version: 0,
          }),
        ]);
      },
    );

    const response = await handleStreamWebhook(
      await webhookRequest(event),
      CONFIG,
      { fetcher, now: () => NOW },
    );

    expect(response.status).toBe(204);
  });

  it("uses a bounded fallback when Stream omits an error code", async () => {
    const event = {
      uid: STREAM_VIDEO_ID,
      readyToStream: false,
      status: { state: "error", errReasonText: "provider detail" },
    };
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(JSON.parse(String(init?.body)).p_failure_code).toBe(
          "ERR_UNKNOWN",
        );
        return Response.json([processedRow({ evidence_status: "failed" })]);
      },
    );

    const response = await handleStreamWebhook(
      await webhookRequest(event),
      CONFIG,
      { fetcher, now: () => NOW },
    );

    expect(response.status).toBe(204);
  });

  it("acknowledges signed notifications for unrelated Stream videos", async () => {
    const fetcher = vi.fn(async () => Response.json([]));
    const response = await handleStreamWebhook(
      await webhookRequest(READY_EVENT),
      CONFIG,
      { fetcher, now: () => NOW },
    );

    expect(response.status).toBe(204);
  });

  it.each([
    ["stale", -301_000],
    ["future", 301_000],
  ])(
    "rejects a %s signed timestamp outside the five-minute window",
    async (_name, offset) => {
      const timestamp = String((NOW.getTime() + offset) / 1000);
      const fetcher = vi.fn();
      const response = await handleStreamWebhook(
        await webhookRequest(READY_EVENT, { timestamp }),
        CONFIG,
        { fetcher, now: () => NOW },
      );

      expect(response.status).toBe(401);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("rejects a signature made with another secret", async () => {
    const body = JSON.stringify(READY_EVENT);
    const fetcher = vi.fn();
    const response = await handleStreamWebhook(
      await webhookRequest(READY_EVENT, {
        body,
        signature: await signature(
          body,
          TIMESTAMP,
          "different-stream-webhook-secret",
        ),
      }),
      CONFIG,
      { fetcher, now: () => NOW },
    );

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects duplicate signature fields", async () => {
    const request = await webhookRequest(READY_EVENT);
    request.headers.set(
      "webhook-signature",
      `${request.headers.get("webhook-signature")},sig1=${"0".repeat(64)}`,
    );
    const fetcher = vi.fn();

    const response = await handleStreamWebhook(request, CONFIG, {
      fetcher,
      now: () => NOW,
    });

    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a signed payload with invalid ready metadata", async () => {
    const fetcher = vi.fn();
    const response = await handleStreamWebhook(
      await webhookRequest({ ...READY_EVENT, duration: 121 }),
      CONFIG,
      { fetcher, now: () => NOW },
    );

    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns a retryable response when persistence fails", async () => {
    const response = await handleStreamWebhook(
      await webhookRequest(READY_EVENT),
      CONFIG,
      {
        fetcher: vi.fn(async () => new Response(null, { status: 500 })),
        now: () => NOW,
      },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Service unavailable" },
    });
  });
});
