create function public.enforce_active_agent_credential_quota()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text, 0)
  );

  if (
    select count(*)
    from public.agent_credentials
    where user_id = new.user_id and revoked_at is null
  ) >= 20 then
    raise exception using
      errcode = 'P0001',
      message = 'active agent credential quota exceeded';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_active_agent_credential_quota()
from public, anon, authenticated;

grant execute on function public.enforce_active_agent_credential_quota()
to service_role;

create trigger enforce_active_agent_credential_quota
before insert on public.agent_credentials
for each row execute function public.enforce_active_agent_credential_quota();
