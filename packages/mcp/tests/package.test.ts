import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));

describe("published AirUX MCP package", () => {
  it("ships a versioned public CLI without a workspace runtime dependency", async () => {
    const manifest = JSON.parse(
      await readFile(`${packageRoot}package.json`, "utf8"),
    ) as Record<string, unknown>;

    expect(manifest).toMatchObject({
      name: "@airux/mcp",
      version: "0.1.0",
      bin: { "airux-mcp": "dist/stdio.js" },
      files: ["dist", "README.md"],
      publishConfig: { access: "public" },
    });
    expect(manifest.private).not.toBe(true);
    expect(manifest.dependencies).not.toHaveProperty("@airux/shared");
    expect(manifest.scripts).toMatchObject({
      build: expect.stringContaining("src/stdio.ts"),
      prepack: "pnpm run build",
    });
  });
});
