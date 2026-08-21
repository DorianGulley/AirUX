import { describe, expect, it, vi } from "vitest";

import {
  ListOpenReviewsWorkflowError,
  listAiruxOpenReviews,
} from "../src/list-open-reviews.js";

const REVIEW_ID = "20000000-0000-4000-8000-000000000045";
const summary = {
  id: REVIEW_ID,
  review_url: `https://airux.example/reviews/${REVIEW_ID}`,
  client_request_id: "agent-run-45",
  title: "Review the flow",
  status: "pending" as const,
  version: 1,
  created_at: "2026-08-20T22:00:00.000Z",
  expires_at: "2026-08-23T22:00:00.000Z",
};

describe("listAiruxOpenReviews", () => {
  it("returns the credential-scoped open Reviews for recovery", async () => {
    const api = {
      listOpenReviews: vi.fn(async () => ({ reviews: [summary] })),
    };
    const signal = new AbortController().signal;

    await expect(listAiruxOpenReviews({}, { api }, signal)).resolves.toEqual({
      reviews: [summary],
    });
    expect(api.listOpenReviews).toHaveBeenCalledExactlyOnceWith(signal);
  });

  it("preserves an empty open Review list", async () => {
    const api = { listOpenReviews: vi.fn(async () => ({ reviews: [] })) };

    await expect(listAiruxOpenReviews({}, { api })).resolves.toEqual({
      reviews: [],
    });
  });

  it("rejects unexpected input without calling AirUX", async () => {
    const api = { listOpenReviews: vi.fn() };

    await expect(
      listAiruxOpenReviews({ user_id: "another-user" }, { api }),
    ).rejects.toBeInstanceOf(ListOpenReviewsWorkflowError);
    expect(api.listOpenReviews).not.toHaveBeenCalled();
  });

  it("sanitizes API and contract failures behind a workflow error", async () => {
    const apiFailure = {
      listOpenReviews: vi.fn(async () => {
        throw new Error("secret-provider-detail");
      }),
    };
    await expect(
      listAiruxOpenReviews({}, { api: apiFailure }),
    ).rejects.toMatchObject({
      name: "ListOpenReviewsWorkflowError",
      message: "The open AirUX Reviews could not be retrieved",
    });

    const malformedApi = {
      listOpenReviews: vi.fn(async () => ({
        reviews: [{ ...summary, status: "approved" as const }],
      })),
    };
    await expect(
      listAiruxOpenReviews({}, { api: malformedApi }),
    ).rejects.toBeInstanceOf(ListOpenReviewsWorkflowError);
  });
});
