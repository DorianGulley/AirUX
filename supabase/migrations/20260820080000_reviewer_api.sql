create function public.decide_reviewer_review(
  p_review_id uuid,
  p_user_id uuid,
  p_expected_version integer,
  p_outcome text,
  p_comment text
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

  select evidence.*
  into evidence_row
  from public.evidence
  where evidence.review_id = review_row.id
  for share;

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
  text
)
from public, anon, authenticated;

grant execute on function public.decide_reviewer_review(
  uuid,
  uuid,
  integer,
  text,
  text
)
to service_role;
