# Supabase development

AirUX currently uses one hosted development project. The production project is
intentionally deferred until the deployment milestone so it can be created from
the reviewed migration history without carrying development data or settings.

- Development project: `airux-dev`
- Project reference: `rulojrgnyibmjgsgqlys`
- Project URL: `https://rulojrgnyibmjgsgqlys.supabase.co`

## Local workflow

A Docker-compatible container runtime is required for the local Supabase stack.

Create a GitHub OAuth app for local development with these exact URLs:

- Homepage URL: `http://127.0.0.1:8787`
- Authorization callback URL: `http://127.0.0.1:54321/auth/v1/callback`

Copy `.env.example` to `.env` and add the OAuth app credentials before starting
the local stack. The secret must remain outside source control.

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

## Hosted development project

Authenticate and link the repository locally. The generated link state and
credentials are ignored by Git.

```sh
pnpm exec supabase login
pnpm exec supabase link --project-ref rulojrgnyibmjgsgqlys
pnpm exec supabase db push --dry-run
pnpm exec supabase db push
```

Never commit access tokens, database passwords, service-role keys, or OAuth
client secrets. Do not include seed data when pushing to a production project.

The hosted development project needs a separate GitHub OAuth app whose callback
URL is `https://rulojrgnyibmjgsgqlys.supabase.co/auth/v1/callback`. Configure the
provider credentials and exact AirUX redirect URL in the Supabase dashboard.
