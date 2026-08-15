import { describe, expect, it, vi } from "vitest";

import {
  CredentialApiError,
  createAgentCredential,
  listAgentCredentials,
  revokeAgentCredential,
} from "../src/credential-api.js";

const ACCESS_TOKEN = "header.payload.signature";
const CREDENTIAL_ID = "dc0fb4f8-652b-4e12-8899-e12c34afbcde";
const credential = {
  id: CREDENTIAL_ID,
  name: "Codex on laptop",
  created_at: "2026-08-15T08:00:00.000Z",
  last_used_at: null,
  revoked_at: null,
};
const token =
  "airux_agent_v1.dc0fb4f8-652b-4e12-8899-e12c34afbcde.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("browser credential API", () => {
  it("creates a trimmed credential using the reviewer session", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ credential, token }, { status: 201 }),
    );

    await expect(
      createAgentCredential("  Codex on laptop  ", ACCESS_TOKEN, fetcher),
    ).resolves.toEqual({ credential, token });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/agent-credentials", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ACCESS_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Codex on laptop" }),
    });
  });

  it("lists credential metadata without expecting plaintext secrets", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ credentials: [credential] }),
    );

    await expect(listAgentCredentials(ACCESS_TOKEN, fetcher)).resolves.toEqual({
      credentials: [credential],
    });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/agent-credentials", {
      method: "GET",
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
  });

  it("revokes the selected credential", async () => {
    const revoked = { ...credential, revoked_at: "2026-08-15T09:00:00.000Z" };
    const fetcher = vi.fn(async () => Response.json({ credential: revoked }));

    await expect(
      revokeAgentCredential(CREDENTIAL_ID, ACCESS_TOKEN, fetcher),
    ).resolves.toEqual({ credential: revoked });
    expect(fetcher).toHaveBeenCalledWith(
      `/api/v1/agent-credentials/${CREDENTIAL_ID}/revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
      },
    );
  });

  it("rejects invalid names before sending a request", async () => {
    const fetcher = vi.fn();
    await expect(
      createAgentCredential("  ", ACCESS_TOKEN, fetcher),
    ).rejects.toBeInstanceOf(CredentialApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["server rejection", new Response("private detail", { status: 503 })],
    [
      "invalid response",
      Response.json({ credentials: [{ ...credential, token }] }),
    ],
  ])("does not expose a %s", async (_name, response) => {
    await expect(
      listAgentCredentials(
        ACCESS_TOKEN,
        vi.fn(async () => response),
      ),
    ).rejects.toEqual(new CredentialApiError());
  });
});
