import type { Session } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  observeReviewSession,
  ReviewAuthError,
  restoreReviewSession,
  signInToReview,
  signOutFromReview,
} from "../src/review-auth.js";

const session = {
  access_token: "header.payload.signature",
  user: { id: "reviewer-id", user_metadata: { user_name: "reviewer" } },
} as Session;

function createAuth(overrides: Record<string, unknown> = {}) {
  return {
    getSession: vi.fn(async () => ({ data: { session }, error: null })),
    onAuthStateChange: vi.fn(),
    signInWithOAuth: vi.fn(async () => ({ error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    ...overrides,
  };
}

describe("Review authentication", () => {
  it("restores the current reviewer session", async () => {
    const auth = createAuth();

    await expect(restoreReviewSession(auth)).resolves.toBe(session);
  });

  it("fails closed when session restoration fails", async () => {
    const auth = createAuth({
      getSession: vi.fn(async () => ({
        data: { session: null },
        error: new Error("private provider detail"),
      })),
    });

    await expect(restoreReviewSession(auth)).rejects.toBeInstanceOf(
      ReviewAuthError,
    );
  });

  it("forwards auth changes without provider event details", () => {
    const auth = createAuth();
    const onSession = vi.fn();
    observeReviewSession(auth, onSession);
    const callback = auth.onAuthStateChange.mock.calls[0]?.[0];

    callback?.("SIGNED_IN", session);
    expect(onSession).toHaveBeenCalledExactlyOnceWith(session);
  });

  it("starts GitHub OAuth with the clean Review URL", async () => {
    const auth = createAuth();

    await signInToReview(
      auth,
      "https://airux.app/reviews/rvw_123?fixture=ready&code=oauth-code",
    );

    expect(auth.signInWithOAuth).toHaveBeenCalledExactlyOnceWith({
      provider: "github",
      options: {
        redirectTo: "https://airux.app/reviews/rvw_123?fixture=ready",
      },
    });
  });

  it("surfaces sign-in and sign-out failures without provider details", async () => {
    const auth = createAuth({
      signInWithOAuth: vi.fn(async () => ({ error: new Error("private") })),
      signOut: vi.fn(async () => ({ error: new Error("private") })),
    });

    await expect(
      signInToReview(auth, "https://airux.app/reviews/rvw_123"),
    ).rejects.toBeInstanceOf(ReviewAuthError);
    await expect(signOutFromReview(auth)).rejects.toBeInstanceOf(
      ReviewAuthError,
    );
  });

  it("signs out only the local browser session", async () => {
    const auth = createAuth();

    await signOutFromReview(auth);

    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: "local" });
  });
});
