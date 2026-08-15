import { timingSafeEqual } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  authenticateAgent,
  withAuthenticatedAgent,
} from "../src/agent-auth.js";
import { hashAgentCredentialToken } from "../src/agent-credential-token.js";
import { loadConfig } from "../src/config.js";
import { TEST_ENV } from "./fixtures.js";

const TEST_CONFIG = loadConfig(TEST_ENV);
const CREDENTIAL_ID = "dc0fb4f8-652b-4e12-8899-e12c34afbcde";
const USER_ID = "fa2a3aca-e4c6-40fe-bb92-e422f3350806";
const TOKEN = `airux_agent_v1.${CREDENTIAL_ID}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;
const OTHER_CREDENTIAL_ID = "eb2d9347-652c-43ba-8e8c-81ac9a17d909";
const OTHER_USER_ID = "80d9eb26-8495-4f07-9ad1-88c36829ff75";
const OTHER_TOKEN = `airux_agent_v1.${OTHER_CREDENTIAL_ID}.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;

function agentRequest(authorization?: string) {
  return new Request("https://airux.example/api/v1/agent/reviews", {
    headers: authorization === undefined ? undefined : { authorization },
  });
}

function installTimingSafeEqual() {
  Object.defineProperty(crypto.subtle, "timingSafeEqual", {
    configurable: true,
    value: (left: ArrayBufferView, right: ArrayBufferView) =>
      timingSafeEqual(
        Buffer.from(left.buffer, left.byteOffset, left.byteLength),
        Buffer.from(right.buffer, right.byteOffset, right.byteLength),
      ),
  });
}

function removeTimingSafeEqual() {
  Reflect.deleteProperty(crypto.subtle, "timingSafeEqual");
}

async function credentialResponse(
  secretHash?: string,
  credentialId = CREDENTIAL_ID,
  userId = USER_ID,
) {
  const resolvedSecretHash =
    secretHash ?? (await hashAgentCredentialToken(TOKEN));
  return Response.json([
    {
      id: credentialId,
      user_id: userId,
      secret_hash: resolvedSecretHash,
    },
  ]);
}

beforeAll(installTimingSafeEqual);
afterAll(removeTimingSafeEqual);

describe("agent authentication", () => {
  it("authenticates an active credential and exposes only its owner identity", async () => {
    const fetcher = vi.fn(async () => credentialResponse());

    await expect(
      authenticateAgent(agentRequest(`Bearer ${TOKEN}`), TEST_CONFIG, fetcher),
    ).resolves.toEqual({ credentialId: CREDENTIAL_ID, userId: USER_ID });

    expect(fetcher).toHaveBeenCalledOnce();
    const [input, init] = fetcher.mock.calls[0] ?? [];
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(url.origin).toBe("https://example.supabase.co");
    expect(url.pathname).toBe("/rest/v1/agent_credentials");
    expect(url.searchParams.get("select")).toBe("id,user_id,secret_hash");
    expect(url.searchParams.get("id")).toBe(`eq.${CREDENTIAL_ID}`);
    expect(url.searchParams.get("revoked_at")).toBe("is.null");
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(headers.get("apikey")).toBe(TEST_ENV.SUPABASE_SECRET_KEY);
    expect(headers.has("authorization")).toBe(false);
    expect(String(input)).not.toContain(TOKEN);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(TOKEN);
  });

  it.each([
    ["missing", undefined],
    ["wrong scheme", `Basic ${TOKEN}`],
    ["reviewer JWT", "Bearer header.payload.signature"],
    ["multiple values", `Bearer ${TOKEN}, Bearer ${TOKEN}`],
    [
      "wrong version",
      `Bearer ${TOKEN.replace("airux_agent_v1", "airux_agent_v2")}`,
    ],
    ["short secret", `Bearer ${TOKEN.slice(0, -1)}`],
  ])(
    "rejects a %s authorization header before querying the database",
    async (_name, authorization) => {
      const fetcher = vi.fn();
      const handler = vi.fn(() => new Response());

      const response = await withAuthenticatedAgent(
        agentRequest(authorization),
        TEST_CONFIG,
        handler,
        fetcher,
      );

      expect(fetcher).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="airux-agent"',
      );
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "authentication_required",
          message: "Authentication required",
        },
      });
    },
  );

  it.each([
    ["unknown", async () => Response.json([])],
    ["revoked", async () => Response.json([])],
    [
      "mismatched",
      async () =>
        credentialResponse(
          "sha256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        ),
    ],
  ])(
    "returns the same response for an %s credential",
    async (_name, fetcher) => {
      const handler = vi.fn(() => new Response());
      const response = await withAuthenticatedAgent(
        agentRequest(`Bearer ${TOKEN}`),
        TEST_CONFIG,
        handler,
        fetcher,
      );

      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "authentication_required",
          message: "Authentication required",
        },
      });
    },
  );

  it("passes the fixed agent identity to an authorized route handler", async () => {
    const handler = vi.fn((agent) => Response.json(agent));
    const response = await withAuthenticatedAgent(
      agentRequest(`Bearer ${TOKEN}`),
      TEST_CONFIG,
      handler,
      vi.fn(async () => credentialResponse()),
    );

    expect(handler).toHaveBeenCalledExactlyOnceWith({
      credentialId: CREDENTIAL_ID,
      userId: USER_ID,
    });
    await expect(response.json()).resolves.toEqual({
      credentialId: CREDENTIAL_ID,
      userId: USER_ID,
    });
  });

  it("does not let one credential secret authenticate as another credential", async () => {
    const otherSecretHash = await hashAgentCredentialToken(OTHER_TOKEN);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const id = new URL(String(input)).searchParams
        .get("id")
        ?.replace(/^eq\./, "");
      if (id === CREDENTIAL_ID) {
        return credentialResponse();
      }
      if (id === OTHER_CREDENTIAL_ID) {
        return credentialResponse(
          otherSecretHash,
          OTHER_CREDENTIAL_ID,
          OTHER_USER_ID,
        );
      }
      return Response.json([]);
    });

    await expect(
      authenticateAgent(
        agentRequest(`Bearer ${OTHER_TOKEN}`),
        TEST_CONFIG,
        fetcher,
      ),
    ).resolves.toEqual({
      credentialId: OTHER_CREDENTIAL_ID,
      userId: OTHER_USER_ID,
    });

    const splicedToken = `airux_agent_v1.${CREDENTIAL_ID}.BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;
    const handler = vi.fn(() => new Response());
    const response = await withAuthenticatedAgent(
      agentRequest(`Bearer ${splicedToken}`),
      TEST_CONFIG,
      handler,
      fetcher,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "authentication_required",
        message: "Authentication required",
      },
    });
  });

  it.each([
    [
      "provider error",
      async () => new Response("private detail", { status: 500 }),
    ],
    [
      "provider redirect",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.example" },
        }),
    ],
    ["network error", async () => Promise.reject(new Error("private detail"))],
    ["invalid JSON", async () => new Response("not JSON")],
    ["invalid row", async () => Response.json([{ id: CREDENTIAL_ID }])],
    ["duplicate rows", async () => Response.json([{}, {}])],
  ])("fails closed for a %s", async (_name, fetcher) => {
    const handler = vi.fn(() => new Response());
    const response = await withAuthenticatedAgent(
      agentRequest(`Bearer ${TOKEN}`),
      TEST_CONFIG,
      handler,
      fetcher,
    );

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "internal_error",
        message: "Service unavailable",
      },
    });
  });
});
