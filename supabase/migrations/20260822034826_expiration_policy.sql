drop function public.process_stream_webhook(
  text,
  text,
  text,
  integer,
  integer,
  integer
);

create function public.process_stream_webhook(
  p_stream_video_id text,
  p_target_status text,
  p_failure_code text default null,
  p_duration_ms integer default null,
  p_width integer default null,
  p_height integer default null,
  p_pending_expires_at timestamptz default null
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
    or p_pending_expires_at is null
    or not isfinite(p_pending_expires_at)
    or p_pending_expires_at <= clock_timestamp()
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
    or p_pending_expires_at is not null
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
      update public.reviews
      set expires_at = p_pending_expires_at
      where reviews.id = matched_review_id
      returning * into review_row;

      update public.evidence
      set delete_after = p_pending_expires_at
      where evidence.id = matched_evidence_id
      returning * into evidence_row;
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
  integer,
  timestamptz
)
from public, anon, authenticated;

grant execute on function public.process_stream_webhook(
  text,
  text,
  text,
  integer,
  integer,
  integer,
  timestamptz
)
to service_role;

drop function public.decide_reviewer_review(
  uuid,
  uuid,
  integer,
  text,
  text
);

create function public.decide_reviewer_review(
  p_review_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_outcome text,
  p_comment text,
  p_evidence_delete_after timestamptz
)
returns table (
  review_id uuid,
  user_id uuid,
  title text,
  claim text,
  criteria jsonb,
  status text,
  version integer,
  created_at timestamptz,
  submitted_at timestamptz,
  expires_at timestamptz,
  resolved_at timestamptz,
  evidence_id uuid,
  evidence_review_id uuid,
  evidence_kind text,
  evidence_status text,
  media_type text,
  size_bytes bigint,
  duration_ms integer,
  width integer,
  height integer,
  failure_code text,
  decision_id uuid,
  decision_user_id uuid,
  outcome text,
  comment text,
  decision_created_at timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  review_row public.reviews%rowtype;
  evidence_row public.evidence%rowtype;
  decision_row public.decisions%rowtype;
  transitioned_row record;
begin
  select reviews.*
  into review_row
  from public.reviews
  where reviews.id = p_review_id
    and reviews.user_id = p_user_id
    and reviews.deleted_at is null
  for update;

  if not found then
    return;
  end if;

  if review_row.status <> 'pending'
    or review_row.version <> p_expected_version then
    raise exception using
      errcode = 'P0001',
      message = 'review decision conflict';
  end if;

  if p_outcome not in ('approved', 'changes_requested')
    or (
      p_outcome = 'changes_requested'
      and p_comment is null
    ) then
    raise exception using
      errcode = 'P0001',
      message = 'invalid review decision';
  end if;

  if p_evidence_delete_after is null
    or not isfinite(p_evidence_delete_after)
    or p_evidence_delete_after <= clock_timestamp() then
    raise exception using
      errcode = 'P0001',
      message = 'invalid evidence expiration';
  end if;

  select evidence.*
  into evidence_row
  from public.evidence
  where evidence.review_id = review_row.id
  for update;

  if not found then
    raise exception 'review evidence missing';
  end if;

  insert into public.decisions (review_id, user_id, outcome, comment)
  values (review_row.id, review_row.user_id, p_outcome, p_comment)
  returning * into decision_row;

  select *
  into transitioned_row
  from public.transition_review_state(
    review_row.id,
    'pending',
    p_outcome,
    p_expected_version
  );

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'review decision conflict';
  end if;

  update public.evidence
  set delete_after = p_evidence_delete_after
  where evidence.id = evidence_row.id
  returning * into evidence_row;

  return query select
    transitioned_row.review_id,
    review_row.user_id,
    review_row.title,
    review_row.claim,
    review_row.criteria,
    transitioned_row.status,
    transitioned_row.version,
    review_row.created_at,
    transitioned_row.submitted_at,
    review_row.expires_at,
    transitioned_row.resolved_at,
    evidence_row.id,
    evidence_row.review_id,
    evidence_row.kind,
    evidence_row.status,
    evidence_row.media_type,
    evidence_row.size_bytes,
    evidence_row.duration_ms,
    evidence_row.width,
    evidence_row.height,
    evidence_row.failure_code,
    decision_row.id,
    decision_row.user_id,
    decision_row.outcome,
    decision_row.comment,
    decision_row.created_at;
end;
$$;

revoke all on function public.decide_reviewer_review(
  uuid,
  uuid,
  integer,
  text,
  text,
  timestamptz
)
from public, anon, authenticated;

grant execute on function public.decide_reviewer_review(
  uuid,
  uuid,
  integer,
  text,
  text,
  timestamptz
)
to service_role;
