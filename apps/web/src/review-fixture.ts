import type { ReviewerReview } from "@airux/shared/v1";

export type ReviewFixtureMode = "ready" | "loading" | "error";

const REVIEW_FIXTURE = {
  id: "7ae0f2a3-bcf2-4a0a-8af4-bb6b9f13c96f",
  title: "Verify the redesigned onboarding flow",
  claim:
    "The onboarding flow now guides new users through workspace setup on desktop and mobile.",
  criteria: [
    {
      id: "mobile-layout",
      prompt: "The flow remains clear and unclipped on a mobile viewport.",
    },
    {
      id: "progression",
      prompt: "Each step has an obvious action and advances without confusion.",
    },
  ],
  status: "pending",
  version: 1,
  created_at: "2026-08-20T18:23:00.000Z",
  submitted_at: "2026-08-20T18:24:08.000Z",
  expires_at: "2026-08-23T18:24:08.000Z",
  resolved_at: null,
  evidence: {
    id: "5485f52d-b75d-48c1-8d7f-cab6293e7176",
    kind: "browser_video",
    status: "ready",
    media_type: "video/webm",
    size_bytes: 8_421_316,
    duration_ms: 24_000,
    width: 1440,
    height: 900,
    failure_code: null,
  },
  decision: null,
} satisfies ReviewerReview;

export function getReviewFixtureMode(
  searchParams: URLSearchParams,
): ReviewFixtureMode {
  const requestedMode = searchParams.get("fixture");
  if (requestedMode === "loading" || requestedMode === "error") {
    return requestedMode;
  }
  return "ready";
}

export function loadReviewFixture(
  reviewId: string,
  mode: ReviewFixtureMode,
): Promise<ReviewerReview> {
  if (mode === "loading") {
    return new Promise(() => undefined);
  }

  if (mode === "error") {
    return Promise.reject(new Error("Fixture review unavailable"));
  }

  return Promise.resolve({ ...REVIEW_FIXTURE, id: reviewId });
}
