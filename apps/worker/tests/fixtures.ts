export const TEST_ENV = {
  AIRUX_ENVIRONMENT: "development",
  AIRUX_APP_ORIGIN: "https://airux.example",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public-test-value",
  SUPABASE_SECRET_KEY: "sb_secret_private-test-value",
  STREAM_SIGNING_JWK: "eyJrdHkiOiJSU0EifQ==",
  STREAM_SIGNING_KEY_ID: "stream-signing-test-key",
  STREAM_WEBHOOK_SECRET: "stream-webhook-test-secret",
  STREAM: {} as StreamBinding,
  REVIEWER_AUTH_RATE_LIMITER: {
    limit: async () => ({ success: true }),
  },
  CREDENTIAL_CREATE_RATE_LIMITER: {
    limit: async () => ({ success: true }),
  },
  AGENT_REVIEW_CREATE_RATE_LIMITER: {
    limit: async () => ({ success: true }),
  },
} satisfies Env;
