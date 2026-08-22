# AirUX MCP server

The local stdio server exposes `airux_create_review`, `airux_get_review`, and
`airux_list_open_reviews`. The create tool records a
validated localhost browser flow, creates an AirUX Review, uploads the temporary
WebM recording directly to Cloudflare Stream, waits for processing, removes the
local recording, and returns the pending Review URL.

## Developer setup

Install Chromium once:

```sh
pnpm mcp:browser:install
```

Configure the AirUX API origin and an agent credential, then start the stdio
server:

```sh
AIRUX_API_ORIGIN=https://airux.example \
AIRUX_AGENT_TOKEN="airux_agent_v1.CREDENTIAL_ID.SECRET" \
pnpm mcp:start
```

`AIRUX_API_ORIGIN` must be an HTTPS origin. HTTP is accepted only for localhost
and loopback development origins. Stdout is reserved for MCP JSON-RPC messages;
transport diagnostics use stderr and never include API responses or credentials.

## Tool contract

`airux_create_review` accepts:

- `client_request_id`, `title`, `claim`, and `criteria`
- `capture_plan`, using the constrained localhost-only AirUX capture schema

On success it returns `review_id`, `review_url`, and `status: "pending"` as
structured content. The tool captures once. Transient create calls reuse the
same idempotency key, and ambiguous uploads receive one bounded state-based
recovery attempt before the temporary recording is deleted and a sanitized tool
error is returned.

`airux_get_review` accepts a `review_id`, then waits locally for the Review to
reach a terminal state. It polls the authenticated AirUX API with increasing
intervals, honors server retry guidance, and returns the final status and human
Decision. Cancelling the MCP request interrupts the wait without changing the
remotely stored Review.

After an agent or MCP process is interrupted, call `airux_list_open_reviews`
with no arguments. It returns compact `draft` and `pending` Review summaries
created by the configured agent credential, ordered newest first. Match the
original work using `client_request_id` or the Review title, then pass its `id`
to `airux_get_review` to resume waiting for the terminal result. An empty list
means that credential has no unresolved Reviews.
