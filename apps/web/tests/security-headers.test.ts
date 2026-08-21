import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("browser security headers", () => {
  it("allows the validated Cloudflare Stream player origin", async () => {
    const headers = await readFile(
      new URL("../public/_headers", import.meta.url),
      "utf8",
    );
    const contentSecurityPolicy = headers
      .split("\n")
      .find((line) => line.trim().startsWith("Content-Security-Policy:"));

    expect(contentSecurityPolicy).toContain(
      "frame-src https://*.cloudflarestream.com",
    );
    expect(contentSecurityPolicy).not.toContain("frame-src *");
  });
});
