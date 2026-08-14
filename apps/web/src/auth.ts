import {
  createClient,
  type Session,
  type SupabaseClient,
  type User,
} from "@supabase/supabase-js";

import type { BrowserConfig } from "./browser-config.js";

const DISPLAY_NAME_KEYS = ["user_name", "preferred_username", "name"] as const;

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
