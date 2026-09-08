# Production deployment

AirUX uses one hosted production environment for the MVP. Development and
automated tests run against local Supabase, local fixtures, and injected
Cloudflare Stream fakes. The production Stream library is never used by the
ordinary local or CI test paths.

Production releases are started manually from the GitHub Actions
`Deploy production` workflow. The workflow validates the repository and local
database first, then waits at the GitHub `production` environment gate before
it reads production credentials, applies migrations, and deploys the Worker.

## 1. Create the production Supabase project

1. Create a new project named `airux-prod`. Use Postgres 17 and the region in
   which AirUX should operate. Save the generated database password securely.
2. In **Project Settings → API**, record:
   - the project URL;
   - the publishable key beginning with `sb_publishable_`;
   - the secret key beginning with `sb_secret_`.
3. Record the project reference from the dashboard URL.
4. Do not edit the production schema through the SQL or Table editors. The
   versioned migrations in `supabase/migrations` are the source of truth and
   the deployment workflow is their only remote writer.

## 2. Configure production GitHub authentication

Use `https://airux-prod.airux-platform.workers.dev` as the initial application
origin. The custom `airux.app` cutover remains part of M7-6.

1. In GitHub, create a production OAuth App.
2. Set its homepage URL to the application origin.
3. Set its authorization callback URL to
   `https://<project-ref>.supabase.co/auth/v1/callback`.
4. Copy the OAuth client ID and client secret into
   **Supabase → Authentication → Sign In / Providers → GitHub**, then enable
   the provider.
5. In **Supabase → Authentication → URL Configuration**, set the Site URL to
   the application origin and allow `<application-origin>/**` as a redirect.
6. Verify GitHub sign-in before disabling email authentication.

The local Supabase stack continues to use the separate loopback OAuth App
described in `supabase/README.md`.

## 3. Prepare the Cloudflare account

1. Keep the existing Cloudflare account and account-wide Stream library.
2. Create an API token using Cloudflare's **Edit Cloudflare Workers** template,
   restricted to this account. This is the CI deployment token.
3. Separately create or use a short-lived API token with **Stream Write** for
   the one-time signing-key and webhook setup. Do not add this Stream
   administration token to GitHub.
4. Create a Stream signing key with
   `POST /accounts/<account-id>/stream/keys`. Save the returned `result.id` and
   `result.jwk` immediately. The returned JWK is already base64 encoded and is
   not shown again.
5. Set the account's single Stream webhook subscription to:

   ```text
   https://airux-prod.airux-platform.workers.dev/api/v1/webhooks/cloudflare-stream
   ```

   Use `PUT /accounts/<account-id>/stream/webhook` and save the returned
   signing secret. Updating this subscription replaces the current webhook and
   rotates its secret, so perform this step immediately before the first
   production workflow run.
6. Revoke the temporary Stream administration token when setup is complete.

## 4. Configure the GitHub production environment

In the repository, create an environment named exactly `production`. Restrict
deployment branches to `main` and add a required reviewer when the repository's
GitHub plan supports one.

Create these environment variables:

| Variable | Value |
| --- | --- |
| `AIRUX_APP_ORIGIN` | `https://airux-prod.airux-platform.workers.dev` |
| `CLOUDFLARE_ACCOUNT_ID` | Existing production Cloudflare account ID |
| `SUPABASE_PROJECT_ID` | Production Supabase project reference |
| `SUPABASE_PUBLISHABLE_KEY` | Production `sb_publishable_...` key |
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |

Create these environment secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Account-scoped Worker deployment token |
| `STREAM_SIGNING_JWK` | Base64-encoded `result.jwk` from Stream |
| `STREAM_SIGNING_KEY_ID` | `result.id` from the Stream signing key |
| `STREAM_WEBHOOK_SECRET` | Secret returned by the webhook update |
| `SUPABASE_ACCESS_TOKEN` | Supabase personal access token for CI |
| `SUPABASE_DB_PASSWORD` | Production project's database password |
| `SUPABASE_SECRET_KEY` | Production `sb_secret_...` key |

The workflow writes the four Worker runtime secrets to a permission-restricted
temporary runner file, uploads them with the Worker deployment, and deletes the
file even when deployment fails. They are never committed or printed.

After this pull request merges, disconnect the legacy Supabase GitHub
integration; local CI and this workflow replace it for the one-environment MVP.
If it must remain connected temporarily, turn off **Deploy to production** and
preview branching so it cannot create a second migration writer or hosted
development resources.

## 5. Run and verify the first release

1. Merge the M7-3 pull request into `main`.
2. Open **GitHub → Actions → Deploy production**.
3. Choose **Run workflow**, select `main`, and start it.
4. Confirm the `Validate release` job passes. Approve the `production`
   environment deployment if approval protection is enabled.
5. Confirm the migration dry-run, Worker dry-run, migration push, and Worker
   deployment all pass in that order.
6. Open `https://airux-prod.airux-platform.workers.dev/api/v1/health` and
   confirm a successful response.
7. Verify production GitHub sign-in and create one agent credential.
8. In Cloudflare, confirm `airux-prod` has the Stream binding, one 15-minute
   Cron Trigger, and Workers logs and traces enabled.
9. Run the real Stream upload, webhook, playback, deletion, and retention smoke
   test during M7-6. It is intentionally excluded from ordinary CI.
10. After production verification, disable the old `airux-dev` Cron Trigger and
    retire that Worker. Pause or delete the legacy hosted Supabase development
    project only after confirming it contains nothing that must be retained.

Subsequent releases repeat only step 5. The workflow accepts manual dispatches
from `main` and serializes production deployments so migrations cannot race.
