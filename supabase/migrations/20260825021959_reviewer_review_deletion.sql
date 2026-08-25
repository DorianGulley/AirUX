create function public.delete_reviewer_review(
  p_review_id uuid,
  p_user_id uuid
)
returns table (
  review_id uuid,
  review_status text,
  review_version integer,
  review_deleted_at timestamptz,
  evidence_id uuid,
  evidence_status text,
  evidence_delete_after timestamptz
)
language plpgsql
set search_path = ''
as $$
declare
  deletion_at timestamptz := clock_timestamp();
  evidence_row public.evidence%rowtype;
  review_row public.reviews%rowtype;
begin
  select reviews.*
  into review_row
  from public.reviews
  where reviews.id = p_review_id
    and reviews.user_id = p_user_id
  for update;

  if not found then
    return;
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

  deletion_at := greatest(
    deletion_at,
    review_row.created_at + interval '1 microsecond',
    evidence_row.created_at + interval '1 microsecond'
  );

  if review_row.status in ('draft', 'pending') then
    perform public.transition_review_state(
      review_row.id,
      review_row.status,
      'cancelled',
      review_row.version
    );
    if not found then
      raise exception 'review deletion transition failed';
    end if;
  end if;

  if evidence_row.status not in ('deleting', 'deleted') then
    perform public.transition_evidence_state(
      evidence_row.id,
      evidence_row.status,
      'deleting',
      null
    );
    if not found then
      raise exception 'review Evidence deletion transition failed';
    end if;
  end if;

  update public.reviews
  set deleted_at = coalesce(reviews.deleted_at, deletion_at)
  where reviews.id = review_row.id;

  update public.evidence
  set delete_after = least(evidence.delete_after, deletion_at)
  where evidence.id = evidence_row.id
    and evidence.status <> 'deleted';

  return query
  select
    reviews.id,
    reviews.status,
    reviews.version,
    reviews.deleted_at,
    evidence.id,
    evidence.status,
    evidence.delete_after
  from public.reviews
  join public.evidence on evidence.review_id = reviews.id
  where reviews.id = review_row.id;
end;
$$;

revoke all on function public.delete_reviewer_review(uuid, uuid)
from public, anon, authenticated;

grant execute on function public.delete_reviewer_review(uuid, uuid)
to service_role;
