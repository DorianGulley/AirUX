import { describe, expect, it, vi } from "vitest";

import { AiruxApiError } from "../src/api-client.js";
import {
  CancelReviewWorkflowError,
  cancelAiruxReview,
} from "../src/cancel-review.js";

const REVIEW_ID = "20000000-0000-4000-8000-000000000045";
const OTHER_REVIEW_ID = "20000000-0000-4000-8000-000000000046";
const REVIEW_URL = `https://airux.example/reviews/${REVIEW_ID}`;

function cancellationResponse(
  evidenceStatus: "ready" | "deleting" | "deleted" = "deleting",
) {
  return {
    review: {
      id: REVIEW_ID,
      review_url: REVIEW_URL,
      client_request_id: "agent-run-45",
      title: "Review the flow",
      claim: "The flow works.",
      criteria: [{ id: "works", prompt: "The flow completes." }],
      status: "cancelled" as const,
      version: 2,
      created_at: "2026-08-20T22:00:00.000Z",
      submitted_at: "2026-08-20T22:00:10.000Z",
      expires_at: "2026-08-23T22:00:00.000Z",
      resolved_at: "2026-08-20T22:10:00.000Z",
      evidence: {
        id: "30000000-0000-4000-8000-000000000045",
        kind: "browser_video" as const,
        status: evidenceStatus,
        media_type: "video/webm",
        size_bytes: 5,
        failure_code: null,
      },
      decision: null,
    },
  };
}

describe("cancelAiruxReview", () => {
  it("cancels the Review after its Evidence is scheduled for deletion", async () => {
    const api = {
      cancelReview: vi.fn(async () => cancellationResponse()),
    };
    const signal = new AbortController().signal;

    await expect(
      cancelAiruxReview({ review_id: REVIEW_ID }, { api }, signal),
    ).resolves.toEqual({
      review_id: REVIEW_ID,
      review_url: REVIEW_URL,
      status: "cancelled",
    });
    expect(api.cancelReview).toHaveBeenCalledExactlyOnceWith(REVIEW_ID, signal);
  });

  it("accepts an idempotent retry after Evidence has been deleted", async () => {
    const api = {
      cancelReview: vi.fn(async () => cancellationResponse("deleted")),
    };

    await expect(
      cancelAiruxReview({ review_id: REVIEW_ID }, { api }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("retries a transient cancellation with the same Review identifier", async () => {
    const api = {
      cancelReview: vi
        .fn()
        .mockRejectedValueOnce(
          new AiruxApiError("offline", {
            retryAfterMs: 1_000,
            retryable: true,
          }),
        )
        .mockResolvedValueOnce(cancellationResponse()),
    };
    const sleep = vi.fn(
      async (_durationMs: number, _signal: AbortSignal) => {},
    );

    await cancelAiruxReview({ review_id: REVIEW_ID }, { api, sleep });

    expect(api.cancelReview).toHaveBeenCalledTimes(2);
    expect(api.cancelReview.mock.calls.map(([reviewId]) => reviewId)).toEqual([
      REVIEW_ID,
      REVIEW_ID,
    ]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(
      1_000,
      expect.any(AbortSignal),
    );
  });

  it("rejects unexpected input without calling AirUX", async () => {
    const api = { cancelReview: vi.fn() };

    await expect(
      cancelAiruxReview({ review_id: REVIEW_ID, force: true }, { api }),
    ).rejects.toBeInstanceOf(CancelReviewWorkflowError);
    expect(api.cancelReview).not.toHaveBeenCalled();
  });

  it("fails closed when AirUX returns the wrong Review or live Evidence", async () => {
    const wrongReviewApi = {
      cancelReview: vi.fn(async () => ({
        ...cancellationResponse(),
        review: {
          ...cancellationResponse().review,
          id: OTHER_REVIEW_ID,
        },
      })),
    };
    await expect(
      cancelAiruxReview({ review_id: REVIEW_ID }, { api: wrongReviewApi }),
    ).rejects.toBeInstanceOf(CancelReviewWorkflowError);

    const liveEvidenceApi = {
      cancelReview: vi.fn(async () => cancellationResponse("ready")),
    };
    await expect(
      cancelAiruxReview({ review_id: REVIEW_ID }, { api: liveEvidenceApi }),
    ).rejects.toBeInstanceOf(CancelReviewWorkflowError);
  });
});
