import type { Session } from "@supabase/supabase-js";

import { getOAuthRedirectUrl } from "./auth.js";

interface ReviewAuthPort {
  getSession(): Promise<{
    data: { session: Session | null };
    error: unknown | null;
  }>;
  onAuthStateChange(
    callback: (event: unknown, session: Session | null) => void,
  ): unknown;
  signInWithOAuth(input: {
    provider: "github";
    options: { redirectTo: string };
  }): Promise<{ error: unknown | null }>;
  signOut(input: { scope: "local" }): Promise<{ error: unknown | null }>;
}

export class ReviewAuthError extends Error {}

export async function restoreReviewSession(auth: ReviewAuthPort) {
  const { data, error } = await auth.getSession();
  if (error !== null) {
    throw new ReviewAuthError();
  }
  return data.session;
}

export function observeReviewSession(
  auth: ReviewAuthPort,
  onSession: (session: Session | null) => void,
) {
  return auth.onAuthStateChange((_event, session) => {
    onSession(session);
  });
}

export async function signInToReview(
  auth: ReviewAuthPort,
  currentUrl: string | URL,
) {
  const { error } = await auth.signInWithOAuth({
    provider: "github",
    options: { redirectTo: getOAuthRedirectUrl(currentUrl) },
  });
  if (error !== null) {
    throw new ReviewAuthError();
  }
}

export async function signOutFromReview(auth: ReviewAuthPort) {
  const { error } = await auth.signOut({ scope: "local" });
  if (error !== null) {
    throw new ReviewAuthError();
  }
}
