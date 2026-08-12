# Supabase development

AirUX currently uses one hosted development project. The production project is
intentionally deferred until the deployment milestone so it can be created from
the reviewed migration history without carrying development data or settings.

- Development project: `airux-dev`
- Project reference: `rulojrgnyibmjgsgqlys`
- Project URL: `https://rulojrgnyibmjgsgqlys.supabase.co`

## Local workflow

A Docker-compatible container runtime is required for the local Supabase stack.

```sh
pnpm db:start
pnpm db:reset
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
