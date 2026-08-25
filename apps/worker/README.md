# AirUX Worker configuration

The Worker uses generated `Env` bindings plus runtime validation in
`src/config.ts`. Non-secret local and development values are declared in
`wrangler.jsonc`; encrypted values never belong in source control.

## Local development

1. Start local Supabase with `pnpm db:start`.
2. Copy `.dev.vars.example` to `.dev.vars`.
3. Replace the placeholders with a local-only Supabase secret key, the Stream
   signing-key ID and base64-encoded private JWK, and the signing secret for the
   active Stream webhook subscription.
4. Start the Worker with `pnpm worker:dev`.

The Worker command builds the browser client before serving assets. Browser
configuration is loaded from `GET /api/v1/config`; that response contains only
the public Supabase URL and publishable key and is marked `no-store`.

Wrangler reads `.dev.vars` only for local development. The file is ignored by
Git. Cloudflare Stream access uses the `STREAM` Worker binding, so no Stream API
token is exposed to the Worker or stored in local environment files. Private
playback tokens are self-signed with a dedicated Stream signing key stored as
Worker secrets.

Protected reviewer routes use the browser's Supabase access token from the
`Authorization: Bearer <token>` header. The Worker validates the token with
Supabase Auth for every protected request, requires GitHub as the trusted auth
provider, and passes only the authenticated user ID to the route handler.
Access tokens and provider error bodies must not be logged or returned to
clients.

Reviewer-facing endpoints are protected by two Cloudflare rate-limit bindings.
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
Creating Reviews is limited to 10 requests per minute per authenticated agent
credential before AirUX allocates a Stream upload slot. Read polling and
cancellation are not charged against that creation limit.

Authenticated reviewers retrieve and decide their Reviews through:

```text
GET    /api/v1/reviews/:id
DELETE /api/v1/reviews/:id
POST   /api/v1/evidence/:id/playback-token
POST   /api/v1/reviews/:id/decision
```

These routes filter by the authenticated reviewer ID and return the same `404`
for malformed, missing, deleted, or foreign Review IDs. Reviewer responses
include the presentation metadata and terminal Decision while omitting owner,
credential, Stream, and deletion fields. Decisions require the current Review
version and are committed with the terminal state transition in one Postgres
transaction. Stale, repeated, and already-terminal submissions return `409`;
requesting changes also requires a non-empty comment.

Reviewer deletion immediately soft-deletes the owned Review, revokes reviewer,
playback, decision, and agent access, and makes its Evidence due for scheduled
cleanup. An open Review is first cancelled; an existing terminal outcome and
Decision are preserved. Repeating the deletion is an idempotent `204` and does
not advance the Review version or expose deletion metadata.

The playback endpoint first resolves an owned, nondeleted Review from ready
Evidence, then verifies that Stream reports the video as ready and protected by
signed URLs. It returns a `no-store` Stream player credential scoped to that
video for 15 minutes. Cancelled, expired, deleted, foreign, and missing playback
resources all fail without exposing the Stream video ID or owner ID.
The browser Content Security Policy permits Stream player frames from
`https://*.cloudflarestream.com`; the playback response and browser parser
still require the narrower `customer-<code>.cloudflarestream.com` player
origin before embedding a signed credential.

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
metadata. Open Review detail responses include `Retry-After` guidance for the
local MCP client's increasing-interval result poll; terminal responses omit it.
Cancellation atomically moves a draft or pending Review to `cancelled`, moves
its Evidence to `deleting`, and makes that Evidence immediately due for the
scheduled cleanup handler. Repeated cancellation is an idempotent no-op, and
late Stream processing callbacks cannot reopen the Review or Evidence.

Review retention uses the fixed MVP windows centralized in
`src/expiration-policy.ts`. A new draft Review and its Evidence expire after
one hour. A ready Stream webhook atomically moves both expirations to 72 hours
from processing completion, and a terminal reviewer Decision atomically keeps
the Evidence for seven days from resolution. Cancellation remains the explicit
exception: it makes Evidence immediately due. Playback credentials use the
same policy module and expire after 15 minutes. M6-5 owns acting on persisted
`delete_after` timestamps; M6-4 only calculates and records them.

The development Worker runs scheduled cleanup every 15 minutes. Each Cron
invocation prepares at most 25 due Evidence rows in Postgres, expiring draft or
pending Reviews and revoking playback before calling Stream through its Worker
binding. Successful deletion moves Evidence from `deleting` to `deleted` and
records `deleted_at`; expired drafts without an attached Stream video are
completed locally. Stream's documented typed `NotFoundError` and the plain
missing-resource error currently emitted by the live binding are treated as
successful deletion, so a retry can reconcile a video deleted before its
database completion was recorded. Database completion is also idempotent:
overlapping Cron invocations return the original deletion result without
changing `deleted_at`. Other provider and database failures still fail the
Cron invocation and remain eligible for a later scheduled retry.

Stream sends processing results to:

```text
POST /api/v1/webhooks/cloudflare-stream
```

The handler verifies `Webhook-Signature` against the exact request bytes with
HMAC-SHA256 and accepts timestamps within five minutes of Worker time. Signed
ready notifications atomically record duration and dimensions, transition the
Evidence to `ready`, move a draft Review to `pending`, and persist the 72-hour
pending and Evidence expirations. Error notifications transition only the
Evidence to `failed`. Duplicate and unrelated signed notifications are
acknowledged without reopening terminal state or extending retention.

JSON request bodies and upstream JSON responses are read through explicit byte
limits, and client errors never include provider response bodies. The Worker
does not log authorization headers, request bodies, claims, comments, bearer
credentials, or signed URLs; future M7-2 observability must preserve that
allowlist-only boundary.

Cloudflare permits one Stream webhook subscription per account. Register the
environment's public endpoint through the Stream API, then store the returned
signing secret as `STREAM_WEBHOOK_SECRET`. Updating the notification URL rotates
that secret, so update the Worker secret at the same time.

Create one Stream signing key per environment through the Stream API and store
the returned key ID and base64-encoded private JWK as
`STREAM_SIGNING_KEY_ID` and `STREAM_SIGNING_JWK`. The private JWK is returned
only when the key is created and must never be committed or logged.

## Review lifecycle service

Review and Evidence state changes use `src/state-transitions.ts`, which calls
the Postgres transition functions through the bounded Supabase Data API client.
The functions compare expected state atomically, return no row for stale state
or version expectations, preserve same-state retries as no-ops, and maintain
Review versions and lifecycle timestamps. Database triggers also reject invalid
direct state updates.

## Review API contract coverage

The Worker contract suite drives the public agent and reviewer routes through
routing, authentication, shared-schema validation, and a stateful backend
fixture. It verifies owner and credential isolation, equivalent missing and
unauthorized Review responses, creation and cancellation idempotency, payload
reuse conflicts, and single-winner version-checked Decisions. Handler and
database suites continue to test provider failures and transactional invariants
at their narrower boundaries.

## Managed development

The `development` Wrangler environment explicitly deploys the existing
`airux-dev` Worker. Configure its encrypted values interactively:

```sh
pnpm --filter @airux/worker exec wrangler secret put SUPABASE_SECRET_KEY --env development
pnpm --filter @airux/worker exec wrangler secret put STREAM_SIGNING_JWK --env development
pnpm --filter @airux/worker exec wrangler secret put STREAM_SIGNING_KEY_ID --env development
pnpm --filter @airux/worker exec wrangler secret put STREAM_WEBHOOK_SECRET --env development
```

Deployments use `pnpm worker:deploy`, which always selects the named
`development` environment. Production configuration is deferred to M7-3.
The development Cron Trigger is managed exclusively by `wrangler.jsonc`; local
scheduled-handler testing remains opt-in through Wrangler's
`/cdn-cgi/handler/scheduled` route.
