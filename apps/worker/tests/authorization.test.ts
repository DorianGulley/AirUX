import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index.js";
import { TEST_ENV } from "./fixtures.js";

const REVIEWER_A_ID = "00000000-0000-4000-8000-000000000001";
const REVIEWER_B_ID = "00000000-0000-4000-8000-000000000002";
const CREDENTIAL_A_ID = "10000000-0000-4000-8000-000000000001";
const CREDENTIAL_B_ID = "10000000-0000-4000-8000-000000000002";
const MISSING_CREDENTIAL_ID = "10000000-0000-4000-8000-000000000003";
const REVIEWER_A_TOKEN = "reviewer-a.payload.signature";
const REVIEWER_B_TOKEN = "reviewer-b.payload.signature";

interface StoredCredential {
  readonly id: string;
  readonly user_id: string;
  readonly name: string;
  readonly created_at: string;
  readonly last_used_at: null;
  revoked_at: string | null;
}

function credential(
  id: string,
  userId: string,
  name: string,
): StoredCredential {
  return {
    id,
    user_id: userId,
    name,
    created_at: "2026-08-15T08:00:00.000Z",
    last_used_at: null,
    revoked_at: null,
  };
}

function installAuthorizationBackend() {
  const credentials = [
    credential(CREDENTIAL_A_ID, REVIEWER_A_ID, "Reviewer A credential"),
    credential(CREDENTIAL_B_ID, REVIEWER_B_ID, "Reviewer B credential"),
  ];

  const fetcher = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") {
        const authorization = new Headers(init?.headers).get("authorization");
        if (authorization === `Bearer ${REVIEWER_A_TOKEN}`) {
          return Response.json({
            id: REVIEWER_A_ID,
            app_metadata: { provider: "github", providers: ["github"] },
          });
        }
        if (authorization === `Bearer ${REVIEWER_B_TOKEN}`) {
          return Response.json({
            id: REVIEWER_B_ID,
            app_metadata: { provider: "github", providers: ["github"] },
          });
        }
        return new Response(null, { status: 401 });
      }

      if (url.pathname !== "/rest/v1/agent_credentials") {
        return new Response(null, { status: 404 });
      }

      const ownerId = url.searchParams.get("user_id")?.replace(/^eq\./, "");
      const credentialId = url.searchParams.get("id")?.replace(/^eq\./, "");
      const matching = credentials.filter(
        (stored) =>
          (ownerId === undefined || stored.user_id === ownerId) &&
          (credentialId === undefined || stored.id === credentialId),
      );

      if (init?.method === "PATCH") {
        const active = matching.filter((stored) => stored.revoked_at === null);
        for (const stored of active) {
          stored.revoked_at = "2026-08-15T10:00:00.000Z";
        }
        return Response.json(active);
      }

      return Response.json(matching);
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return { credentials, fetcher };
}

function reviewerRequest(
  path: string,
  token: string,
  method: "GET" | "POST" = "GET",
) {
  return new Request(`https://airux.app${path}`, {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authorization boundaries", () => {
  it("lists only credentials owned by the authenticated reviewer", async () => {
    const { fetcher } = installAuthorizationBackend();

    const response = await worker.fetch(
      reviewerRequest("/api/v1/agent-credentials", REVIEWER_A_TOKEN),
      TEST_ENV,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      credentials: [
        {
          id: CREDENTIAL_A_ID,
          name: "Reviewer A credential",
          created_at: "2026-08-15T08:00:00.000Z",
          last_used_at: null,
          revoked_at: null,
        },
      ],
    });

    const dataRequest = fetcher.mock.calls.find(([input]) =>
      String(input).includes("/rest/v1/agent_credentials"),
    );
    const dataUrl = new URL(String(dataRequest?.[0]));
    expect(dataUrl.searchParams.get("user_id")).toBe(`eq.${REVIEWER_A_ID}`);
  });

  it("makes another reviewer's credential indistinguishable from a missing one", async () => {
    const { credentials, fetcher } = installAuthorizationBackend();

    const foreignResponse = await worker.fetch(
      reviewerRequest(
        `/api/v1/agent-credentials/${CREDENTIAL_B_ID}/revoke`,
        REVIEWER_A_TOKEN,
        "POST",
      ),
      TEST_ENV,
    );
    const missingResponse = await worker.fetch(
      reviewerRequest(
        `/api/v1/agent-credentials/${MISSING_CREDENTIAL_ID}/revoke`,
        REVIEWER_A_TOKEN,
        "POST",
      ),
      TEST_ENV,
    );

    expect(foreignResponse.status).toBe(404);
    expect(missingResponse.status).toBe(404);
    expect(await foreignResponse.text()).toBe(await missingResponse.text());
    expect(
      credentials.find(({ id }) => id === CREDENTIAL_B_ID)?.revoked_at,
    ).toBe(null);

    const dataUrls = fetcher.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter(({ pathname }) => pathname === "/rest/v1/agent_credentials");
    expect(dataUrls).toHaveLength(4);
    expect(
      dataUrls.every(
        (url) => url.searchParams.get("user_id") === `eq.${REVIEWER_A_ID}`,
      ),
    ).toBe(true);
  });

  it("allows the owner to revoke the same credential", async () => {
    const { credentials } = installAuthorizationBackend();

    const response = await worker.fetch(
      reviewerRequest(
        `/api/v1/agent-credentials/${CREDENTIAL_B_ID}/revoke`,
        REVIEWER_B_TOKEN,
        "POST",
      ),
      TEST_ENV,
    );

    expect(response.status).toBe(200);
    expect(
      credentials.find(({ id }) => id === CREDENTIAL_B_ID)?.revoked_at,
    ).toBe("2026-08-15T10:00:00.000Z");
  });
});
