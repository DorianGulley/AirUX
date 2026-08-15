import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { withAuthenticatedReviewer } from "../src/reviewer-auth.js";
import { TEST_ENV } from "./fixtures.js";

const TEST_CONFIG = loadConfig(TEST_ENV);
const TEST_TOKEN = "header.payload.signature";
const TEST_REVIEWER_ID = "dc0fb4f8-652b-4e12-8899-e12c34afbcde";

function reviewerRequest(authorization?: string) {
  return new Request("https://airux.example/api/v1/reviews/rvw_123", {
    headers: authorization === undefined ? undefined : { authorization },
  });
}

function validUserResponse() {
  return Response.json({
    id: TEST_REVIEWER_ID,
    email: "private@example.com",
    user_metadata: { user_name: "private-profile" },
  });
}

describe("reviewer session validation", () => {
  it("validates a Bearer token with Supabase and exposes only the reviewer id", async () => {
    const fetcher = vi.fn(async () => validUserResponse());
    const handler = vi.fn(async (reviewer: { readonly id: string }) =>
      Response.json(reviewer),
    );

    const response = await withAuthenticatedReviewer(
      reviewerRequest(`Bearer ${TEST_TOKEN}`),
      TEST_CONFIG,
      handler,
      fetcher,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith(
      "https://example.supabase.co/auth/v1/user",
      {
        method: "GET",
        headers: {
          accept: "application/json",
          apikey: TEST_ENV.SUPABASE_PUBLISHABLE_KEY,
          authorization: `Bearer ${TEST_TOKEN}`,
        },
        redirect: "error",
      },
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(
      TEST_ENV.SUPABASE_SECRET_KEY,
    );
    expect(handler).toHaveBeenCalledExactlyOnceWith({ id: TEST_REVIEWER_ID });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: TEST_REVIEWER_ID });
  });

  it.each([
    ["missing", undefined],
    ["wrong scheme", `Basic ${TEST_TOKEN}`],
    ["missing token", "Bearer"],
    ["multiple values", `Bearer ${TEST_TOKEN}, Bearer ${TEST_TOKEN}`],
    ["not a JWT", "Bearer opaque-token"],
    ["oversized", `Bearer header.${"a".repeat(8_192)}.signature`],
  ])(
    "rejects a %s authorization header without calling Supabase",
    async (_name, authorization) => {
      const fetcher = vi.fn(async () => validUserResponse());
      const handler = vi.fn(() => new Response());

      const response = await withAuthenticatedReviewer(
        reviewerRequest(authorization),
        TEST_CONFIG,
        handler,
        fetcher,
      );

      expect(fetcher).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="airux"',
      );
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "authentication_required",
          message: "Authentication required",
        },
      });
    },
  );

  it.each([401, 403])(
    "returns the same authentication response for Supabase HTTP %i",
    async (status) => {
      const providerBody = `provider detail for ${TEST_TOKEN}`;
      const handler = vi.fn(() => new Response());
      const response = await withAuthenticatedReviewer(
        reviewerRequest(`bearer ${TEST_TOKEN}`),
        TEST_CONFIG,
        handler,
        vi.fn(async () => new Response(providerBody, { status })),
      );

      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      expect(await response.text()).toBe(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: "Authentication required",
          },
        }),
      );
    },
  );

  it.each([
    [
      "provider error",
      async () => new Response("private detail", { status: 500 }),
    ],
    ["network error", async () => Promise.reject(new Error("private detail"))],
    ["invalid JSON", async () => new Response("not JSON")],
    ["invalid user", async () => Response.json({ id: "not-a-uuid" })],
  ])("fails closed for a %s", async (_name, fetcher) => {
    const handler = vi.fn(() => new Response());
    const response = await withAuthenticatedReviewer(
      reviewerRequest(`Bearer ${TEST_TOKEN}`),
      TEST_CONFIG,
      handler,
      fetcher,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "internal_error",
        message: "Service unavailable",
      },
    });
  });
});
