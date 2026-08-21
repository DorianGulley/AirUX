import { describe, expect, it, vi } from "vitest";

import {
  createReviewPlayback,
  getReviewerReview,
  ReviewApiError,
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
  ])("fails closed for %s", async (_name, operation) => {
    await expect(operation()).rejects.toEqual(new ReviewApiError());
  });
});
