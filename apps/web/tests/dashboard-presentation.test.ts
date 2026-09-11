import { describe, expect, it } from "vitest";

import { formatDuration } from "../src/main.js";

describe("dashboard presentation", () => {
  it.each([
    [null, "Duration unavailable"],
    [250, "1 sec"],
    [15_000, "15 sec"],
    [65_000, "1:05"],
  ] as const)("formats %s milliseconds as %s", (duration, expected) => {
    expect(formatDuration(duration)).toBe(expected);
  });
});
