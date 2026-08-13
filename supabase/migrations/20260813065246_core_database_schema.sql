create function public.is_valid_review_criteria(criteria jsonb)
returns boolean
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
  criterion jsonb;
  criterion_id text;
  criterion_ids text[] := array[]::text[];
begin
  if jsonb_typeof(criteria) <> 'array'
    or jsonb_array_length(criteria) not between 1 and 20 then
    return false;
  end if;

  for criterion in select value from jsonb_array_elements(criteria)
  loop
    if jsonb_typeof(criterion) <> 'object' then
      return false;
    end if;

    if (select count(*) from jsonb_object_keys(criterion)) <> 2
      or not criterion ?& array['id', 'prompt']
      or jsonb_typeof(criterion -> 'id') <> 'string'
      or jsonb_typeof(criterion -> 'prompt') <> 'string' then
      return false;
    end if;

    criterion_id := criterion ->> 'id';

    if criterion_id <> btrim(criterion_id)
      or criterion ->> 'prompt' <> btrim(criterion ->> 'prompt')
      or char_length(criterion_id) not between 1 and 64
      or char_length(criterion ->> 'prompt') not between 1 and 1000
      or criterion_id = any(criterion_ids) then
      return false;
    end if;

    criterion_ids := array_append(criterion_ids, criterion_id);
  end loop;

  return true;
end;
$$;

revoke all on function public.is_valid_review_criteria(jsonb)
from public, anon, authenticated;

grant execute on function public.is_valid_review_criteria(jsonb)
to service_role;

create table public.agent_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  name text not null,
  secret_hash text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  constraint agent_credentials_id_user_id_key unique (id, user_id),
  constraint agent_credentials_name_check
    check (name = btrim(name) and char_length(name) between 1 and 200),
  constraint agent_credentials_secret_hash_check
    check (
      secret_hash = btrim(secret_hash)
      and char_length(secret_hash) between 1 and 512
    ),
  constraint agent_credentials_last_used_at_check
    check (last_used_at is null or last_used_at >= created_at),
  constraint agent_credentials_revoked_at_check
    check (revoked_at is null or revoked_at >= created_at)
);

create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  agent_credential_id uuid not null,
  client_request_id text not null,
  title text not null,
  claim text not null,
  criteria jsonb not null,
  status text not null default 'draft',
  version integer not null default 0,
  created_at timestamptz not null default now(),
  submitted_at timestamptz,
  expires_at timestamptz not null,
  resolved_at timestamptz,
  deleted_at timestamptz,
  constraint reviews_id_user_id_key unique (id, user_id),
  constraint reviews_agent_credential_owner_fkey
    foreign key (agent_credential_id, user_id)
    references public.agent_credentials(id, user_id)
    on delete restrict,
  constraint reviews_client_request_key
    unique (agent_credential_id, client_request_id),
  constraint reviews_client_request_id_check
    check (
      client_request_id = btrim(client_request_id)
      and char_length(client_request_id) between 1 and 128
    ),
  constraint reviews_title_check
    check (title = btrim(title) and char_length(title) between 1 and 200),
  constraint reviews_claim_check
    check (claim = btrim(claim) and char_length(claim) between 1 and 5000),
  constraint reviews_criteria_check
    check (public.is_valid_review_criteria(criteria)),
  constraint reviews_status_check
    check (
      status in (
        'draft',
        'pending',
        'approved',
        'changes_requested',
        'cancelled',
        'expired'
      )
    ),
  constraint reviews_version_check check (version >= 0),
  constraint reviews_expires_at_check check (expires_at > created_at),
  constraint reviews_submitted_at_check
    check (submitted_at is null or submitted_at >= created_at),
  constraint reviews_resolved_at_check
    check (resolved_at is null or resolved_at >= created_at),
  constraint reviews_deleted_at_check
    check (deleted_at is null or deleted_at >= created_at)
);

create table public.evidence (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null unique references public.reviews(id) on delete restrict,
  kind text not null default 'browser_video',
  status text not null default 'awaiting_upload',
  stream_video_id text,
  media_type text not null,
  size_bytes bigint not null,
  duration_ms integer,
  width integer,
  height integer,
  failure_code text,
  delete_after timestamptz not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  constraint evidence_stream_video_id_key unique (stream_video_id),
  constraint evidence_kind_check check (kind = 'browser_video'),
  constraint evidence_status_check
    check (
      status in (
        'awaiting_upload',
        'processing',
        'ready',
        'failed',
        'deleting',
        'deleted'
      )
    ),
  constraint evidence_stream_video_id_check
    check (
      stream_video_id is null
      or (
        stream_video_id = btrim(stream_video_id)
        and char_length(stream_video_id) between 1 and 128
      )
    ),
  constraint evidence_media_type_check
    check (
      media_type ~* '^video/[a-z0-9][a-z0-9.+-]*$'
      and char_length(media_type) <= 128
    ),
  constraint evidence_size_bytes_check
    check (size_bytes between 1 and 524288000),
  constraint evidence_duration_ms_check
    check (duration_ms is null or duration_ms between 1 and 120000),
  constraint evidence_width_check
    check (width is null or width between 1 and 3840),
  constraint evidence_height_check
    check (height is null or height between 1 and 2160),
  constraint evidence_failure_code_check
    check (
      failure_code is null
      or (
        failure_code = btrim(failure_code)
        and char_length(failure_code) between 1 and 128
      )
    ),
  constraint evidence_delete_after_check check (delete_after > created_at),
  constraint evidence_deleted_at_check
    check (deleted_at is null or deleted_at >= created_at)
);

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  review_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  outcome text not null,
  comment text,
  created_at timestamptz not null default now(),
  constraint decisions_review_id_key unique (review_id),
  constraint decisions_review_owner_fkey
    foreign key (review_id, user_id)
    references public.reviews(id, user_id)
    on delete restrict,
  constraint decisions_outcome_check
    check (outcome in ('approved', 'changes_requested')),
  constraint decisions_comment_check
    check (
      (
        comment is null
        or (
          comment = btrim(comment)
          and char_length(comment) between 1 and 5000
        )
      )
      and (outcome <> 'changes_requested' or comment is not null)
    )
);

create index agent_credentials_user_id_idx
on public.agent_credentials(user_id);

create index reviews_user_status_created_at_idx
on public.reviews(user_id, status, created_at desc)
where deleted_at is null;

create index reviews_agent_credential_status_created_at_idx
on public.reviews(agent_credential_id, status, created_at desc)
where deleted_at is null;

create index evidence_due_deletion_idx
on public.evidence(delete_after)
where stream_video_id is not null and deleted_at is null and status <> 'deleted';

alter table public.agent_credentials enable row level security;
alter table public.reviews enable row level security;
alter table public.evidence enable row level security;
alter table public.decisions enable row level security;

revoke all on table
  public.agent_credentials,
  public.reviews,
  public.evidence,
  public.decisions
from anon, authenticated;

grant select, insert, update, delete on table
  public.agent_credentials,
  public.reviews,
  public.evidence,
  public.decisions
to service_role;
