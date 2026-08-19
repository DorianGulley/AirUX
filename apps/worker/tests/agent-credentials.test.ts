import { describe, expect, it, vi } from "vitest";

import { hashAgentCredentialToken } from "../src/agent-credential-token.js";
import {
  handleAgentCredentialCollection,
  handleAgentCredentialRevocation,
} from "../src/agent-credentials.js";
import { loadConfig } from "../src/config.js";
import { TEST_ENV } from "./fixtures.js";

const TEST_CONFIG = loadConfig(TEST_ENV);
const REVIEWER = { id: "fa2a3aca-e4c6-40fe-bb92-e422f3350806" };
const CREDENTIAL_ID = "dc0fb4f8-652b-4e12-8899-e12c34afbcde";
const OTHER_REVIEWER_ID = "eb2d9347-652c-43ba-8e8c-81ac9a17d909";

function credentialRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CREDENTIAL_ID,
    user_id: REVIEWER.id,
    name: "Codex on laptop",
    created_at: "2026-08-15T08:00:00+00:00",
    last_used_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function createRequest(body: unknown, contentType = "application/json") {
  return new Request("https://airux.example/api/v1/agent-credentials", {
    method: "POST",
    headers: { "content-type": contentType },
    body: JSON.stringify(body),
  });
}

describe("agent credential lifecycle", () => {
  it("creates a credential while storing only its owner-scoped hash", async () => {
    let storedBody: Record<string, unknown> | undefined;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        storedBody = JSON.parse(String(init?.body));
        return Response.json(
          [
            credentialRow({
              id: storedBody?.id,
              name: storedBody?.name,
            }),
          ],
          { status: 201 },
        );
      },
    );

    const response = await handleAgentCredentialCollection(
      createRequest({ name: "  Codex on laptop  " }),
      REVIEWER,
      TEST_CONFIG,
      fetcher,
    );
    const body = (await response.json()) as {
      credential: { id: string; name: string };
      token: string;
    };

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.credential.name).toBe("Codex on laptop");
    expect(body.token).toMatch(
      new RegExp(
        `^airux_agent_v1\\.${body.credential.id}\\.[A-Za-z0-9_-]{43}$`,
      ),
    );
    expect(storedBody).toEqual({
      id: body.credential.id,
      user_id: REVIEWER.id,
      name: "Codex on laptop",
      secret_hash: await hashAgentCredentialToken(body.token),
    });

    const [input, init] = fetcher.mock.calls[0] ?? [];
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    expect(url.origin).toBe("https://example.supabase.co");
    expect(url.pathname).toBe("/rest/v1/agent_credentials");
    expect(url.searchParams.get("select")).toBe(
      "id,user_id,name,created_at,last_used_at,revoked_at",
    );
    expect(headers.get("apikey")).toBe(TEST_ENV.SUPABASE_SECRET_KEY);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.get("prefer")).toBe("return=representation");
    expect(JSON.stringify(body)).not.toContain(String(storedBody?.secret_hash));
    expect(JSON.stringify(body)).not.toContain(TEST_ENV.SUPABASE_SECRET_KEY);
  });

  it("lists only credentials filtered to the authenticated owner", async () => {
    const fetcher = vi.fn(async () =>
      Response.json([
        credentialRow(),
        credentialRow({
          id: "3c405a77-d1bf-4351-9417-84596a4f98b0",
          name: "Claude remote",
          last_used_at: "2026-08-15T09:00:00+00:00",
        }),
      ]),
    );

    const response = await handleAgentCredentialCollection(
      new Request("https://airux.example/api/v1/agent-credentials"),
      REVIEWER,
      TEST_CONFIG,
      fetcher,
    );

    expect(response.status).toBe(200);
    const [input] = fetcher.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.searchParams.get("user_id")).toBe(`eq.${REVIEWER.id}`);
    expect(url.searchParams.get("order")).toBe("created_at.desc");
    await expect(response.json()).resolves.toEqual({
      credentials: [
        {
          id: CREDENTIAL_ID,
          name: "Codex on laptop",
          created_at: "2026-08-15T08:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
        },
        {
          id: "3c405a77-d1bf-4351-9417-84596a4f98b0",
          name: "Claude remote",
          created_at: "2026-08-15T08:00:00.000Z",
          last_used_at: "2026-08-15T09:00:00.000Z",
          revoked_at: null,
        },
      ],
    });
  });

  it("fails closed if a credential response belongs to another reviewer", async () => {
    const response = await handleAgentCredentialCollection(
      new Request("https://airux.example/api/v1/agent-credentials"),
      REVIEWER,
      TEST_CONFIG,
      vi.fn(async () =>
        Response.json([
          credentialRow({
            user_id: OTHER_REVIEWER_ID,
            name: "Private credential",
          }),
        ]),
      ),
    );

    expect(response.status).toBe(503);
    const responseForLeakCheck = response.clone();
    await expect(response.json()).resolves.toEqual({
      error: { code: "internal_error", message: "Service unavailable" },
    });
    expect(await responseForLeakCheck.text()).not.toContain(
      "Private credential",
    );
  });

  it("revokes once and returns the same record on a repeated request", async () => {
    const revokedRow = credentialRow({
      revoked_at: "2026-08-15T10:00:00+00:00",
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json([revokedRow]));

    const response = await handleAgentCredentialRevocation(
      CREDENTIAL_ID,
      REVIEWER,
      TEST_CONFIG,
      fetcher,
    );

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const [patchInput, patchInit] = fetcher.mock.calls[0] ?? [];
    const patchUrl = new URL(String(patchInput));
    expect(patchInit?.method).toBe("PATCH");
    expect(patchUrl.searchParams.get("id")).toBe(`eq.${CREDENTIAL_ID}`);
    expect(patchUrl.searchParams.get("user_id")).toBe(`eq.${REVIEWER.id}`);
    expect(patchUrl.searchParams.get("revoked_at")).toBe("is.null");
    await expect(response.json()).resolves.toEqual({
      credential: {
        id: CREDENTIAL_ID,
        name: "Codex on laptop",
        created_at: "2026-08-15T08:00:00.000Z",
        last_used_at: null,
        revoked_at: "2026-08-15T10:00:00.000Z",
      },
    });
  });

  it("returns not found for malformed, missing, and other-owner credentials", async () => {
    const malformed = await handleAgentCredentialRevocation(
      "not-a-uuid",
      REVIEWER,
      TEST_CONFIG,
      vi.fn(),
    );
    expect(malformed.status).toBe(404);

    const missing = await handleAgentCredentialRevocation(
      CREDENTIAL_ID,
      REVIEWER,
      TEST_CONFIG,
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(Response.json([])),
    );
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toEqual({
      error: { code: "not_found", message: "Not found" },
    });
  });

  it.each([
    [
      "unknown fields",
      { name: "Codex", user_id: REVIEWER.id },
      "application/json",
    ],
    ["empty name", { name: "  " }, "application/json"],
    ["wrong media type", { name: "Codex" }, "text/plain"],
  ])(
    "rejects %s without contacting the Data API",
    async (_name, body, type) => {
      const fetcher = vi.fn();
      const response = await handleAgentCredentialCollection(
        createRequest(body, type),
        REVIEWER,
        TEST_CONFIG,
        fetcher,
      );

      expect(response.status).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({
        error: { code: "invalid_request", message: "Invalid request" },
      });
    },
  );

  it("returns a generic rate-limit response when the active credential quota is reached", async () => {
    const response = await handleAgentCredentialCollection(
      createRequest({ name: "One credential too many" }),
      REVIEWER,
      TEST_CONFIG,
      vi.fn(async () =>
        Response.json(
          {
            code: "P0001",
            details: null,
            hint: null,
            message: "active agent credential quota exceeded",
          },
          { status: 400 },
        ),
      ),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "rate_limited",
        message: "Active credential limit reached",
      },
    });
  });

  it("fails closed without returning Data API details", async () => {
    const response = await handleAgentCredentialCollection(
      new Request("https://airux.example/api/v1/agent-credentials"),
      REVIEWER,
      TEST_CONFIG,
      vi.fn(
        async () => new Response("private database detail", { status: 500 }),
      ),
    );

    expect(response.status).toBe(503);
    expect(await response.text()).toBe(
      JSON.stringify({
        error: { code: "internal_error", message: "Service unavailable" },
      }),
    );
  });

  it("does not follow Data API redirects with the Worker secret", async () => {
    const response = await handleAgentCredentialCollection(
      new Request("https://airux.example/api/v1/agent-credentials"),
      REVIEWER,
      TEST_CONFIG,
      vi.fn(async (_input, init) => {
        expect(init?.redirect).toBe("manual");
        return new Response(null, {
          status: 302,
          headers: { location: "https://untrusted.example" },
        });
      }),
    );

    expect(response.status).toBe(503);
  });
});
