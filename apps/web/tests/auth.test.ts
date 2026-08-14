import { describe, expect, it } from "vitest";

import {
  getReviewerAuthOptions,
  getReviewerDisplayName,
  getSessionDisplayName,
} from "../src/auth.js";

const storage = {
  getItem: () => null,
  removeItem: () => undefined,
  setItem: () => undefined,
  clear: () => undefined,
  key: () => null,
  length: 0,
} satisfies Storage;

describe("reviewer authentication", () => {
  it("uses persistent PKCE sessions with automatic refresh", () => {
    expect(getReviewerAuthOptions(storage)).toEqual({
      auth: {
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: "pkce",
        persistSession: true,
        storage,
      },
    });
  });

  it("uses a bounded GitHub username for display", () => {
    expect(
      getReviewerDisplayName({
        user_metadata: { user_name: `  ${"a".repeat(100)}  ` },
      }),
    ).toBe("a".repeat(80));
  });

  it("falls back without exposing the user's email", () => {
    expect(
      getReviewerDisplayName({
        user_metadata: { email: "private@example.com" },
      }),
    ).toBe("GitHub user");
  });

  it("returns no display name for a signed-out session", () => {
    expect(getSessionDisplayName(null)).toBeNull();
  });
});
