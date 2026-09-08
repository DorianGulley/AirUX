# Supabase environments

AirUX development uses the local Supabase stack. The only hosted project in the
MVP architecture is production, created fresh from the reviewed migration
history so it does not inherit development data or settings. See
`../DEPLOYMENT.md` for production project and CI configuration.

## Local workflow

A Docker-compatible container runtime is required for the local Supabase stack.

Create a GitHub OAuth app for local development with these exact URLs:

- Homepage URL: `http://127.0.0.1:8787`
- Authorization callback URL: `http://127.0.0.1:54321/auth/v1/callback`

Copy `.env.example` to `.env` and add the OAuth app credentials before starting
the local stack. The secret must remain outside source control.

Email/password sign-up is disabled. Global sign-up remains enabled so GitHub
OAuth can create reviewer accounts.

```sh
pnpm db:start
pnpm db:reset
pnpm db:test
pnpm db:lint
pnpm db:stop
```

Create schema changes as timestamped migrations:

```sh
pnpm db:migration:new <migration_name>
```

Run `pnpm db:reset` before committing to verify that the database can be rebuilt
from migrations alone.

## Production migrations

Never commit access tokens, database passwords, secret keys, or OAuth client
secrets. Do not include seed data when pushing to production.

Production migrations are applied only by the manual GitHub deployment
workflow after the local migration suite and a remote dry-run pass. Do not run
`supabase db push` against production from a developer machine and do not enable
a second migration deployer in the Supabase GitHub integration. The legacy
integration should be disconnected after the M7-3 pull request merges.
