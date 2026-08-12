import { describe, expect, it } from "vitest";

import { v1 } from "../src/index.js";

describe("public shared contract", () => {
  it("exposes schemas through the versioned namespace", () => {
    expect(v1.CONTRACT_VERSION).toBe("v1");
    expect(v1.reviewStateSchema.parse("pending")).toBe("pending");
    expect(
      v1.capturePlanSchema.safeParse({
        start_url: "http://localhost:3000",
        viewport: { width: 1_280, height: 720 },
        max_duration_ms: 30_000,
        steps: [{ action: "pause", duration_ms: 250 }],
      }).success,
    ).toBe(true);
  });
});
