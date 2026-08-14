# AirUX Worker configuration

The Worker uses generated `Env` bindings plus runtime validation in
`src/config.ts`. Non-secret local and development values are declared in
`wrangler.jsonc`; encrypted values never belong in source control.

## Local development

1. Start local Supabase with `pnpm db:start`.
2. Copy `.dev.vars.example` to `.dev.vars`.
3. Replace both placeholders with local-only development credentials.
4. Start the Worker with `pnpm worker:dev`.

The Worker command builds the browser client before serving assets. Browser
configuration is loaded from `GET /api/v1/config`; that response contains only
the public Supabase URL and publishable key and is marked `no-store`.

Wrangler reads `.dev.vars` only for local development. The file is ignored by
Git. The Stream token is required for configuration validation even though the
Stream integration is introduced in M4-3.

## Managed development

The `development` Wrangler environment explicitly deploys the existing
`airux-dev` Worker. Configure its encrypted values interactively:

```sh
pnpm --filter @airux/worker exec wrangler secret put SUPABASE_SECRET_KEY --env development
pnpm --filter @airux/worker exec wrangler secret put STREAM_API_TOKEN --env development
```

Deployments use `pnpm worker:deploy`, which always selects the named
`development` environment. Production configuration is deferred to M7-3.
