import type {
  AgentCredential,
  CreateAgentCredentialResponse,
  ListAgentCredentialsResponse,
  RevokeAgentCredentialResponse,
} from "@airux/shared/v1";

const CREDENTIAL_NAME_MAX_LENGTH = 200;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN =
  /^airux_agent_v1\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

type Fetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class CredentialApiError extends Error {}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => key in value);
}

function isUtcTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.endsWith("Z") &&
    !Number.isNaN(new Date(value).getTime())
  );
}

function parseCredential(value: unknown): AgentCredential | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value as Record<string, unknown>, [
      "id",
      "name",
      "created_at",
      "last_used_at",
      "revoked_at",
    ])
  ) {
    return null;
  }

  const row = value as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    !UUID_PATTERN.test(row.id) ||
    typeof row.name !== "string" ||
    row.name.trim() !== row.name ||
    row.name.length < 1 ||
    row.name.length > CREDENTIAL_NAME_MAX_LENGTH ||
    !isUtcTimestamp(row.created_at) ||
    (row.last_used_at !== null && !isUtcTimestamp(row.last_used_at)) ||
    (row.revoked_at !== null && !isUtcTimestamp(row.revoked_at))
  ) {
    return null;
  }

  return {
    id: row.id,
    name: row.name,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    revoked_at: row.revoked_at,
  };
}

async function readResponse(response: Response) {
  if (!response.ok) {
    throw new CredentialApiError();
  }

  try {
    return await response.json();
  } catch {
    throw new CredentialApiError();
  }
}

function authorizationHeaders(accessToken: string) {
  return { authorization: `Bearer ${accessToken}` };
}

export async function createAgentCredential(
  name: string,
  accessToken: string,
  fetcher: Fetcher = fetch,
): Promise<CreateAgentCredentialResponse> {
  const trimmedName = name.trim();
  if (
    trimmedName.length < 1 ||
    trimmedName.length > CREDENTIAL_NAME_MAX_LENGTH
  ) {
    throw new CredentialApiError();
  }

  const response = await fetcher("/api/v1/agent-credentials", {
    method: "POST",
    headers: {
      ...authorizationHeaders(accessToken),
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: trimmedName }),
  });
  const body = await readResponse(response);
  if (
    typeof body !== "object" ||
    body === null ||
    !hasExactKeys(body as Record<string, unknown>, ["credential", "token"])
  ) {
    throw new CredentialApiError();
  }

  const record = body as Record<string, unknown>;
  const credential = parseCredential(record.credential);
  if (
    credential === null ||
    typeof record.token !== "string" ||
    !TOKEN_PATTERN.test(record.token)
  ) {
    throw new CredentialApiError();
  }
  return { credential, token: record.token };
}

export async function listAgentCredentials(
  accessToken: string,
  fetcher: Fetcher = fetch,
): Promise<ListAgentCredentialsResponse> {
  const response = await fetcher("/api/v1/agent-credentials", {
    method: "GET",
    headers: authorizationHeaders(accessToken),
  });
  const body = await readResponse(response);
  if (
    typeof body !== "object" ||
    body === null ||
    !hasExactKeys(body as Record<string, unknown>, ["credentials"])
  ) {
    throw new CredentialApiError();
  }

  const values = (body as Record<string, unknown>).credentials;
  if (!Array.isArray(values)) {
    throw new CredentialApiError();
  }
  const credentials = values.map(parseCredential);
  if (credentials.some((credential) => credential === null)) {
    throw new CredentialApiError();
  }
  return { credentials: credentials as AgentCredential[] };
}

export async function revokeAgentCredential(
  credentialId: string,
  accessToken: string,
  fetcher: Fetcher = fetch,
): Promise<RevokeAgentCredentialResponse> {
  if (!UUID_PATTERN.test(credentialId)) {
    throw new CredentialApiError();
  }

  const response = await fetcher(
    `/api/v1/agent-credentials/${encodeURIComponent(credentialId)}/revoke`,
    {
      method: "POST",
      headers: authorizationHeaders(accessToken),
    },
  );
  const body = await readResponse(response);
  if (
    typeof body !== "object" ||
    body === null ||
    !hasExactKeys(body as Record<string, unknown>, ["credential"])
  ) {
    throw new CredentialApiError();
  }
  const credential = parseCredential(
    (body as Record<string, unknown>).credential,
  );
  if (credential === null) {
    throw new CredentialApiError();
  }
  return { credential };
}
