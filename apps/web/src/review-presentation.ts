import type { ReviewState } from "@airux/shared/v1";

const REVIEW_STATUS_LABELS = {
  draft: "Draft",
  pending: "Pending",
  approved: "Approved",
  changes_requested: "Changes requested",
  cancelled: "Cancelled",
  expired: "Expired",
} satisfies Record<ReviewState, string>;

export function getReviewStatusLabel(status: ReviewState) {
  return REVIEW_STATUS_LABELS[status];
}
