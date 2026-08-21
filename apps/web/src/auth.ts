import {
  createClient,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";

import type { BrowserConfig } from "./browser-config.js";

const DISPLAY_NAME_KEYS = ["user_name", "preferred_username", "name"] as const;
const OAUTH_CALLBACK_PARAMETERS = [
  "code",
  "error",
  "error_code",
  "error_description",
] as const;

function getCleanOAuthUrl(currentUrl: string | URL) {
  const url = new URL(currentUrl.toString());
  for (const parameter of OAUTH_CALLBACK_PARAMETERS) {
    url.searchParams.delete(parameter);
  }
  return url;
}

export function createReviewerAuthClient(
  config: BrowserConfig,
  storage: Storage,
): SupabaseClient {
  return createClient(
    config.supabase.url,
    config.supabase.publishable_key,
    getReviewerAuthOptions(storage),
  );
}

export function getReviewerAuthOptions(storage: Storage) {
  return {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: "pkce" as const,
      persistSession: true,
      storage,
    },
  };
}

export function getReviewerDisplayName(user: Pick<User, "user_metadata">) {
  for (const key of DISPLAY_NAME_KEYS) {
    const value = user.user_metadata[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim().slice(0, 80);
    }
  }

  return "GitHub user";
}

export function getSessionDisplayName(session: Session | null) {
  return session === null ? null : getReviewerDisplayName(session.user);
}

export function getOAuthRedirectUrl(currentUrl: string | URL) {
  return getCleanOAuthUrl(currentUrl).toString();
}

export function getOAuthCallbackCleanupPath(currentUrl: string | URL) {
  const originalUrl = new URL(currentUrl.toString());
  const cleanUrl = getCleanOAuthUrl(originalUrl);
  if (cleanUrl.toString() === originalUrl.toString()) {
    return null;
  }
  return `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`;
}
