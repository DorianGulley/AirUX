import { describe, expect, it, vi } from "vitest";

import {
  loadBrowserConfig,
  parseBrowserConfig,
} from "../src/browser-config.js";

const VALID_CONFIG = {
  supabase: {
    url: "https://project.supabase.co",
    publishable_key: "sb_publishable_browser-test-value",
  },
};

describe("browser configuration", () => {
  it("accepts a secure Supabase origin and publishable key", () => {
    expect(parseBrowserConfig(VALID_CONFIG)).toEqual(VALID_CONFIG);
  });

  it("allows loopback HTTP for local development", () => {
    expect(
      parseBrowserConfig({
        supabase: {
          ...VALID_CONFIG.supabase,
          url: "http://127.0.0.1:54321",
        },
      }),
    ).toEqual({
      supabase: {
        ...VALID_CONFIG.supabase,
        url: "http://127.0.0.1:54321",
      },
    });
  });

  it.each([
    {
      supabase: {
        ...VALID_CONFIG.supabase,
        secret_key: "sb_secret_must-not-reach-browser",
      },
    },
    {
      supabase: {
        ...VALID_CONFIG.supabase,
        url: "http://project.supabase.co",
      },
    },
    {
      supabase: {
        ...VALID_CONFIG.supabase,
        publishable_key: "sb_secret_not-a-publishable-key",
      },
    },
  ])("rejects unsafe configuration %#", (config) => {
    expect(() => parseBrowserConfig(config)).toThrow(
      "Invalid browser configuration",
    );
  });

  it("loads configuration from the versioned same-origin endpoint", async () => {
    const fetchConfig = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(VALID_CONFIG, {
        headers: { "cache-control": "no-store" },
      }),
    );

    await expect(loadBrowserConfig(fetchConfig)).resolves.toEqual(VALID_CONFIG);
    expect(fetchConfig).toHaveBeenCalledWith("/api/v1/config", {
      headers: { accept: "application/json" },
    });
  });

  it("fails closed when public configuration is unavailable", async () => {
    const fetchConfig = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 503 }));

    await expect(loadBrowserConfig(fetchConfig)).rejects.toThrow(
      "Browser configuration unavailable",
    );
  });
});
