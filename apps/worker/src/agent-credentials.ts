import {
  type AgentCredential,
  agentCredentialSchema,
  createAgentCredentialRequestSchema,
  createAgentCredentialResponseSchema,
  listAgentCredentialsResponseSchema,
  revokeAgentCredentialResponseSchema,
} from "@airux/shared/v1";

import { issueAgentCredential } from "./agent-credential-token.js";
import { jsonResponse } from "./api-response.js";
import {
  InvalidJsonBodyError,
  readJsonRequest,
  readJsonResponse,
} from "./bounded-json.js";
import type { AiruxConfig } from "./config.js";
import type { AuthenticatedReviewer } from "./reviewer-auth.js";

const DATA_RESPONSE_LIMIT = 1024 * 1024;
const CREDENTIAL_COLUMNS = "id,name,created_at,last_used_at,revoked_at";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

class CredentialNotFoundError extends Error {}
class CredentialServiceError extends Error {}

function dataApiUrl(config: AiruxConfig) {
  return new URL("/rest/v1/agent_credentials", config.supabase.url);
}

function dataApiHeaders(config: AiruxConfig, prefer?: string) {
  const headers = new Headers({
    accept: "application/json",
    apikey: config.supabase.secretKey,
    "content-type": "application/json",
  });
  if (prefer !== undefined) {
    headers.set("prefer", prefer);
  }
  return headers;
}

async function fetchData(url: URL, init: RequestInit, fetcher: Fetcher) {
  try {
    return await fetcher(url, { ...init, redirect: "manual" });
  } catch {
    throw new CredentialServiceError();
  }
}

function normalizeTimestamp(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? null : timestamp.toISOString();
}

function normalizeCredential(value: unknown): AgentCredential | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const row = value as Record<string, unknown>;
  const createdAt = normalizeTimestamp(row.created_at);
  const lastUsedAt =
    row.last_used_at === null ? null : normalizeTimestamp(row.last_used_at);
  const revokedAt =
    row.revoked_at === null ? null : normalizeTimestamp(row.revoked_at);

  if (
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    createdAt === null ||
    (row.last_used_at !== null && lastUsedAt === null) ||
    (row.revoked_at !== null && revokedAt === null)
  ) {
    return null;
  }

  const result = agentCredentialSchema.safeParse({
    id: row.id,
    name: row.name,
    created_at: createdAt,
    last_used_at: lastUsedAt,
    revoked_at: revokedAt,
  });
  return result.success ? result.data : null;
}

async function readCredentialRows(response: Response) {
  const body = await readJsonResponse(response, DATA_RESPONSE_LIMIT);
  if (!Array.isArray(body)) {
    throw new CredentialServiceError();
  }

  const credentials = body.map(normalizeCredential);
  if (credentials.some((credential) => credential === null)) {
    throw new CredentialServiceError();
  }
  return credentials as AgentCredential[];
}

async function createCredential(
  request: Request,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  const parsedRequest = createAgentCredentialRequestSchema.safeParse(
    await readJsonRequest(request),
  );
  if (!parsedRequest.success) {
    throw new InvalidJsonBodyError();
  }

  const issued = await issueAgentCredential();
  const url = dataApiUrl(config);
  url.searchParams.set("select", CREDENTIAL_COLUMNS);
  const response = await fetchData(
    url,
    {
      method: "POST",
      headers: dataApiHeaders(config, "return=representation"),
      body: JSON.stringify({
        id: issued.id,
        user_id: reviewer.id,
        name: parsedRequest.data.name,
        secret_hash: issued.secretHash,
      }),
    },
    fetcher,
  );
  if (!response.ok) {
    throw new CredentialServiceError();
  }

  const rows = await readCredentialRows(response);
  const credential = rows[0];
  if (
    rows.length !== 1 ||
    credential === undefined ||
    credential.id !== issued.id
  ) {
    throw new CredentialServiceError();
  }

  return jsonResponse(
    createAgentCredentialResponseSchema.parse({
      credential,
      token: issued.token,
    }),
    201,
  );
}

async function listCredentials(
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  const url = dataApiUrl(config);
  url.searchParams.set("select", CREDENTIAL_COLUMNS);
  url.searchParams.set("user_id", `eq.${reviewer.id}`);
  url.searchParams.set("order", "created_at.desc");
  const response = await fetchData(
    url,
    { method: "GET", headers: dataApiHeaders(config) },
    fetcher,
  );
  if (!response.ok) {
    throw new CredentialServiceError();
  }

  return jsonResponse(
    listAgentCredentialsResponseSchema.parse({
      credentials: await readCredentialRows(response),
    }),
  );
}

async function findCredential(
  credentialId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  const url = dataApiUrl(config);
  url.searchParams.set("select", CREDENTIAL_COLUMNS);
  url.searchParams.set("id", `eq.${credentialId}`);
  url.searchParams.set("user_id", `eq.${reviewer.id}`);
  url.searchParams.set("limit", "1");
  const response = await fetchData(
    url,
    { method: "GET", headers: dataApiHeaders(config) },
    fetcher,
  );
  if (!response.ok) {
    throw new CredentialServiceError();
  }

  const rows = await readCredentialRows(response);
  const credential = rows[0];
  if (credential === undefined) {
    throw new CredentialNotFoundError();
  }
  return credential;
}

async function revokeCredential(
  credentialId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher,
) {
  if (!UUID_PATTERN.test(credentialId)) {
    throw new CredentialNotFoundError();
  }

  const url = dataApiUrl(config);
  url.searchParams.set("select", CREDENTIAL_COLUMNS);
  url.searchParams.set("id", `eq.${credentialId}`);
  url.searchParams.set("user_id", `eq.${reviewer.id}`);
  url.searchParams.set("revoked_at", "is.null");
  const response = await fetchData(
    url,
    {
      method: "PATCH",
      headers: dataApiHeaders(config, "return=representation"),
      body: JSON.stringify({ revoked_at: new Date().toISOString() }),
    },
    fetcher,
  );
  if (!response.ok) {
    throw new CredentialServiceError();
  }

  const rows = await readCredentialRows(response);
  const credential = rows[0];
  const resolved =
    credential ??
    (await findCredential(credentialId, reviewer, config, fetcher));
  return jsonResponse(
    revokeAgentCredentialResponseSchema.parse({ credential: resolved }),
  );
}

function errorResponse(error: unknown) {
  if (error instanceof InvalidJsonBodyError) {
    return jsonResponse(
      { error: { code: "invalid_request", message: "Invalid request" } },
      400,
    );
  }
  if (error instanceof CredentialNotFoundError) {
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

export async function handleAgentCredentialCollection(
  request: Request,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher = fetch,
) {
  try {
    if (request.method === "POST") {
      return await createCredential(request, reviewer, config, fetcher);
    }
    return await listCredentials(reviewer, config, fetcher);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function handleAgentCredentialRevocation(
  credentialId: string,
  reviewer: AuthenticatedReviewer,
  config: AiruxConfig,
  fetcher: Fetcher = fetch,
) {
  try {
    return await revokeCredential(credentialId, reviewer, config, fetcher);
  } catch (error) {
    return errorResponse(error);
  }
}
