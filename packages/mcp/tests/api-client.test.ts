import { describe, expect, it, vi } from "vitest";

import { AiruxApiClient, AiruxApiError } from "../src/api-client.js";

const TOKEN = `airux_agent_v1.00000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;
const REVIEW_ID = "20000000-0000-4000-8000-000000000045";
const EVIDENCE_ID = "30000000-0000-4000-8000-000000000045";

const createRequest = {
  claim: "The flow works.",
  client_request_id: "agent-run-45",
  criteria: [{ id: "works", prompt: "The flow completes." }],
  evidence: {
    kind: "browser_video" as const,
    media_type: "video/webm",
    size_bytes: 5,
  },
  title: "Review the flow",
};

const assignment = {
  evidence_id: EVIDENCE_ID,
  review_id: REVIEW_ID,
  review_url: `https://airux.example/reviews/${REVIEW_ID}`,
  status: "draft",
  upload_expires_at: "2026-08-20T22:15:00.000Z",
  upload_url: "https://upload.videodelivery.net/token",
};

function responseJson(
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json", ...headers },
    status,
  });
}

describe("AiruxApiClient", () => {
  it("creates a review only at the configured origin with bearer auth", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        responseJson(assignment, 201),
    );
    const client = new AiruxApiClient(
      { agentToken: TOKEN, apiOrigin: "https://airux.example" },
      fetcher,
    );
    const signal = new AbortController().signal;

    await expect(client.createReview(createRequest, signal)).resolves.toEqual(
      assignment,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://airux.example/api/v1/agent/reviews");
    expect(init).toMatchObject({
      body: JSON.stringify(createRequest),
      method: "POST",
      redirect: "manual",
      signal: expect.any(AbortSignal),
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${TOKEN}`,
    );
  });

  it("gets agent-safe review status from the exact review route", async () => {
    const review = {
      claim: createRequest.claim,
      client_request_id: createRequest.client_request_id,
      created_at: "2026-08-20T22:00:00.000Z",
      criteria: createRequest.criteria,
      decision: null,
      evidence: {
        failure_code: null,
        id: EVIDENCE_ID,
        kind: "browser_video",
        media_type: "video/webm",
        size_bytes: 5,
        status: "ready",
      },
      expires_at: "2026-08-20T23:00:00.000Z",
      id: REVIEW_ID,
      resolved_at: null,
      review_url: assignment.review_url,
      status: "pending",
      submitted_at: "2026-08-20T22:00:10.000Z",
      title: createRequest.title,
      version: 1,
    };
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        responseJson({ review }),
    );
    const client = new AiruxApiClient(
      { agentToken: TOKEN, apiOrigin: "https://airux.example" },
      fetcher,
    );

    await expect(
      client.getReview(REVIEW_ID, new AbortController().signal),
    ).resolves.toEqual({ review });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe(
      `https://airux.example/api/v1/agent/reviews/${REVIEW_ID}`,
    );
  });

  it("surfaces retry metadata without exposing API details", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        responseJson(
          {
            error: { code: "rate_limited", message: `Never echo ${TOKEN}` },
            request_id: "req_45",
          },
          429,
          { "retry-after": "1" },
        ),
    );
    const client = new AiruxApiClient(
      { agentToken: TOKEN, apiOrigin: "https://airux.example" },
      fetcher,
    );

    let error: unknown;
    try {
      await client.createReview(createRequest, new AbortController().signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({
      code: "rate_limited",
      retryAfterMs: 1_000,
      retryable: true,
      status: 429,
    });
    expect(error).toBeInstanceOf(AiruxApiError);
    expect(String(error)).not.toContain(TOKEN);
  });

  it("does not follow a redirect that could receive the credential", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, {
          headers: { location: "https://evil.example/collect" },
          status: 307,
        }),
    );
    const client = new AiruxApiClient(
      { agentToken: TOKEN, apiOrigin: "https://airux.example" },
      fetcher,
    );

    await expect(
      client.createReview(createRequest, new AbortController().signal),
    ).rejects.toMatchObject({ retryable: false, status: 307 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
});
