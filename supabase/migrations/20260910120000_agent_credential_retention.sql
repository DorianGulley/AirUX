create index agent_credentials_user_created_at_idx
on public.agent_credentials(user_id, created_at desc);

create index agent_credentials_revoked_at_idx
on public.agent_credentials(revoked_at, id)
where revoked_at is not null;

create or replace function public.enforce_active_agent_credential_quota()
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
    where user_id = new.user_id
      and created_at >= clock_timestamp() - interval '24 hours'
  ) >= 50 then
    raise exception using
      errcode = 'P0001',
      message = 'daily agent credential creation quota exceeded';
  end if;

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

create function public.delete_stale_revoked_agent_credentials(
  p_due_before timestamptz,
  p_limit integer
)
returns table (deleted_count integer)
language plpgsql
set search_path = ''
as $$
begin
  if p_due_before is null
    or not isfinite(p_due_before)
    or p_due_before > clock_timestamp() + interval '5 minutes'
    or p_limit is null
    or p_limit not between 1 and 100 then
    raise exception using
      errcode = 'P0001',
      message = 'invalid credential cleanup request';
  end if;

  return query
  with candidates as (
    select agent_credentials.id
    from public.agent_credentials
    where agent_credentials.revoked_at
        <= p_due_before - interval '30 days'
      and not exists (
        select 1
        from public.reviews
        where reviews.agent_credential_id = agent_credentials.id
      )
    order by agent_credentials.revoked_at, agent_credentials.id
    limit p_limit
    for update of agent_credentials skip locked
  ), deleted as (
    delete from public.agent_credentials
    using candidates
    where agent_credentials.id = candidates.id
    returning agent_credentials.id
  )
  select count(*)::integer
  from deleted;
end;
$$;

revoke all on function public.delete_stale_revoked_agent_credentials(
  timestamptz,
  integer
)
from public, anon, authenticated;

grant execute on function public.delete_stale_revoked_agent_credentials(
  timestamptz,
  integer
)
to service_role;
