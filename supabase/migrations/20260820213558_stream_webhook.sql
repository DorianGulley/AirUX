create function public.process_stream_webhook(
  p_stream_video_id text,
  p_target_status text,
  p_failure_code text default null,
  p_duration_ms integer default null,
  p_width integer default null,
  p_height integer default null
)
returns table (
  evidence_id uuid,
  review_id uuid,
  evidence_status text,
  review_status text,
  review_version integer
)
language plpgsql
set search_path = ''
as $$
declare
  matched_evidence_id uuid;
  matched_review_id uuid;
  evidence_row public.evidence%rowtype;
  review_row public.reviews%rowtype;
begin
  if p_stream_video_id is null
    or p_stream_video_id <> btrim(p_stream_video_id)
    or char_length(p_stream_video_id) not between 1 and 128
    or p_target_status is null
    or p_target_status not in ('ready', 'failed') then
    raise exception using
      errcode = 'P0001',
      message = 'invalid Stream webhook transition';
  end if;

  if p_target_status = 'ready' and (
    p_failure_code is not null
    or p_duration_ms is null
    or p_duration_ms not between 1 and 120000
    or p_width is null
    or p_width not between 1 and 3840
    or p_height is null
    or p_height not between 1 and 2160
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'invalid Stream webhook metadata';
  end if;

  if p_target_status = 'failed' and (
    p_failure_code is null
    or p_failure_code <> btrim(p_failure_code)
    or char_length(p_failure_code) not between 1 and 128
    or p_duration_ms is not null
    or p_width is not null
    or p_height is not null
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'invalid Stream webhook failure';
  end if;

  select evidence.id, evidence.review_id
  into matched_evidence_id, matched_review_id
  from public.evidence
  where evidence.stream_video_id = p_stream_video_id;

  if not found then
    return;
  end if;

  select reviews.*
  into review_row
  from public.reviews
  where reviews.id = matched_review_id
  for update;

  select evidence.*
  into evidence_row
  from public.evidence
  where evidence.id = matched_evidence_id
    and evidence.stream_video_id = p_stream_video_id
  for update;

  if not found then
    return;
  end if;

  if p_target_status = 'ready' then
    if evidence_row.status = 'awaiting_upload' then
      perform public.transition_evidence_state(
        matched_evidence_id,
        'awaiting_upload',
        'processing',
        null
      );
      select evidence.*
      into evidence_row
      from public.evidence
      where evidence.id = matched_evidence_id;
    end if;

    if evidence_row.status = 'processing' then
      perform public.transition_evidence_state(
        matched_evidence_id,
        'processing',
        'ready',
        null
      );
      update public.evidence
      set
        duration_ms = p_duration_ms,
        width = p_width,
        height = p_height
      where evidence.id = matched_evidence_id
        and evidence.status = 'ready'
      returning * into evidence_row;
    end if;

    if evidence_row.status = 'ready' and review_row.status = 'draft' then
      perform public.transition_review_state(
        matched_review_id,
        'draft',
        'pending',
        review_row.version
      );
      select reviews.*
      into review_row
      from public.reviews
      where reviews.id = matched_review_id;
    end if;
  else
    if evidence_row.status in ('awaiting_upload', 'processing') then
      perform public.transition_evidence_state(
        matched_evidence_id,
        evidence_row.status,
        'failed',
        p_failure_code
      );
      select evidence.*
      into evidence_row
      from public.evidence
      where evidence.id = matched_evidence_id;
    end if;
  end if;

  return query select
    evidence_row.id,
    evidence_row.review_id,
    evidence_row.status,
    review_row.status,
    review_row.version;
end;
$$;

revoke all on function public.process_stream_webhook(
  text,
  text,
  text,
  integer,
  integer,
  integer
)
from public, anon, authenticated;

grant execute on function public.process_stream_webhook(
  text,
  text,
  text,
  integer,
  integer,
  integer
)
to service_role;
