begin;

select plan(20);

select has_function(
  'public',
  'prepare_due_evidence_cleanup',
  array['timestamp with time zone', 'integer'],
  'creates the due Evidence preparation function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.prepare_due_evidence_cleanup(timestamp with time zone,integer)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.prepare_due_evidence_cleanup(timestamp with time zone,integer)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.prepare_due_evidence_cleanup(timestamp with time zone,integer)',
      'execute'
    ),
  'only the service role may prepare cleanup work'
);

select has_function(
  'public',
  'complete_evidence_cleanup',
  array['uuid', 'text'],
  'creates the Evidence cleanup completion function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.complete_evidence_cleanup(uuid,text)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.complete_evidence_cleanup(uuid,text)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.complete_evidence_cleanup(uuid,text)',
      'execute'
    ),
  'only the service role may complete cleanup work'
);

insert into auth.users (id)
values ('00000000-0000-4000-8000-000000000055');

insert into public.agent_credentials (id, user_id, name, secret_hash)
values (
  '10000000-0000-4000-8000-000000000055',
  '00000000-0000-4000-8000-000000000055',
  'Scheduled cleanup agent',
  'scheduled-cleanup-agent-secret-hash'
);

insert into public.reviews (
  id,
  user_id,
  agent_credential_id,
  client_request_id,
  title,
  claim,
  criteria,
  status,
  version,
  created_at,
  submitted_at,
  expires_at,
  resolved_at
)
values
  (
    '20000000-0000-4000-8000-000000000051',
    '00000000-0000-4000-8000-000000000055',
    '10000000-0000-4000-8000-000000000055',
    'cleanup-draft',
    'Expired draft',
    'The draft expires before upload.',
    '[{"id":"draft","prompt":"Expire the draft."}]',
    'draft',
    0,
    now() - interval '2 hours',
    null,
    now() - interval '1 hour',
    null
  ),
  (
    '20000000-0000-4000-8000-000000000052',
    '00000000-0000-4000-8000-000000000055',
    '10000000-0000-4000-8000-000000000055',
    'cleanup-pending',
    'Expired pending Review',
    'The pending Review expires with its video.',
    '[{"id":"pending","prompt":"Expire the pending Review."}]',
    'pending',
    1,
    now() - interval '4 days',
    now() - interval '3 days 1 hour',
    now() - interval '1 hour',
    null
  ),
  (
    '20000000-0000-4000-8000-000000000053',
    '00000000-0000-4000-8000-000000000055',
    '10000000-0000-4000-8000-000000000055',
    'cleanup-approved',
    'Resolved Review',
    'The resolved Review keeps its terminal state.',
    '[{"id":"approved","prompt":"Delete resolved Evidence."}]',
    'approved',
    2,
    now() - interval '8 days',
    now() - interval '8 days',
    now() - interval '5 days',
    now() - interval '7 days'
  ),
  (
    '20000000-0000-4000-8000-000000000054',
    '00000000-0000-4000-8000-000000000055',
    '10000000-0000-4000-8000-000000000055',
    'cleanup-cancelled',
    'Cancelled Review',
    'Cancelled Evidence is immediately due.',
    '[{"id":"cancelled","prompt":"Delete cancelled Evidence."}]',
    'cancelled',
    1,
    now() - interval '2 hours',
    null,
    now() - interval '1 hour',
    now() - interval '30 minutes'
  ),
  (
    '20000000-0000-4000-8000-000000000055',
    '00000000-0000-4000-8000-000000000055',
    '10000000-0000-4000-8000-000000000055',
    'cleanup-future',
    'Future pending Review',
    'Future Evidence remains available.',
    '[{"id":"future","prompt":"Keep future Evidence."}]',
    'pending',
    1,
    now() - interval '1 hour',
    now() - interval '30 minutes',
    now() + interval '72 hours',
    null
  );

insert into public.evidence (
  id,
  review_id,
  status,
  stream_video_id,
  media_type,
  size_bytes,
  duration_ms,
  width,
  height,
  delete_after,
  created_at
)
values
  (
    '30000000-0000-4000-8000-000000000051',
    '20000000-0000-4000-8000-000000000051',
    'awaiting_upload',
    null,
    'video/webm',
    1024,
    null,
    null,
    null,
    now() - interval '1 hour',
    now() - interval '2 hours'
  ),
  (
    '30000000-0000-4000-8000-000000000052',
    '20000000-0000-4000-8000-000000000052',
    'ready',
    'cleanup-pending-video',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() - interval '1 hour',
    now() - interval '4 days'
  ),
  (
    '30000000-0000-4000-8000-000000000053',
    '20000000-0000-4000-8000-000000000053',
    'ready',
    'cleanup-approved-video',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() - interval '1 hour',
    now() - interval '8 days'
  ),
  (
    '30000000-0000-4000-8000-000000000054',
    '20000000-0000-4000-8000-000000000054',
    'deleting',
    'cleanup-cancelled-video',
    'video/webm',
    1024,
    null,
    null,
    null,
    now() - interval '30 minutes',
    now() - interval '2 hours'
  ),
  (
    '30000000-0000-4000-8000-000000000055',
    '20000000-0000-4000-8000-000000000055',
    'ready',
    'cleanup-future-video',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() + interval '72 hours',
    now() - interval '1 hour'
  );

create temporary table prepared_cleanup as
select *
from public.prepare_due_evidence_cleanup(clock_timestamp(), 25);

select is(
  (select count(*)::integer from prepared_cleanup),
  4,
  'prepares every due Evidence row in the bounded batch'
);

select is(
  (
    select string_agg(distinct evidence_status, ',' order by evidence_status)
    from prepared_cleanup
  ),
  'deleting',
  'returns only Evidence prepared for provider deletion'
);

select is(
  (
    select status || ':' || version
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000051'
  ),
  'expired:1',
  'expires a due draft Review atomically'
);

select is(
  (
    select status || ':' || version
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000052'
  ),
  'expired:2',
  'expires a due pending Review atomically'
);

select is(
  (
    select status
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000053'
  ),
  'approved',
  'preserves a resolved Review while cleaning its Evidence'
);

select is(
  (
    select status || ':' || (
      select evidence.status
      from public.evidence
      where review_id = reviews.id
    )
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000055'
  ),
  'pending:ready',
  'does not prepare Evidence before its deadline'
);

select is(
  (
    select count(*)::integer
    from prepared_cleanup
    where evidence_id = '30000000-0000-4000-8000-000000000051'
      and stream_video_id is null
  ),
  1,
  'prepares expired Evidence without a provider video'
);

select is(
  (
    select count(*)::integer
    from public.prepare_due_evidence_cleanup(clock_timestamp(), 25)
  ),
  4,
  'keeps unsuccessful deleting Evidence eligible for the next invocation'
);

select is(
  (
    select status
    from public.complete_evidence_cleanup(
      '30000000-0000-4000-8000-000000000052',
      'cleanup-pending-video'
    )
  ),
  'deleted',
  'records successful Stream deletion through the state service'
);

select isnt(
  (
    select deleted_at
    from public.evidence
    where id = '30000000-0000-4000-8000-000000000052'
  ),
  null,
  'records the Evidence deletion timestamp'
);

select is(
  (
    select count(*)::integer
    from public.complete_evidence_cleanup(
      '30000000-0000-4000-8000-000000000053',
      'another-video-id'
    )
  ),
  0,
  'does not record deletion for a mismatched provider video'
);

select is(
  (
    select status
    from public.complete_evidence_cleanup(
      '30000000-0000-4000-8000-000000000051',
      null
    )
  ),
  'deleted',
  'completes cleanup when no provider video exists'
);

select is(
  (
    select count(*)::integer
    from public.prepare_due_evidence_cleanup(clock_timestamp(), 25)
  ),
  2,
  'excludes completed Evidence from later cleanup batches'
);

select throws_ok(
  $$
    select *
    from public.prepare_due_evidence_cleanup(
      clock_timestamp() + interval '10 minutes',
      25
    )
  $$,
  'P0001',
  'invalid cleanup request',
  'rejects a cleanup boundary too far in the future'
);

select throws_ok(
  $$
    select *
    from public.prepare_due_evidence_cleanup(clock_timestamp(), 101)
  $$,
  'P0001',
  'invalid cleanup request',
  'rejects an unbounded cleanup batch'
);

select is(
  (
    select count(*)::integer
    from public.prepare_due_evidence_cleanup(clock_timestamp(), 1)
  ),
  1,
  'enforces the requested cleanup batch limit'
);

select * from finish();

rollback;
