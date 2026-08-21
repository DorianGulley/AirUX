import { REVIEW_STATES, type ReviewState } from "@airux/shared/v1";
import { describe, expect, it } from "vitest";

import { getReviewStatusLabel } from "../src/review-presentation.js";

const EXPECTED_LABELS = {
  draft: "Draft",
  pending: "Pending",
  approved: "Approved",
  changes_requested: "Changes requested",
  cancelled: "Cancelled",
  expired: "Expired",
} satisfies Record<ReviewState, string>;

describe("Review presentation", () => {
  it.each(REVIEW_STATES)("formats the %s status", (status) => {
    expect(getReviewStatusLabel(status)).toBe(EXPECTED_LABELS[status]);
  });
});
