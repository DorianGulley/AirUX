import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("browser security headers", () => {
  async function browserHeaders() {
    const headers = await readFile(
      new URL("../public/_headers", import.meta.url),
      "utf8",
    );
    return new Map(
      headers
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.includes(":"))
        .map((line) => {
          const separator = line.indexOf(":");
          return [line.slice(0, separator), line.slice(separator + 1).trim()];
        }),
    );
  }

  it("enforces the browser isolation and transport policy", async () => {
    const headers = await browserHeaders();

    expect(headers.get("Cross-Origin-Opener-Policy")).toBe("same-origin");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(headers.get("Permissions-Policy")).toBe(
      "camera=(), geolocation=(), microphone=()",
    );
    expect(headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(headers.get("Strict-Transport-Security")).toBe(
      "max-age=31536000; includeSubDomains",
    );
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("keeps scripts local while allowing the validated Stream player origin", async () => {
    const contentSecurityPolicy = (await browserHeaders()).get(
      "Content-Security-Policy",
    );

    expect(contentSecurityPolicy).toContain("default-src 'self'");
    expect(contentSecurityPolicy).toContain("script-src 'self'");
    expect(contentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(contentSecurityPolicy).toContain(
      "frame-src https://*.cloudflarestream.com",
    );
    expect(contentSecurityPolicy).not.toContain("frame-src *");
    expect(contentSecurityPolicy).not.toContain("'unsafe-inline'");
    expect(contentSecurityPolicy).not.toContain("'unsafe-eval'");
  });
});
