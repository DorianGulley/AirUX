drop index public.evidence_due_deletion_idx;

create index evidence_due_deletion_idx
on public.evidence(delete_after, id)
where deleted_at is null and status <> 'deleted';

create function public.prepare_due_evidence_cleanup(
  p_due_before timestamptz,
  p_limit integer
)
returns table (
  evidence_id uuid,
  review_id uuid,
  stream_video_id text,
  evidence_status text,
  review_status text
)
language plpgsql
set search_path = ''
as $$
declare
  cleanup_row record;
begin
  if p_due_before is null
    or not isfinite(p_due_before)
    or p_due_before > clock_timestamp() + interval '5 minutes'
    or p_limit is null
    or p_limit not between 1 and 100 then
    raise exception using
      errcode = 'P0001',
      message = 'invalid cleanup request';
  end if;

  for cleanup_row in
    select
      evidence.id as evidence_id,
      evidence.review_id,
      evidence.stream_video_id,
      evidence.status as evidence_status,
      reviews.status as review_status,
      reviews.version as review_version
    from public.evidence
    join public.reviews on reviews.id = evidence.review_id
    where evidence.delete_after <= p_due_before
      and evidence.deleted_at is null
      and evidence.status <> 'deleted'
      and (
        reviews.status not in ('draft', 'pending')
        or reviews.expires_at <= p_due_before
      )
    order by evidence.delete_after, evidence.id
    limit p_limit
    for update of evidence, reviews skip locked
  loop
    if cleanup_row.review_status in ('draft', 'pending') then
      perform public.transition_review_state(
        cleanup_row.review_id,
        cleanup_row.review_status,
        'expired',
        cleanup_row.review_version
      );
      if not found then
        raise exception 'cleanup Review transition failed';
      end if;
      cleanup_row.review_status := 'expired';
    end if;

    if cleanup_row.evidence_status <> 'deleting' then
      perform public.transition_evidence_state(
        cleanup_row.evidence_id,
        cleanup_row.evidence_status,
        'deleting',
        null
      );
      if not found then
        raise exception 'cleanup Evidence transition failed';
      end if;
      cleanup_row.evidence_status := 'deleting';
    end if;

    evidence_id := cleanup_row.evidence_id;
    review_id := cleanup_row.review_id;
    stream_video_id := cleanup_row.stream_video_id;
    evidence_status := cleanup_row.evidence_status;
    review_status := cleanup_row.review_status;
    return next;
  end loop;
end;
$$;

revoke all on function public.prepare_due_evidence_cleanup(
  timestamptz,
  integer
)
from public, anon, authenticated;

grant execute on function public.prepare_due_evidence_cleanup(
  timestamptz,
  integer
)
to service_role;

create function public.complete_evidence_cleanup(
  p_evidence_id uuid,
  p_stream_video_id text
)
returns table (
  evidence_id uuid,
  review_id uuid,
  status text,
  deleted_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  evidence_row public.evidence%rowtype;
  transitioned_row record;
begin
  select evidence.*
  into evidence_row
  from public.evidence
  where evidence.id = p_evidence_id
    and evidence.stream_video_id is not distinct from p_stream_video_id
    and evidence.status = 'deleting'
  for update;

  if not found then
    return;
  end if;

  select *
  into transitioned_row
  from public.transition_evidence_state(
    evidence_row.id,
    'deleting',
    'deleted',
    null
  );

  if not found then
    raise exception 'cleanup completion transition failed';
  end if;

  return query select
    transitioned_row.evidence_id,
    transitioned_row.review_id,
    transitioned_row.status,
    transitioned_row.deleted_at;
end;
$$;

revoke all on function public.complete_evidence_cleanup(uuid, text)
from public, anon, authenticated;

grant execute on function public.complete_evidence_cleanup(uuid, text)
to service_role;
