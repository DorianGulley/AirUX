import { describe, expect, it } from "vitest";

import worker from "../src/index.js";
import { TEST_ENV } from "./fixtures.js";

describe("AirUX Worker", () => {
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
