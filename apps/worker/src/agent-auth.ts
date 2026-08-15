import { agentCredentialTokenSchema } from "@airux/shared/v1";

import { hashAgentCredentialToken } from "./agent-credential-token.js";
import { jsonResponse } from "./api-response.js";
import { readJsonResponse } from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";

const DATA_RESPONSE_LIMIT = 16 * 1024;
const DUMMY_SECRET_HASH = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const SECRET_HASH_PATTERN = /^sha256:[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuthenticatedAgent {
  readonly credentialId: string;
  readonly userId: string;
}

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type AgentRouteHandler = (
  agent: AuthenticatedAgent,
) => Response | Promise<Response>;

interface CredentialAuthRow {
  readonly id: string;
  readonly userId: string;
  readonly secretHash: string;
}

class AgentAuthenticationRequiredError extends Error {}
class AgentAuthenticationServiceError extends Error {}

function readAgentCredential(request: Request) {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s,]+)$/i);
  const parsed = agentCredentialTokenSchema.safeParse(match?.[1]);

  if (!parsed.success) {
    throw new AgentAuthenticationRequiredError();
  }

  return parsed.data;
}

function credentialIdFromToken(token: string) {
  const credentialId = token.split(".", 3)[1];
  if (credentialId === undefined) {
    throw new AgentAuthenticationRequiredError();
  }
  return credentialId;
}

function dataApiHeaders(config: AiruxConfig) {
  return {
    accept: "application/json",
    apikey: config.supabase.secretKey,
  };
}

async function lookupCredential(
  credentialId: string,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  const url = new URL("/rest/v1/agent_credentials", config.supabase.url);
  url.searchParams.set("select", "id,user_id,secret_hash");
  url.searchParams.set("id", `eq.${credentialId}`);
  url.searchParams.set("revoked_at", "is.null");
  url.searchParams.set("limit", "1");

  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      headers: dataApiHeaders(config),
      redirect: "manual",
    });
  } catch {
    throw new AgentAuthenticationServiceError();
  }

  if (!response.ok) {
    throw new AgentAuthenticationServiceError();
  }

  let body: unknown;
  try {
    body = await readJsonResponse(response, DATA_RESPONSE_LIMIT);
  } catch {
    throw new AgentAuthenticationServiceError();
  }

  if (!Array.isArray(body) || body.length > 1) {
    throw new AgentAuthenticationServiceError();
  }

  const row = body[0];
  if (row === undefined) {
    return null;
  }
  if (typeof row !== "object" || row === null) {
    throw new AgentAuthenticationServiceError();
  }

  const record = row as Record<string, unknown>;
  if (
    record.id !== credentialId ||
    typeof record.user_id !== "string" ||
    !UUID_PATTERN.test(record.user_id) ||
    typeof record.secret_hash !== "string" ||
    !SECRET_HASH_PATTERN.test(record.secret_hash)
  ) {
    throw new AgentAuthenticationServiceError();
  }

  return {
    id: credentialId,
    userId: record.user_id,
    secretHash: record.secret_hash,
  } satisfies CredentialAuthRow;
}

async function secretHashesMatch(token: string, expectedHash: string) {
  const providedHash = await hashAgentCredentialToken(token);
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(
    encoder.encode(providedHash),
    encoder.encode(expectedHash),
  );
}

export async function authenticateAgent(
  request: Request,
  config: AiruxConfig,
  fetcher: Fetcher = fetch,
) {
  const token = readAgentCredential(request);
  const credentialId = credentialIdFromToken(token);
  const credential = await lookupCredential(credentialId, config, fetcher);
  const matches = await secretHashesMatch(
    token,
    credential?.secretHash ?? DUMMY_SECRET_HASH,
  );

  if (credential === null || !matches) {
    throw new AgentAuthenticationRequiredError();
  }

  return {
    credentialId: credential.id,
    userId: credential.userId,
  } satisfies AuthenticatedAgent;
}

export async function withAuthenticatedAgent(
  request: Request,
  config: AiruxConfig,
  handler: AgentRouteHandler,
  fetcher: Fetcher = fetch,
) {
  let agent: AuthenticatedAgent;

  try {
    agent = await authenticateAgent(request, config, fetcher);
  } catch (error) {
    if (error instanceof AgentAuthenticationRequiredError) {
      return jsonResponse(
        {
          error: {
            code: "authentication_required",
            message: "Authentication required",
          },
        },
        401,
        { "www-authenticate": 'Bearer realm="airux-agent"' },
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

  return handler(agent);
}
