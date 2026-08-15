import { describe, expect, it } from "vitest";

import {
  agentCredentialSchema,
  agentCredentialTokenSchema,
  createAgentCredentialRequestSchema,
  createAgentCredentialResponseSchema,
  listAgentCredentialsResponseSchema,
} from "../../src/v1/index.js";

const credential = {
  id: "dc0fb4f8-652b-4e12-8899-e12c34afbcde",
  name: "Codex on laptop",
  created_at: "2026-08-15T08:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
};
const token =
  "airux_agent_v1.dc0fb4f8-652b-4e12-8899-e12c34afbcde.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("agent credential contracts", () => {
  it("accepts a trimmed credential name and rejects unknown fields", () => {
    expect(
      createAgentCredentialRequestSchema.parse({ name: "  Codex  " }),
    ).toEqual({ name: "Codex" });
    expect(
      createAgentCredentialRequestSchema.safeParse({
        name: "Codex",
        user_id: credential.id,
      }).success,
    ).toBe(false);
  });

  it("accepts only the versioned 256-bit credential format", () => {
    expect(agentCredentialTokenSchema.parse(token)).toBe(token);
    expect(agentCredentialTokenSchema.safeParse(`${token}extra`).success).toBe(
      false,
    );
    expect(
      agentCredentialTokenSchema.safeParse(
        token.replace("airux_agent_v1", "airux_agent_v2"),
      ).success,
    ).toBe(false);
  });

  it("never includes a token or hash in listed credential metadata", () => {
    expect(agentCredentialSchema.parse(credential)).toEqual(credential);
    expect(
      agentCredentialSchema.safeParse({ ...credential, secret_hash: "private" })
        .success,
    ).toBe(false);
    expect(
      listAgentCredentialsResponseSchema.parse({ credentials: [credential] }),
    ).toEqual({ credentials: [credential] });
  });

  it("includes the plaintext token only in the create response", () => {
    expect(
      createAgentCredentialResponseSchema.parse({ credential, token }),
    ).toEqual({ credential, token });
  });

  it("requires canonical UTC timestamps", () => {
    expect(
      agentCredentialSchema.safeParse({
        ...credential,
        created_at: "2026-08-15T01:00:00-07:00",
      }).success,
    ).toBe(false);
  });
});
