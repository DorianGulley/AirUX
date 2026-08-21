import { createPlaybackTokenResponseSchema } from "@airux/shared/v1";

import { jsonResponse } from "./api-response.js";
import { readJsonResponse } from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";
import type { AuthenticatedReviewer } from "./reviewer-auth.js";
import { createStreamPlaybackToken } from "./stream-playback-token.js";

const DATA_RESPONSE_LIMIT = 1024 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PLAYBACK_REVIEW_STATES = new Set([
  "pending",
  "approved",
  "changes_requested",
]);

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface StreamVideoDetails {
  readonly id: string;
  readonly readyToStream: boolean;
  readonly requireSignedURLs: boolean | null;
  readonly hlsPlaybackUrl: string;
}

export interface ReviewPlaybackDependencies {
  readonly getStreamVideoDetails: (
    streamVideoId: string,
  ) => Promise<StreamVideoDetails>;
  readonly createPlaybackToken?: typeof createStreamPlaybackToken;
  readonly fetcher?: Fetcher;
  readonly now?: Date;
}

class ReviewPlaybackNotFoundError extends Error {}
class ReviewPlaybackServiceError extends Error {}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function dataApiHeaders(config: AiruxConfig) {
  return {
    accept: "application/json",
    apikey: config.supabase.secretKey,
    "content-type": "application/json",
  };
}

function dataApiUrl(config: AiruxConfig, path: string) {
  return new URL(`/rest/v1/${path}`, config.supabase.url);
}

async function getSingleRow(url: URL, config: AiruxConfig, fetcher: Fetcher) {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: dataApiHeaders(config),
      redirect: "manual",
    });
  } catch {
    throw new ReviewPlaybackServiceError();
  }
  if (!response.ok) {
    throw new ReviewPlaybackServiceError();
  }

  let body: unknown;
  try {
    body = await readJsonResponse(response, DATA_RESPONSE_LIMIT);
  } catch {
    throw new ReviewPlaybackServiceError();
  }
  if (!Array.isArray(body) || body.length > 1) {
    throw new ReviewPlaybackServiceError();
  }
  return body[0] ?? null;
}

function streamPlayerOrigin(
  details: StreamVideoDetails,
  streamVideoId: string,
) {
  if (
    details.id !== streamVideoId ||
    !details.readyToStream ||
    details.requireSignedURLs !== true
  ) {
    throw new ReviewPlaybackServiceError();
  }

  let url: URL;
  try {
    url = new URL(details.hlsPlaybackUrl);
  } catch {
    throw new ReviewPlaybackServiceError();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    !/^customer-[a-z0-9]+\.cloudflarestream\.com$/.test(url.hostname) ||
    url.pathname !== `/${streamVideoId}/manifest/video.m3u8` ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ReviewPlaybackServiceError();
  }
  return url.origin;
}

async function getPlaybackSource(
  evidenceId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  if (!UUID_PATTERN.test(evidenceId)) {
    throw new ReviewPlaybackNotFoundError();
  }

  const evidenceUrl = dataApiUrl(config, "evidence");
  evidenceUrl.searchParams.set("select", "id,review_id,status,stream_video_id");
  evidenceUrl.searchParams.set("id", `eq.${evidenceId}`);
  evidenceUrl.searchParams.set("limit", "1");
  const evidence = asRecord(await getSingleRow(evidenceUrl, config, fetcher));
  if (
    evidence === null ||
    evidence.id !== evidenceId ||
    typeof evidence.review_id !== "string" ||
    evidence.status !== "ready" ||
    typeof evidence.stream_video_id !== "string"
  ) {
    throw new ReviewPlaybackNotFoundError();
  }

  const reviewUrl = dataApiUrl(config, "reviews");
  reviewUrl.searchParams.set("select", "id,user_id,status");
  reviewUrl.searchParams.set("id", `eq.${evidence.review_id}`);
  reviewUrl.searchParams.set("user_id", `eq.${reviewer.id}`);
  reviewUrl.searchParams.set("deleted_at", "is.null");
  reviewUrl.searchParams.set("limit", "1");
  const review = asRecord(await getSingleRow(reviewUrl, config, fetcher));
  if (
    review === null ||
    review.id !== evidence.review_id ||
    review.user_id !== reviewer.id ||
    typeof review.status !== "string" ||
    !PLAYBACK_REVIEW_STATES.has(review.status)
  ) {
    throw new ReviewPlaybackNotFoundError();
  }

  return evidence.stream_video_id;
}

function errorResponse(error: unknown) {
  if (error instanceof ReviewPlaybackNotFoundError) {
    return jsonResponse(
      { error: { code: "not_found", message: "Not found" } },
      404,
    );
  }
  return jsonResponse(
    { error: { code: "internal_error", message: "Service unavailable" } },
    503,
  );
}

export async function handleReviewPlaybackToken(
  evidenceId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  dependencies: ReviewPlaybackDependencies,
) {
  try {
    const streamVideoId = await getPlaybackSource(
      evidenceId,
      reviewer,
      config,
      dependencies.fetcher ?? fetch,
    );
    const details = await dependencies.getStreamVideoDetails(streamVideoId);
    const origin = streamPlayerOrigin(details, streamVideoId);
    const playback = await (
      dependencies.createPlaybackToken ?? createStreamPlaybackToken
    )(streamVideoId, config, dependencies.now);
    return jsonResponse(
      createPlaybackTokenResponseSchema.parse({
        playback: {
          token: playback.token,
          player_url: `${origin}/${playback.token}/iframe`,
          expires_at: playback.expiresAt,
        },
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}
