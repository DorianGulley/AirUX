import { describe, expect, it } from "vitest";

import { apiErrorSchema } from "../../src/v1/api-error.js";

describe("apiErrorSchema", () => {
  it("accepts the standard error envelope", () => {
    const error = {
      error: {
        code: "invalid_request",
        message: "The request payload is invalid.",
        details: { field: "title" },
      },
      request_id: "req_123",
    };

    expect(apiErrorSchema.parse(error)).toEqual(error);
  });

  it("rejects undocumented error codes", () => {
    expect(
      apiErrorSchema.safeParse({
        error: { code: "bad_request", message: "Invalid request." },
      }).success,
    ).toBe(false);
  });

  it("rejects accidental data outside the envelope", () => {
    expect(
      apiErrorSchema.safeParse({
        error: { code: "not_found", message: "Not found." },
        stack: "private implementation detail",
      }).success,
    ).toBe(false);
  });
});
