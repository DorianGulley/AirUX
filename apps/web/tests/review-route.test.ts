import { describe, expect, it } from "vitest";

import { matchReviewRoute } from "../src/review-route.js";

describe("Review route", () => {
  it.each([
    ["/reviews/rvw_abc123", "rvw_abc123"],
    ["/reviews/rvw_abc123/", "rvw_abc123"],
    ["/reviews/review%20id", "review id"],
  ])("matches %s", (pathname, reviewId) => {
    expect(matchReviewRoute(pathname)).toEqual({ reviewId });
  });

  it.each([
    "/",
    "/reviews",
    "/reviews/",
    "/reviews/id/evidence",
    "/reviews/%2F",
    "/reviews/%E0%A4%A",
  ])("does not match %s", (pathname) => {
    expect(matchReviewRoute(pathname)).toBeNull();
  });
});
