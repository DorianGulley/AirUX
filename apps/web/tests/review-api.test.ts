import { describe, expect, it, vi } from "vitest";

import {
  createReviewPlayback,
  getReviewerReview,
  ReviewApiError,
  submitReviewDecision,
} from "../src/review-api.js";

const ACCESS_TOKEN = "header.payload.signature";
const REVIEW_ID = "8d4ddde8-b58f-4c2c-b37f-b3ea1fb312da";
const EVIDENCE_ID = "347a6473-e510-4d6a-918f-b2bd56d942b7";
const PLAYBACK_TOKEN = "stream.token.signature";
const review = {
  id: REVIEW_ID,
  title: "Review the responsive layout",
  claim: "The navigation works at mobile width.",
  criteria: [{ id: "layout", prompt: "The navigation remains visible." }],
  status: "pending",
  version: 1,
  created_at: "2026-08-20T08:00:00.000Z",
  submitted_at: "2026-08-20T08:01:00.000Z",
  expires_at: "2026-08-23T08:01:00.000Z",
  resolved_at: null,
  evidence: {
    id: EVIDENCE_ID,
    kind: "browser_video",
    status: "ready",
    media_type: "video/webm",
    size_bytes: 1_024,
    duration_ms: 15_000,
    width: 1_280,
    height: 720,
    failure_code: null,
  },
  decision: null,
} as const;

describe("browser Review API", () => {
  it("loads the owned Review with the reviewer session", async () => {
    const fetcher = vi.fn(async () => Response.json({ review }));

    await expect(
      getReviewerReview(REVIEW_ID, ACCESS_TOKEN, fetcher),
    ).resolves.toEqual(review);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/reviews/${REVIEW_ID}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      },
    );
  });

  it("requests playback only for the selected Evidence", async () => {
    const playback = {
      token: PLAYBACK_TOKEN,
      player_url: `https://customer-example.cloudflarestream.com/${PLAYBACK_TOKEN}/iframe`,
      expires_at: "2026-08-20T08:15:00.000Z",
    };
    const fetcher = vi.fn(async () => Response.json({ playback }));

    await expect(
      createReviewPlayback(EVIDENCE_ID, ACCESS_TOKEN, fetcher),
    ).resolves.toEqual(playback);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/evidence/${EVIDENCE_ID}/playback-token`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      },
    );
  });

  it("submits the current Review version and returns the terminal Review", async () => {
    const decidedReview = {
      ...review,
      status: "approved",
      version: 2,
      resolved_at: "2026-08-20T08:02:00.000Z",
      decision: {
        outcome: "approved",
        comment: "Looks good.",
        created_at: "2026-08-20T08:02:00.000Z",
      },
    } as const;
    const fetcher = vi.fn(async () => Response.json({ review: decidedReview }));

    await expect(
      submitReviewDecision(
        REVIEW_ID,
        ACCESS_TOKEN,
        {
          expected_version: 1,
          outcome: "approved",
          comment: "  Looks good.  ",
        },
        fetcher,
      ),
    ).resolves.toEqual(decidedReview);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `/api/v1/reviews/${REVIEW_ID}/decision`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${ACCESS_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          expected_version: 1,
          outcome: "approved",
          comment: "Looks good.",
        }),
      },
    );
  });

  it("allows approval without an optional comment", async () => {
    const decidedReview = {
      ...review,
      status: "approved",
      version: 2,
      resolved_at: "2026-08-20T08:02:00.000Z",
      decision: {
        outcome: "approved",
        comment: null,
        created_at: "2026-08-20T08:02:00.000Z",
      },
    } as const;
    const fetcher = vi.fn(async () => Response.json({ review: decidedReview }));

    await expect(
      submitReviewDecision(
        REVIEW_ID,
        ACCESS_TOKEN,
        { expected_version: 1, outcome: "approved" },
        fetcher,
      ),
    ).resolves.toEqual(decidedReview);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ expected_version: 1, outcome: "approved" }),
    );
  });

  it("rejects a change request without actionable feedback before fetching", async () => {
    const fetcher = vi.fn();

    await expect(
      submitReviewDecision(
        REVIEW_ID,
        ACCESS_TOKEN,
        { expected_version: 1, outcome: "changes_requested" },
        fetcher,
      ),
    ).rejects.toEqual(new ReviewApiError());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves conflict status so the page can refresh stale Reviews", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        { error: { code: "conflict", message: "Review conflict" } },
        { status: 409 },
      ),
    );

    await expect(
      submitReviewDecision(
        REVIEW_ID,
        ACCESS_TOKEN,
        { expected_version: 1, outcome: "approved" },
        fetcher,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    ["invalid Review ID", () => getReviewerReview("rvw_invalid", ACCESS_TOKEN)],
    ["invalid access token", () => getReviewerReview(REVIEW_ID, "private")],
    [
      "unsafe playback URL",
      () =>
        createReviewPlayback(
          EVIDENCE_ID,
          ACCESS_TOKEN,
          vi.fn(async () =>
            Response.json({
              playback: {
                token: PLAYBACK_TOKEN,
                player_url: `https://example.com/${PLAYBACK_TOKEN}/iframe`,
                expires_at: "2026-08-20T08:15:00.000Z",
              },
            }),
          ),
        ),
    ],
    [
      "server rejection",
      () =>
        getReviewerReview(
          REVIEW_ID,
          ACCESS_TOKEN,
          vi.fn(async () => new Response("private", { status: 404 })),
        ),
    ],
    [
      "invalid Decision response",
      () =>
        submitReviewDecision(
          REVIEW_ID,
          ACCESS_TOKEN,
          { expected_version: 1, outcome: "approved" },
          vi.fn(async () =>
            Response.json({ review: { ...review, version: 2 } }),
          ),
        ),
    ],
  ])("fails closed for %s", async (_name, operation) => {
    await expect(operation()).rejects.toBeInstanceOf(ReviewApiError);
  });
});
