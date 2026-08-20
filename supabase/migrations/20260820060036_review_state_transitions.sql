create function public.is_allowed_review_state_transition(
  current_status text,
  target_status text
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    current_status = target_status
    or (current_status = 'draft' and target_status in ('pending', 'cancelled', 'expired'))
    or (
      current_status = 'pending'
      and target_status in ('approved', 'changes_requested', 'cancelled', 'expired')
    );
$$;

create function public.is_allowed_evidence_state_transition(
  current_status text,
  target_status text
)
returns boolean
language sql
immutable
strict
set search_path = ''
as $$
  select
    current_status = target_status
    or (
      current_status = 'awaiting_upload'
      and target_status in ('processing', 'failed', 'deleting')
    )
    or (
      current_status = 'processing'
      and target_status in ('ready', 'failed', 'deleting')
    )
    or (current_status in ('ready', 'failed') and target_status = 'deleting')
    or (current_status = 'deleting' and target_status = 'deleted');
$$;

create function public.enforce_review_state_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    if not public.is_allowed_review_state_transition(old.status, new.status) then
      raise exception using
        errcode = 'P0001',
        message = 'invalid review state transition';
    end if;

    if new.status = 'pending' and not exists (
      select 1
      from public.evidence
      where evidence.review_id = new.id
        and evidence.status = 'ready'
    ) then
      raise exception using
        errcode = 'P0001',
        message = 'review evidence is not ready';
    end if;
  end if;

  return new;
end;
$$;

create function public.enforce_evidence_state_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
    and not public.is_allowed_evidence_state_transition(old.status, new.status) then
    raise exception using
      errcode = 'P0001',
      message = 'invalid evidence state transition';
  end if;

  return new;
end;
$$;

create trigger reviews_enforce_state_transition
before update of status on public.reviews
for each row
execute function public.enforce_review_state_transition();

create trigger evidence_enforce_state_transition
before update of status on public.evidence
for each row
execute function public.enforce_evidence_state_transition();

create function public.transition_review_state(
  p_review_id uuid,
  p_expected_status text,
  p_target_status text,
  p_expected_version integer default null
)
returns table (
  review_id uuid,
  status text,
  version integer,
  submitted_at timestamptz,
  resolved_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  transitioned_at timestamptz := clock_timestamp();
begin
  if not public.is_allowed_review_state_transition(
    p_expected_status,
    p_target_status
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'invalid review state transition';
  end if;

  if p_expected_status = p_target_status then
    return query
    select
      reviews.id,
      reviews.status,
      reviews.version,
      reviews.submitted_at,
      reviews.resolved_at
    from public.reviews
    where reviews.id = p_review_id
      and reviews.status = p_expected_status
      and (
        p_expected_version is null
        or reviews.version = p_expected_version
      );
    return;
  end if;

  return query
  update public.reviews
  set
    status = p_target_status,
    version = reviews.version + 1,
    submitted_at = case
      when p_target_status = 'pending' then transitioned_at
      else reviews.submitted_at
    end,
    resolved_at = case
      when p_target_status in (
        'approved',
        'changes_requested',
        'cancelled',
        'expired'
      ) then transitioned_at
      else reviews.resolved_at
    end
  where reviews.id = p_review_id
    and reviews.status = p_expected_status
    and (
      p_expected_version is null
      or reviews.version = p_expected_version
    )
  returning
    reviews.id,
    reviews.status,
    reviews.version,
    reviews.submitted_at,
    reviews.resolved_at;
end;
$$;

create function public.transition_evidence_state(
  p_evidence_id uuid,
  p_expected_status text,
  p_target_status text,
  p_failure_code text default null
)
returns table (
  evidence_id uuid,
  review_id uuid,
  status text,
  failure_code text,
  deleted_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  transitioned_at timestamptz := clock_timestamp();
begin
  if not public.is_allowed_evidence_state_transition(
    p_expected_status,
    p_target_status
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'invalid evidence state transition';
  end if;

  if p_expected_status = p_target_status then
    return query
    select
      evidence.id,
      evidence.review_id,
      evidence.status,
      evidence.failure_code,
      evidence.deleted_at
    from public.evidence
    where evidence.id = p_evidence_id
      and evidence.status = p_expected_status;
    return;
  end if;

  return query
  update public.evidence
  set
    status = p_target_status,
    failure_code = case
      when p_target_status = 'failed' then p_failure_code
      else evidence.failure_code
    end,
    deleted_at = case
      when p_target_status = 'deleted' then transitioned_at
      else evidence.deleted_at
    end
  where evidence.id = p_evidence_id
    and evidence.status = p_expected_status
  returning
    evidence.id,
    evidence.review_id,
    evidence.status,
    evidence.failure_code,
    evidence.deleted_at;
end;
$$;

revoke all on function public.is_allowed_review_state_transition(text, text)
from public, anon, authenticated;
revoke all on function public.is_allowed_evidence_state_transition(text, text)
from public, anon, authenticated;
revoke all on function public.enforce_review_state_transition()
from public, anon, authenticated;
revoke all on function public.enforce_evidence_state_transition()
from public, anon, authenticated;
revoke all on function public.transition_review_state(uuid, text, text, integer)
from public, anon, authenticated;
revoke all on function public.transition_evidence_state(uuid, text, text, text)
from public, anon, authenticated;

grant execute on function public.is_allowed_review_state_transition(text, text)
to service_role;
grant execute on function public.is_allowed_evidence_state_transition(text, text)
to service_role;
grant execute on function public.transition_review_state(uuid, text, text, integer)
to service_role;
grant execute on function public.transition_evidence_state(uuid, text, text, text)
to service_role;
