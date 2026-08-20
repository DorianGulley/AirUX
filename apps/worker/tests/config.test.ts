import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../src/config.js";
import { TEST_ENV } from "./fixtures.js";

describe("loadConfig", () => {
  it("returns structured configuration for valid bindings", () => {
    expect(loadConfig(TEST_ENV)).toEqual({
      environment: "development",
      appOrigin: "https://airux.example",
      supabase: {
        url: "https://example.supabase.co",
        publishableKey: "sb_publishable_public-test-value",
        secretKey: "sb_secret_private-test-value",
      },
      stream: {
        webhookSecret: "stream-webhook-test-secret",
      },
    });
  });

  it("allows HTTP origins only for local development", () => {
    const config = loadConfig({
      ...TEST_ENV,
      AIRUX_ENVIRONMENT: "local",
      AIRUX_APP_ORIGIN: "http://127.0.0.1:8787/",
      SUPABASE_URL: "http://127.0.0.1:54321/",
    });

    expect(config.appOrigin).toBe("http://127.0.0.1:8787");
    expect(config.supabase.url).toBe("http://127.0.0.1:54321");
  });

  it.each([
    ["AIRUX_ENVIRONMENT", { AIRUX_ENVIRONMENT: "production" }],
    ["AIRUX_APP_ORIGIN", { AIRUX_APP_ORIGIN: "http://airux.example" }],
    ["SUPABASE_URL", { SUPABASE_URL: "https://example.supabase.co/rest" }],
    [
      "SUPABASE_PUBLISHABLE_KEY",
      { SUPABASE_PUBLISHABLE_KEY: "public-test-value" },
    ],
    ["SUPABASE_SECRET_KEY", { SUPABASE_SECRET_KEY: "private-test-value" }],
    ["STREAM_WEBHOOK_SECRET", { STREAM_WEBHOOK_SECRET: "short" }],
  ])("rejects an invalid %s binding", (bindingName, override) => {
    expect(() => loadConfig({ ...TEST_ENV, ...override })).toThrow(
      new ConfigurationError(bindingName as keyof Env),
    );
  });

  it("does not include a rejected secret value in its error", () => {
    const secret = "do-not-leak-this-value";

    expect(() =>
      loadConfig({ ...TEST_ENV, SUPABASE_SECRET_KEY: secret }),
    ).toThrowError(/SUPABASE_SECRET_KEY/);

    try {
      loadConfig({ ...TEST_ENV, SUPABASE_SECRET_KEY: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it("does not include a rejected Stream secret value in its error", () => {
    const secret = " secret-with-surrounding-whitespace ";

    expect(() =>
      loadConfig({ ...TEST_ENV, STREAM_WEBHOOK_SECRET: secret }),
    ).toThrowError(/STREAM_WEBHOOK_SECRET/);

    try {
      loadConfig({ ...TEST_ENV, STREAM_WEBHOOK_SECRET: secret });
    } catch (error) {
      expect(String(error)).toContain("STREAM_WEBHOOK_SECRET");
      expect(String(error)).not.toContain(secret);
    }
  });
});
