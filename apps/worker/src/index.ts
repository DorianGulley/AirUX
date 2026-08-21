import { withAuthenticatedAgent } from "./agent-auth.js";
import {
  handleAgentCredentialCollection,
  handleAgentCredentialRevocation,
} from "./agent-credentials.js";
import {
  handleAgentReviewCancellation,
  handleAgentReviewCollection,
  handleAgentReviewGet,
} from "./agent-reviews.js";
import { jsonResponse } from "./api-response.js";
import { type AiruxConfig, loadConfig } from "./config.js";
import { handleReviewPlaybackToken } from "./review-playback.js";
import { withAuthenticatedReviewer } from "./reviewer-auth.js";
import {
  handleReviewerReviewDecision,
  handleReviewerReviewGet,
} from "./reviewer-reviews.js";
import { handleStreamWebhook } from "./stream-webhook.js";

const HEALTH_PATH = "/api/v1/health";
const CONFIG_PATH = "/api/v1/config";
const AGENT_CREDENTIALS_PATH = "/api/v1/agent-credentials";
const AGENT_CREDENTIAL_REVOKE_PATH =
  /^\/api\/v1\/agent-credentials\/([^/]+)\/revoke$/;
const AGENT_REVIEWS_PATH = "/api/v1/agent/reviews";
const AGENT_REVIEW_PATH = /^\/api\/v1\/agent\/reviews\/([^/]+)$/;
const AGENT_REVIEW_CANCEL_PATH = /^\/api\/v1\/agent\/reviews\/([^/]+)\/cancel$/;
const REVIEWER_REVIEW_PATH = /^\/api\/v1\/reviews\/([^/]+)$/;
const REVIEWER_REVIEW_DECISION_PATH = /^\/api\/v1\/reviews\/([^/]+)\/decision$/;
const REVIEWER_PLAYBACK_TOKEN_PATH =
  /^\/api\/v1\/evidence\/([^/]+)\/playback-token$/;
const STREAM_WEBHOOK_PATH = "/api/v1/webhooks/cloudflare-stream";
const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

function rateLimitErrorResponse(status: 429 | 503) {
  if (status === 429) {
    return jsonResponse(
      {
        error: {
          code: "rate_limited",
          message: "Too many requests",
        },
      },
      status,
      { "retry-after": String(RATE_LIMIT_RETRY_AFTER_SECONDS) },
    );
  }

  return jsonResponse(
    {
      error: {
        code: "internal_error",
        message: "Service unavailable",
      },
    },
    status,
  );
}

async function enforceRateLimit(limiter: RateLimit, key: string) {
  try {
    const { success } = await limiter.limit({ key });
    return success ? null : rateLimitErrorResponse(429);
  } catch {
    return rateLimitErrorResponse(503);
  }
}

function reviewerRequestRateLimitKey(request: Request) {
  return `reviewer-ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
}

async function withReviewerRequestRateLimit(
  request: Request,
  env: Env,
  handler: () => Response | Promise<Response>,
) {
  const response = await enforceRateLimit(
    env.REVIEWER_AUTH_RATE_LIMITER,
    reviewerRequestRateLimitKey(request),
  );
  return response ?? handler();
}

const worker = {
  fetch(request: Request, env: Env, context?: ExecutionContext) {
    let config: AiruxConfig;

    try {
      config = loadConfig(env);
    } catch {
      return jsonResponse(
        {
          error: {
            code: "internal_error",
            message: "Service unavailable",
          },
        },
        503,
      );
    }

    const { pathname } = new URL(request.url);

    if (pathname === HEALTH_PATH) {
      if (request.method !== "GET") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET" },
        );
      }

      return jsonResponse({ status: "ok" });
    }

    if (pathname === CONFIG_PATH) {
      if (request.method !== "GET") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET" },
        );
      }

      return jsonResponse({
        supabase: {
          url: config.supabase.url,
          publishable_key: config.supabase.publishableKey,
        },
      });
    }

    if (pathname === STREAM_WEBHOOK_PATH) {
      if (request.method !== "POST") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "POST" },
        );
      }

      return handleStreamWebhook(request, config);
    }

    if (pathname === AGENT_CREDENTIALS_PATH) {
      if (request.method !== "GET" && request.method !== "POST") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET, POST" },
        );
      }

      return withReviewerRequestRateLimit(request, env, () =>
        withAuthenticatedReviewer(request, config, async (reviewer) => {
          if (request.method === "POST") {
            const response = await enforceRateLimit(
              env.CREDENTIAL_CREATE_RATE_LIMITER,
              `reviewer:${reviewer.id}`,
            );
            if (response !== null) {
              return response;
            }
          }

          return handleAgentCredentialCollection(request, reviewer, config);
        }),
      );
    }

    const revokeMatch = pathname.match(AGENT_CREDENTIAL_REVOKE_PATH);
    if (revokeMatch !== null) {
      if (request.method !== "POST") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "POST" },
        );
      }

      const credentialId = revokeMatch[1];
      if (credentialId === undefined) {
        return jsonResponse(
          { error: { code: "not_found", message: "Not found" } },
          404,
        );
      }

      return withReviewerRequestRateLimit(request, env, () =>
        withAuthenticatedReviewer(request, config, (reviewer) =>
          handleAgentCredentialRevocation(credentialId, reviewer, config),
        ),
      );
    }

    if (pathname === AGENT_REVIEWS_PATH) {
      if (request.method !== "GET" && request.method !== "POST") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET, POST" },
        );
      }

      return withAuthenticatedAgent(request, config, (agent) =>
        handleAgentReviewCollection(request, agent, config, {
          stream: {
            createDirectUpload: (params) =>
              env.STREAM.createDirectUpload(params),
            deleteVideo: (id) => env.STREAM.video(id).delete(),
          },
          ...(context === undefined
            ? {}
            : {
                waitUntil: (promise: Promise<unknown>) =>
                  context.waitUntil(promise),
              }),
        }),
      );
    }

    const cancelReviewMatch = pathname.match(AGENT_REVIEW_CANCEL_PATH);
    if (cancelReviewMatch !== null) {
      if (request.method !== "POST") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "POST" },
        );
      }
      const reviewId = cancelReviewMatch[1];
      if (reviewId === undefined) {
        return jsonResponse(
          { error: { code: "not_found", message: "Not found" } },
          404,
        );
      }
      return withAuthenticatedAgent(request, config, (agent) =>
        handleAgentReviewCancellation(reviewId, agent, config, {}),
      );
    }

    const reviewMatch = pathname.match(AGENT_REVIEW_PATH);
    if (reviewMatch !== null) {
      if (request.method !== "GET") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET" },
        );
      }
      const reviewId = reviewMatch[1];
      if (reviewId === undefined) {
        return jsonResponse(
          { error: { code: "not_found", message: "Not found" } },
          404,
        );
      }
      return withAuthenticatedAgent(request, config, (agent) =>
        handleAgentReviewGet(reviewId, agent, config, {}),
      );
    }

    const reviewerDecisionMatch = pathname.match(REVIEWER_REVIEW_DECISION_PATH);
    if (reviewerDecisionMatch !== null) {
      if (request.method !== "POST") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "POST" },
        );
      }
      const reviewId = reviewerDecisionMatch[1];
      if (reviewId === undefined) {
        return jsonResponse(
          { error: { code: "not_found", message: "Not found" } },
          404,
        );
      }
      return withReviewerRequestRateLimit(request, env, () =>
        withAuthenticatedReviewer(request, config, (reviewer) =>
          handleReviewerReviewDecision(request, reviewId, reviewer, config),
        ),
      );
    }

    const playbackTokenMatch = pathname.match(REVIEWER_PLAYBACK_TOKEN_PATH);
    if (playbackTokenMatch !== null) {
      if (request.method !== "POST") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "POST" },
        );
      }
      const evidenceId = playbackTokenMatch[1];
      if (evidenceId === undefined) {
        return jsonResponse(
          { error: { code: "not_found", message: "Not found" } },
          404,
        );
      }
      return withReviewerRequestRateLimit(request, env, () =>
        withAuthenticatedReviewer(request, config, (reviewer) =>
          handleReviewPlaybackToken(evidenceId, reviewer, config, {
            getStreamVideoDetails: (streamVideoId) =>
              env.STREAM.video(streamVideoId).details(),
          }),
        ),
      );
    }

    const reviewerReviewMatch = pathname.match(REVIEWER_REVIEW_PATH);
    if (reviewerReviewMatch !== null) {
      if (request.method !== "GET") {
        return jsonResponse(
          {
            error: {
              code: "invalid_request",
              message: "Method not allowed",
            },
          },
          405,
          { allow: "GET" },
        );
      }
      const reviewId = reviewerReviewMatch[1];
      if (reviewId === undefined) {
        return jsonResponse(
          { error: { code: "not_found", message: "Not found" } },
          404,
        );
      }
      return withReviewerRequestRateLimit(request, env, () =>
        withAuthenticatedReviewer(request, config, (reviewer) =>
          handleReviewerReviewGet(reviewId, reviewer, config),
        ),
      );
    }

    return jsonResponse(
      {
        error: {
          code: "not_found",
          message: "Not found",
        },
      },
      404,
    );
  },

  scheduled() {
    // Cleanup work is introduced in M6-5.
  },
} satisfies ExportedHandler<Env>;

export default worker;
