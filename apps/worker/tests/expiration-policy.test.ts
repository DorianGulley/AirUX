import { describe, expect, it } from "vitest";

import {
  calculateExpiration,
  EXPIRATION_POLICY,
  ExpirationPolicyError,
} from "../src/expiration-policy.js";

describe("expiration policy", () => {
  const now = new Date("2026-08-20T08:00:00.000Z");

  it("defines the MVP expiry windows in one place", () => {
    expect(EXPIRATION_POLICY).toEqual({
      uploadUrlMs: 15 * 60 * 1_000,
      draftReviewMs: 60 * 60 * 1_000,
      pendingReviewMs: 72 * 60 * 60 * 1_000,
      resolvedEvidenceMs: 7 * 24 * 60 * 60 * 1_000,
      playbackTokenSeconds: 15 * 60,
    });
  });

  it("calculates an exact UTC expiration without mutating the clock", () => {
    expect(calculateExpiration(now, EXPIRATION_POLICY.pendingReviewMs)).toBe(
      "2026-08-23T08:00:00.000Z",
    );
    expect(now.toISOString()).toBe("2026-08-20T08:00:00.000Z");
  });

  it.each([
    [new Date(Number.NaN), EXPIRATION_POLICY.draftReviewMs],
    [now, 0],
    [now, Number.POSITIVE_INFINITY],
  ])("rejects an invalid clock or lifetime", (clock, lifetime) => {
    expect(() => calculateExpiration(clock, lifetime)).toThrow(
      ExpirationPolicyError,
    );
  });
});
