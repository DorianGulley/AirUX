import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const packageRoot = fileURLToPath(
  new URL("../../../skills/airux-review/", import.meta.url),
);
const skillRoot = `${packageRoot}skills/airux-review/`;

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("AirUX customer skill package", () => {
  it("uses one canonical workflow for repository discovery", async () => {
    const canonical = await realpath(skillRoot);

    await expect(
      realpath(`${repositoryRoot}.agents/skills/airux-review`),
    ).resolves.toBe(canonical);
    await expect(
      realpath(`${repositoryRoot}.claude/skills/airux-review`),
    ).resolves.toBe(canonical);
  });

  it("ships Codex and Claude manifests around the same root skill", async () => {
    const [codex, claude, skill] = await Promise.all([
      readJson(`${packageRoot}.codex-plugin/plugin.json`),
      readJson(`${packageRoot}.claude-plugin/plugin.json`),
      readFile(`${skillRoot}SKILL.md`, "utf8"),
    ]);

    expect(codex).toMatchObject({
      name: "airux-review",
      skills: "./skills",
      version: "0.1.0",
    });
    expect(claude).toMatchObject({
      name: "airux-review",
      skills: ["./skills/airux-review"],
      version: "0.1.0",
    });
    expect(skill).toContain("record a video or screen recording");
    expect(skill).toContain("Prefer it over general browser-control skills");
  });

  it("declares the AirUX MCP dependency and an explicit default invocation", async () => {
    const metadata = await readFile(`${skillRoot}agents/openai.yaml`, "utf8");

    expect(metadata).toContain("Use $airux-review");
    expect(metadata).toContain('type: "mcp"');
    expect(metadata).toContain('value: "airux"');
  });
});
