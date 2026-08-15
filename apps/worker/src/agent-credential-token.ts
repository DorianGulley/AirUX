import { agentCredentialTokenSchema } from "@airux/shared/v1";

const TOKEN_PREFIX = "airux_agent_v1";
const SECRET_BYTE_LENGTH = 32;
const HASH_PREFIX = "sha256:";

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function hashAgentCredentialToken(token: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return `${HASH_PREFIX}${encodeBase64Url(new Uint8Array(digest))}`;
}

export async function issueAgentCredential() {
  const id = crypto.randomUUID();
  const secret = crypto.getRandomValues(new Uint8Array(SECRET_BYTE_LENGTH));
  const token = `${TOKEN_PREFIX}.${id}.${encodeBase64Url(secret)}`;
  const validatedToken = agentCredentialTokenSchema.parse(token);

  return {
    id,
    token: validatedToken,
    secretHash: await hashAgentCredentialToken(validatedToken),
  };
}
