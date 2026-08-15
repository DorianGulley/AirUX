import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import { TEST_ENV } from "./fixtures.js";

const CREDENTIAL_ID = "dc0fb4f8-652b-4e12-8899-e12c34afbcde";

describe("AirUX Worker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("passes the authenticated reviewer to credential listing", async () => {
    const reviewerId = "fa2a3aca-e4c6-40fe-bb92-e422f3350806";
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") {
        return Response.json({ id: reviewerId });
      }
      if (url.pathname === "/rest/v1/agent_credentials") {
        expect(url.searchParams.get("user_id")).toBe(`eq.${reviewerId}`);
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

  it("provides a no-op scheduled handler", () => {
    expect(worker.scheduled()).toBeUndefined();
  });

  it("fails closed without exposing invalid configuration", async () => {
    const response = worker.fetch(
      new Request("https://airux.app/api/v1/health"),
      { ...TEST_ENV, STREAM_API_TOKEN: "" },
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
