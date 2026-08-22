create or replace function public.cancel_agent_review(
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
  cancelled_at timestamptz := clock_timestamp();
  evidence_row public.evidence%rowtype;
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

  if review_row.status not in ('draft', 'pending', 'cancelled') then
    raise exception using
      errcode = 'P0001',
      message = 'review cannot be cancelled';
  end if;

  select evidence.*
  into evidence_row
  from public.evidence
  where evidence.review_id = review_row.id
  for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'review evidence missing';
  end if;

  if review_row.status <> 'cancelled' then
    perform public.transition_review_state(
      review_row.id,
      review_row.status,
      'cancelled',
      review_row.version
    );
  end if;

  if evidence_row.status not in ('deleting', 'deleted') then
    perform public.transition_evidence_state(
      evidence_row.id,
      evidence_row.status,
      'deleting',
      null
    );
    update public.evidence
    set delete_after = greatest(
      cancelled_at,
      evidence.created_at + interval '1 microsecond'
    )
    where evidence.id = evidence_row.id;
  end if;

  return query
  select reviews.id, reviews.status, reviews.version
  from public.reviews
  where reviews.id = review_row.id;
end;
$$;

update public.evidence
set
  status = 'deleting',
  delete_after = greatest(
    clock_timestamp(),
    evidence.created_at + interval '1 microsecond'
  )
from public.reviews
where reviews.id = evidence.review_id
  and reviews.status = 'cancelled'
  and evidence.status not in ('deleting', 'deleted');
