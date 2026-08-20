# AirUX Worker configuration

The Worker uses generated `Env` bindings plus runtime validation in
`src/config.ts`. Non-secret local and development values are declared in
`wrangler.jsonc`; encrypted values never belong in source control.

## Local development

1. Start local Supabase with `pnpm db:start`.
2. Copy `.dev.vars.example` to `.dev.vars`.
3. Replace the placeholder with a local-only Supabase secret key.
4. Start the Worker with `pnpm worker:dev`.

The Worker command builds the browser client before serving assets. Browser
configuration is loaded from `GET /api/v1/config`; that response contains only
the public Supabase URL and publishable key and is marked `no-store`.

Wrangler reads `.dev.vars` only for local development. The file is ignored by
Git. Cloudflare Stream access uses the `STREAM` Worker binding, so no Stream API
token is exposed to the Worker or stored in local environment files.

Protected reviewer routes use the browser's Supabase access token from the
`Authorization: Bearer <token>` header. The Worker validates the token with
Supabase Auth for every protected request, requires GitHub as the trusted auth
provider, and passes only the authenticated user ID to the route handler.
Access tokens and provider error bodies must not be logged or returned to
clients.

Credential endpoints are protected by two Cloudflare rate-limit bindings.
Authentication attempts are limited to 120 requests per minute per source IP,
and credential creation is additionally limited to 10 requests per minute per
reviewer. Limiter failures fail closed. The database independently caps each
reviewer at 20 active credentials; revoking one frees a slot while retaining
the revoked record for audit history.

Signed-in reviewers manage agent credentials through:

```text
POST /api/v1/agent-credentials
GET  /api/v1/agent-credentials
POST /api/v1/agent-credentials/:id/revoke
```

Creation returns the plaintext credential exactly once. The browser keeps it
only in temporary DOM state, while the Worker stores only its SHA-256 digest.
List and revoke operations always filter by the validated reviewer ID before
using the Supabase Data API. Because the Worker secret bypasses RLS, the Worker
also verifies that every returned credential row has that reviewer ID before
omitting the internal owner field from the public response. Revocation is
idempotent and retains the database record for audit history.

Agent API routes use the same standard header with the versioned agent token:

```text
Authorization: Bearer airux_agent_v1.<credential_uuid>.<secret>
```

The Worker extracts the credential UUID for an indexed lookup, excludes revoked
records, hashes the complete presented token, and uses a timing-safe comparison
against the stored digest. Successful authentication exposes only the
credential ID and owning user ID to agent route handlers. Agent credentials are
never accepted by reviewer routes, and authentication never returns the stored
digest or provider details. `last_used_at` tracking is intentionally deferred.

Authenticated agents manage their own Reviews through:

```text
POST /api/v1/agent/reviews
GET  /api/v1/agent/reviews
GET  /api/v1/agent/reviews/:id
POST /api/v1/agent/reviews/:id/cancel
```

Creation atomically persists the Review and Evidence before requesting a
private, 15-minute direct-upload URL from the Stream binding. Basic uploads are
limited to 200 MiB and 120 seconds. Reusing a `client_request_id` with the same
payload returns the existing draft Review and refreshes its upload slot; using
the key with different content returns a conflict. Read and cancellation
operations are scoped to both the authenticated owner and credential, and
agent-facing responses omit owner IDs, credential IDs, Stream IDs, and deletion
metadata.

## Review lifecycle service

Review and Evidence state changes use `src/state-transitions.ts`, which calls
the Postgres transition functions through the bounded Supabase Data API client.
The functions compare expected state atomically, return no row for stale state
or version expectations, preserve same-state retries as no-ops, and maintain
Review versions and lifecycle timestamps. Database triggers also reject invalid
direct state updates.

## Managed development

The `development` Wrangler environment explicitly deploys the existing
`airux-dev` Worker. Configure its encrypted values interactively:

```sh
pnpm --filter @airux/worker exec wrangler secret put SUPABASE_SECRET_KEY --env development
```

Deployments use `pnpm worker:deploy`, which always selects the named
`development` environment. Production configuration is deferred to M7-3.
