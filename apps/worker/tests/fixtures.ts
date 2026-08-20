export const TEST_ENV = {
  AIRUX_ENVIRONMENT: "development",
  AIRUX_APP_ORIGIN: "https://airux.example",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public-test-value",
  SUPABASE_SECRET_KEY: "sb_secret_private-test-value",
  STREAM: {} as StreamBinding,
  REVIEWER_AUTH_RATE_LIMITER: {
    limit: async () => ({ success: true }),
  },
  CREDENTIAL_CREATE_RATE_LIMITER: {
    limit: async () => ({ success: true }),
  },
} satisfies Env;
