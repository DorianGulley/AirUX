import { createPlaybackTokenResponseSchema } from "@airux/shared/v1";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/config.js";
import { handleReviewPlaybackToken } from "../src/review-playback.js";
import { TEST_ENV } from "./fixtures.js";

const CONFIG = loadConfig(TEST_ENV);
const REVIEWER = { id: "fa2a3aca-e4c6-40fe-bb92-e422f3350806" };
const EVIDENCE_ID = "347a6473-e510-4d6a-918f-b2bd56d942b7";
const REVIEW_ID = "8d4ddde8-b58f-4c2c-b37f-b3ea1fb312da";
const STREAM_VIDEO_ID = "private-stream-video";
const TOKEN = "header.payload.signature";

function fetcher(
  options: {
    evidence?: Record<string, unknown> | null;
    review?: Record<string, unknown> | null;
  } = {},
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/evidence") {
      return Response.json(
        options.evidence === null
          ? []
          : [
              {
                id: EVIDENCE_ID,
                review_id: REVIEW_ID,
                status: "ready",
                stream_video_id: STREAM_VIDEO_ID,
                ...options.evidence,
              },
            ],
      );
    }
    if (url.pathname === "/rest/v1/reviews") {
      return Response.json(
        options.review === null
          ? []
          : [
              {
                id: REVIEW_ID,
                user_id: REVIEWER.id,
                status: "pending",
                ...options.review,
              },
            ],
      );
    }
    return new Response(null, { status: 404 });
  });
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    fetcher: fetcher(),
    getStreamVideoDetails: vi.fn(async () => ({
      id: STREAM_VIDEO_ID,
      readyToStream: true,
      requireSignedURLs: true,
      hlsPlaybackUrl: `https://customer-example.cloudflarestream.com/${STREAM_VIDEO_ID}/manifest/video.m3u8`,
    })),
    createPlaybackToken: vi.fn(async () => ({
      token: TOKEN,
      expiresAt: "2026-08-20T08:15:00.000Z",
    })),
    ...overrides,
  };
}

describe("reviewer playback tokens", () => {
  it("issues a private player credential only after checking ownership", async () => {
    const setup = dependencies();
    const response = await handleReviewPlaybackToken(
      EVIDENCE_ID,
      REVIEWER,
      CONFIG,
      setup,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = createPlaybackTokenResponseSchema.parse(await response.json());
    expect(body).toEqual({
      playback: {
        token: TOKEN,
        player_url: `https://customer-example.cloudflarestream.com/${TOKEN}/iframe`,
        expires_at: "2026-08-20T08:15:00.000Z",
      },
    });
    expect(setup.getStreamVideoDetails).toHaveBeenCalledExactlyOnceWith(
      STREAM_VIDEO_ID,
    );
    expect(setup.createPlaybackToken).toHaveBeenCalledExactlyOnceWith(
      STREAM_VIDEO_ID,
      CONFIG,
      undefined,
    );

    const reviewRequest = setup.fetcher.mock.calls.find(([input]) =>
      String(input).includes("/rest/v1/reviews"),
    );
    const reviewUrl = new URL(String(reviewRequest?.[0]));
    expect(reviewUrl.searchParams.get("user_id")).toBe(`eq.${REVIEWER.id}`);
    expect(reviewUrl.searchParams.get("deleted_at")).toBe("is.null");
  });

  it.each([
    ["missing evidence", { evidence: null }],
    ["foreign Review", { review: null }],
    ["unready evidence", { evidence: { status: "processing" } }],
    ["cancelled Review", { review: { status: "cancelled" } }],
  ])("returns the same not-found response for %s", async (_name, state) => {
    const setup = dependencies({ fetcher: fetcher(state) });
    const response = await handleReviewPlaybackToken(
      EVIDENCE_ID,
      REVIEWER,
      CONFIG,
      setup,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: { code: "not_found", message: "Not found" },
    });
    expect(setup.getStreamVideoDetails).not.toHaveBeenCalled();
    expect(setup.createPlaybackToken).not.toHaveBeenCalled();
  });

  it("rejects malformed identifiers without querying private data", async () => {
    const setup = dependencies();
    const response = await handleReviewPlaybackToken(
      "not-an-evidence-id",
      REVIEWER,
      CONFIG,
      setup,
    );

    expect(response.status).toBe(404);
    expect(setup.fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {
      readyToStream: false,
      requireSignedURLs: true,
      hlsPlaybackUrl: `https://customer-example.cloudflarestream.com/${STREAM_VIDEO_ID}/manifest/video.m3u8`,
    },
    {
      readyToStream: true,
      requireSignedURLs: false,
      hlsPlaybackUrl: `https://customer-example.cloudflarestream.com/${STREAM_VIDEO_ID}/manifest/video.m3u8`,
    },
    {
      readyToStream: true,
      requireSignedURLs: true,
      hlsPlaybackUrl: `https://example.com/${STREAM_VIDEO_ID}/manifest/video.m3u8`,
    },
  ])("fails closed for unsafe Stream details", async (details) => {
    const setup = dependencies({
      getStreamVideoDetails: vi.fn(async () => ({
        id: STREAM_VIDEO_ID,
        ...details,
      })),
    });
    const response = await handleReviewPlaybackToken(
      EVIDENCE_ID,
      REVIEWER,
      CONFIG,
      setup,
    );

    expect(response.status).toBe(503);
    expect(setup.createPlaybackToken).not.toHaveBeenCalled();
  });
});
