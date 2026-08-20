import { agentCredentialTokenSchema } from "@airux/shared/v1";

import { jsonResponse } from "./api-response.js";
import { readJsonResponse } from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";

const ACCESS_TOKEN_MAX_LENGTH = 8_192;
const ACCESS_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const AUTH_RESPONSE_LIMIT = 16 * 1024;
const REVIEWER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthenticatedReviewer {
  readonly id: string;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type ReviewerRouteHandler = (
  reviewer: AuthenticatedReviewer,
) => Response | Promise<Response>;

class AuthenticationRequiredError extends Error {}
class AuthenticationServiceError extends Error {}

function readAccessToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s,]+)$/i);
  const token = match?.[1];

  if (
    token === undefined ||
    token.length > ACCESS_TOKEN_MAX_LENGTH ||
    !ACCESS_TOKEN_PATTERN.test(token) ||
    agentCredentialTokenSchema.safeParse(token).success
  ) {
    throw new AuthenticationRequiredError();
  }

  return token;
}

async function requestAuthenticatedReviewer(
  token: string,
  config: AiruxConfig,
  fetcher: Fetcher,
): Promise<AuthenticatedReviewer> {
  let response: Response;

  try {
    response = await fetcher(`${config.supabase.url}/auth/v1/user`, {
      method: "GET",
      headers: {
        accept: "application/json",
        apikey: config.supabase.publishableKey,
        authorization: `Bearer ${token}`,
      },
      redirect: "manual",
    });
  } catch {
    throw new AuthenticationServiceError();
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthenticationRequiredError();
  }

  if (!response.ok) {
    throw new AuthenticationServiceError();
  }

  let body: unknown;

  try {
    body = await readJsonResponse(response, AUTH_RESPONSE_LIMIT);
  } catch {
    throw new AuthenticationServiceError();
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !("id" in body) ||
    typeof body.id !== "string" ||
    !REVIEWER_ID_PATTERN.test(body.id)
  ) {
    throw new AuthenticationServiceError();
  }

  if (
    !("app_metadata" in body) ||
    typeof body.app_metadata !== "object" ||
    body.app_metadata === null ||
    !("provider" in body.app_metadata) ||
    body.app_metadata.provider !== "github"
  ) {
    throw new AuthenticationRequiredError();
  }

  return { id: body.id };
}

export async function authenticateReviewer(
  request: Request,
  config: AiruxConfig,
  fetcher: Fetcher = fetch,
) {
  const token = readAccessToken(request);
  return requestAuthenticatedReviewer(token, config, fetcher);
}

export async function withAuthenticatedReviewer(
  request: Request,
  config: AiruxConfig,
  handler: ReviewerRouteHandler,
  fetcher: Fetcher = fetch,
) {
  let reviewer: AuthenticatedReviewer;

  try {
    reviewer = await authenticateReviewer(request, config, fetcher);
  } catch (error) {
    if (error instanceof AuthenticationRequiredError) {
      return jsonResponse(
        {
          error: {
            code: "authentication_required",
            message: "Authentication required",
          },
        },
        401,
        { "www-authenticate": 'Bearer realm="airux"' },
      );
    }

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

  return handler(reviewer);
}
