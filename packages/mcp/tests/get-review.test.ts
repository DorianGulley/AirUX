import { describe, expect, it, vi } from "vitest";

import { AiruxApiError } from "../src/api-client.js";
import { GetReviewWorkflowError, getAiruxReview } from "../src/get-review.js";

const REVIEW_ID = "20000000-0000-4000-8000-000000000045";
const OTHER_REVIEW_ID = "20000000-0000-4000-8000-000000000046";
const REVIEW_URL = `https://airux.example/reviews/${REVIEW_ID}`;

function review(
  status:
    | "draft"
    | "pending"
    | "approved"
    | "changes_requested"
    | "cancelled"
    | "expired",
) {
  const decision =
    status === "approved" || status === "changes_requested"
      ? {
          outcome: status,
          comment:
            status === "changes_requested"
              ? "The menu overlaps the heading."
              : null,
          created_at: "2026-08-20T08:02:00.000Z",
        }
      : null;
  const terminal = status !== "draft" && status !== "pending";
  return {
    id: REVIEW_ID,
    review_url: REVIEW_URL,
    client_request_id: "agent-run-45",
    title: "Review the flow",
    claim: "The flow works.",
    criteria: [{ id: "works", prompt: "The flow completes." }],
    status,
    version: terminal ? 2 : 1,
    created_at: "2026-08-20T08:00:00.000Z",
    submitted_at: status === "draft" ? null : "2026-08-20T08:01:00.000Z",
    expires_at: "2026-08-23T08:01:00.000Z",
    resolved_at: terminal ? "2026-08-20T08:02:00.000Z" : null,
    evidence: {
      id: "30000000-0000-4000-8000-000000000045",
      kind: "browser_video" as const,
      status: status === "draft" ? ("processing" as const) : ("ready" as const),
      media_type: "video/webm",
      size_bytes: 5,
      failure_code: null,
    },
    decision,
  };
}

describe("getAiruxReview", () => {
  it("polls locally until approval using increasing intervals and server guidance", async () => {
    const api = {
      getReviewForPolling: vi
        .fn()
        .mockResolvedValueOnce({
          review: review("pending"),
          retryAfterMs: 5_000,
        })
        .mockResolvedValueOnce({ review: review("pending") })
        .mockResolvedValueOnce({ review: review("approved") }),
    };
    const sleep = vi.fn(
      async (_durationMs: number, _signal: AbortSignal) => {},
    );

    await expect(
      getAiruxReview({ review_id: REVIEW_ID }, { api, sleep }),
    ).resolves.toEqual({
      review_id: REVIEW_ID,
      review_url: REVIEW_URL,
      status: "approved",
      decision: {
        outcome: "approved",
        comment: null,
        created_at: "2026-08-20T08:02:00.000Z",
      },
    });
    expect(sleep.mock.calls.map(([duration]) => duration)).toEqual([
      5_000, 4_000,
    ]);
    expect(api.getReviewForPolling).toHaveBeenCalledTimes(3);
    expect(api.getReviewForPolling).toHaveBeenCalledWith(
      REVIEW_ID,
      expect.any(AbortSignal),
    );
  });

  it("retries transient API failures and honors their retry guidance", async () => {
    const api = {
      getReviewForPolling: vi
        .fn()
        .mockRejectedValueOnce(
          new AiruxApiError("rate limited", {
            retryAfterMs: 6_000,
            retryable: true,
            status: 429,
          }),
        )
        .mockResolvedValueOnce({ review: review("changes_requested") }),
    };
    const sleep = vi.fn(
      async (_durationMs: number, _signal: AbortSignal) => {},
    );

    await expect(
      getAiruxReview({ review_id: REVIEW_ID }, { api, sleep }),
    ).resolves.toMatchObject({
      status: "changes_requested",
      decision: { comment: "The menu overlaps the heading." },
    });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(
      6_000,
      expect.any(AbortSignal),
    );
  });

  it("returns cancellation immediately without fabricating a Decision", async () => {
    const api = {
      getReviewForPolling: vi.fn(async () => ({ review: review("cancelled") })),
    };
    const sleep = vi.fn();

    await expect(
      getAiruxReview({ review_id: REVIEW_ID }, { api, sleep }),
    ).resolves.toMatchObject({ status: "cancelled", decision: null });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails closed for non-retryable responses and mismatched Reviews", async () => {
    const rejectedApi = {
      getReviewForPolling: vi.fn(async () => {
        throw new AiruxApiError("not found", {
          retryable: false,
          status: 404,
        });
      }),
    };
    await expect(
      getAiruxReview({ review_id: REVIEW_ID }, { api: rejectedApi }),
    ).rejects.toBeInstanceOf(GetReviewWorkflowError);

    const mismatchedApi = {
      getReviewForPolling: vi.fn(async () => ({
        review: { ...review("approved"), id: OTHER_REVIEW_ID },
      })),
    };
    await expect(
      getAiruxReview({ review_id: REVIEW_ID }, { api: mismatchedApi }),
    ).rejects.toBeInstanceOf(GetReviewWorkflowError);
  });

  it("stops promptly when the MCP request is cancelled", async () => {
    const controller = new AbortController();
    const api = {
      getReviewForPolling: vi.fn(async () => ({ review: review("pending") })),
    };
    const sleep = vi.fn(async (_duration: number, signal: AbortSignal) => {
      controller.abort();
      throw signal.reason;
    });

    await expect(
      getAiruxReview(
        { review_id: REVIEW_ID },
        { api, sleep },
        controller.signal,
      ),
    ).rejects.toMatchObject({
      name: "GetReviewWorkflowError",
      message: "Review polling was interrupted",
    });
    expect(api.getReviewForPolling).toHaveBeenCalledOnce();
  });
});
