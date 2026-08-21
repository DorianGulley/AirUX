import { describe, expect, it } from "vitest";

import {
  getReviewFixtureMode,
  loadReviewFixture,
} from "../src/review-fixture.js";

describe("Review fixtures", () => {
  it("uses live data unless an explicit fixture is selected", () => {
    expect(getReviewFixtureMode(new URLSearchParams())).toBeNull();
    expect(getReviewFixtureMode(new URLSearchParams("fixture=unknown"))).toBe(
      null,
    );
  });

  it.each(["ready", "loading", "error"] as const)(
    "selects the %s fixture state",
    (mode) => {
      expect(getReviewFixtureMode(new URLSearchParams(`fixture=${mode}`))).toBe(
        mode,
      );
    },
  );

  it("loads a contract-shaped ready fixture for the requested route", async () => {
    const review = await loadReviewFixture("rvw_requested", "ready");

    expect(review.id).toBe("rvw_requested");
    expect(review.status).toBe("pending");
    expect(review.evidence.status).toBe("ready");
    expect(review.criteria).toHaveLength(2);
  });

  it("rejects the error fixture", async () => {
    await expect(loadReviewFixture("rvw_error", "error")).rejects.toThrow(
      "Fixture review unavailable",
    );
  });

  it("keeps the loading fixture pending", async () => {
    const state = await Promise.race([
      loadReviewFixture("rvw_loading", "loading").then(() => "settled"),
      Promise.resolve("pending"),
    ]);

    expect(state).toBe("pending");
  });
});
