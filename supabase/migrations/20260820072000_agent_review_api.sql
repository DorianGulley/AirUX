alter table public.evidence
drop constraint evidence_size_bytes_check;

alter table public.evidence
add constraint evidence_size_bytes_check
check (size_bytes between 1 and 209715200);

create function public.create_agent_review(
  p_user_id uuid,
  p_agent_credential_id uuid,
  p_client_request_id text,
  p_title text,
  p_claim text,
  p_criteria jsonb,
  p_evidence_kind text,
  p_media_type text,
  p_size_bytes bigint,
  p_expires_at timestamptz,
  p_delete_after timestamptz
)
returns table (
  review_id uuid,
  evidence_id uuid,
  status text,
  stream_video_id text,
  created boolean
)
language plpgsql
set search_path = ''
as $$
declare
  review_row public.reviews%rowtype;
  evidence_row public.evidence%rowtype;
begin
  insert into public.reviews (
    user_id,
    agent_credential_id,
    client_request_id,
    title,
    claim,
    criteria,
    expires_at
  )
  values (
    p_user_id,
    p_agent_credential_id,
    p_client_request_id,
    p_title,
    p_claim,
    p_criteria,
    p_expires_at
  )
  on conflict on constraint reviews_client_request_key do nothing
  returning * into review_row;

  if found then
    insert into public.evidence (
      review_id,
      kind,
      media_type,
      size_bytes,
      delete_after
    )
    values (
      review_row.id,
      p_evidence_kind,
      p_media_type,
      p_size_bytes,
      p_delete_after
    )
    returning * into evidence_row;

    return query select
      review_row.id,
      evidence_row.id,
      review_row.status,
      evidence_row.stream_video_id,
      true;
    return;
  end if;

  select reviews.*
  into review_row
  from public.reviews
  where reviews.agent_credential_id = p_agent_credential_id
    and reviews.client_request_id = p_client_request_id
  for update;

  select evidence.*
  into evidence_row
  from public.evidence
  where evidence.review_id = review_row.id;

  if review_row.id is null
    or evidence_row.id is null
    or review_row.user_id <> p_user_id
    or review_row.title <> p_title
    or review_row.claim <> p_claim
    or review_row.criteria <> p_criteria
    or evidence_row.kind <> p_evidence_kind
    or evidence_row.media_type <> p_media_type
    or evidence_row.size_bytes <> p_size_bytes then
    raise exception using
      errcode = 'P0001',
      message = 'client request payload conflict';
  end if;

  if review_row.status <> 'draft'
    or review_row.deleted_at is not null
    or evidence_row.status <> 'awaiting_upload'
    or evidence_row.deleted_at is not null then
    raise exception using
      errcode = 'P0001',
      message = 'review is no longer accepting uploads';
  end if;

  return query select
    review_row.id,
    evidence_row.id,
    review_row.status,
    evidence_row.stream_video_id,
    false;
end;
$$;

create function public.replace_agent_review_upload(
  p_review_id uuid,
  p_evidence_id uuid,
  p_user_id uuid,
  p_agent_credential_id uuid,
  p_stream_video_id text
)
returns table (
  evidence_id uuid,
  previous_stream_video_id text
)
language plpgsql
set search_path = ''
as $$
declare
  current_stream_video_id text;
begin
  select evidence.stream_video_id
  into current_stream_video_id
  from public.evidence
  inner join public.reviews on reviews.id = evidence.review_id
  where reviews.id = p_review_id
    and reviews.user_id = p_user_id
    and reviews.agent_credential_id = p_agent_credential_id
    and reviews.status = 'draft'
    and reviews.deleted_at is null
    and evidence.id = p_evidence_id
    and evidence.status = 'awaiting_upload'
    and evidence.deleted_at is null
  for update of evidence;

  if not found then
    return;
  end if;

  update public.evidence
  set stream_video_id = p_stream_video_id
  where evidence.id = p_evidence_id;

  return query select p_evidence_id, current_stream_video_id;
end;
$$;

create function public.cancel_agent_review(
  p_review_id uuid,
  p_user_id uuid,
  p_agent_credential_id uuid
)
returns table (
  review_id uuid,
  status text,
  version integer
)
language plpgsql
set search_path = ''
as $$
declare
  review_row public.reviews%rowtype;
begin
  select reviews.*
  into review_row
  from public.reviews
  where reviews.id = p_review_id
    and reviews.user_id = p_user_id
    and reviews.agent_credential_id = p_agent_credential_id
    and reviews.deleted_at is null
  for update;

  if not found then
    return;
  end if;

  if review_row.status = 'cancelled' then
    return query select review_row.id, review_row.status, review_row.version;
    return;
  end if;

  if review_row.status not in ('draft', 'pending') then
    raise exception using
      errcode = 'P0001',
      message = 'review cannot be cancelled';
  end if;

  return query
  select
    transitioned.review_id,
    transitioned.status,
    transitioned.version
  from public.transition_review_state(
    review_row.id,
    review_row.status,
    'cancelled',
    review_row.version
  ) as transitioned;
end;
$$;

revoke all on function public.create_agent_review(
  uuid,
  uuid,
  text,
  text,
  text,
  jsonb,
  text,
  text,
  bigint,
  timestamptz,
  timestamptz
)
from public, anon, authenticated;

revoke all on function public.replace_agent_review_upload(
  uuid,
  uuid,
  uuid,
  uuid,
  text
)
from public, anon, authenticated;

revoke all on function public.cancel_agent_review(uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function public.create_agent_review(
  uuid,
  uuid,
  text,
  text,
  text,
  jsonb,
  text,
  text,
  bigint,
  timestamptz,
  timestamptz
)
to service_role;

grant execute on function public.replace_agent_review_upload(
  uuid,
  uuid,
  uuid,
  uuid,
  text
)
to service_role;

grant execute on function public.cancel_agent_review(uuid, uuid, uuid)
to service_role;
