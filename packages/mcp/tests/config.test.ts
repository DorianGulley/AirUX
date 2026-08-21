import { describe, expect, it } from "vitest";

import { AiruxConfigError, loadAiruxRuntimeConfig } from "../src/config.js";

const TOKEN = `airux_agent_v1.00000000-0000-4000-8000-000000000001.${"a".repeat(43)}`;

describe("loadAiruxRuntimeConfig", () => {
  it.each([
    ["https://airux.example", "https://airux.example"],
    ["https://airux.example/", "https://airux.example"],
    ["http://localhost:8787", "http://localhost:8787"],
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
  ])("accepts trusted API origin %s", (input, expected) => {
    expect(
      loadAiruxRuntimeConfig({
        AIRUX_AGENT_TOKEN: TOKEN,
        AIRUX_API_ORIGIN: input,
      }),
    ).toEqual({ agentToken: TOKEN, apiOrigin: expected });
  });

  it.each([
    "http://airux.example",
    "https://user@airux.example",
    "https://airux.example/api",
    "https://airux.example/?query=1",
    "javascript:alert(1)",
  ])("rejects unsafe API origin %s", (apiOrigin) => {
    expect(() =>
      loadAiruxRuntimeConfig({
        AIRUX_AGENT_TOKEN: TOKEN,
        AIRUX_API_ORIGIN: apiOrigin,
      }),
    ).toThrow(AiruxConfigError);
  });

  it("never includes a credential value in a validation error", () => {
    const invalidToken = "airux_agent_v1.secret-value";
    let error: unknown;
    try {
      loadAiruxRuntimeConfig({
        AIRUX_AGENT_TOKEN: invalidToken,
        AIRUX_API_ORIGIN: "https://airux.example",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(AiruxConfigError);
    expect(String(error)).not.toContain(invalidToken);
  });
});
