import {
  handleAgentCredentialCollection,
  handleAgentCredentialRevocation,
} from "./agent-credentials.js";
import { jsonResponse } from "./api-response.js";
import { type AiruxConfig, loadConfig } from "./config.js";
import { withAuthenticatedReviewer } from "./reviewer-auth.js";

const HEALTH_PATH = "/api/v1/health";
const CONFIG_PATH = "/api/v1/config";
const AGENT_CREDENTIALS_PATH = "/api/v1/agent-credentials";
const AGENT_CREDENTIAL_REVOKE_PATH =
  /^\/api\/v1\/agent-credentials\/([^/]+)\/revoke$/;
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
  fetch(request: Request, env: Env) {
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
