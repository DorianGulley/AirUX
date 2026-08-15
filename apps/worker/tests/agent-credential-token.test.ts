import { describe, expect, it } from "vitest";

import {
  hashAgentCredentialToken,
  issueAgentCredential,
} from "../src/agent-credential-token.js";

describe("agent credential tokens", () => {
  it("issues a versioned credential with 256 bits of random secret material", async () => {
    const issued = await issueAgentCredential();

    expect(issued.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(issued.token).toMatch(
      new RegExp(`^airux_agent_v1\\.${issued.id}\\.[A-Za-z0-9_-]{43}$`),
    );
    expect(issued.secretHash).toMatch(/^sha256:[A-Za-z0-9_-]{43}$/);
    expect(issued.secretHash).toBe(
      await hashAgentCredentialToken(issued.token),
    );
    expect(issued.secretHash).not.toContain(issued.token);
  });

  it("produces distinct credentials", async () => {
    const first = await issueAgentCredential();
    const second = await issueAgentCredential();

    expect(second.id).not.toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(second.secretHash).not.toBe(first.secretHash);
  });
});
