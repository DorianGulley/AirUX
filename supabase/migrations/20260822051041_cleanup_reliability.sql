create or replace function public.complete_evidence_cleanup(
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
    and evidence.status in ('deleting', 'deleted')
  for update;

  if not found then
    return;
  end if;

  if evidence_row.status = 'deleted' then
    return query select
      evidence_row.id,
      evidence_row.review_id,
      evidence_row.status,
      evidence_row.deleted_at;
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
