begin;

select plan(21);

select has_function(
  'public',
  'decide_reviewer_review',
  array[
    'uuid',
    'uuid',
    'integer',
    'text',
    'text',
    'timestamp with time zone'
  ],
  'creates the transactional reviewer decision function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.decide_reviewer_review(uuid,uuid,integer,text,text,timestamp with time zone)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.decide_reviewer_review(uuid,uuid,integer,text,text,timestamp with time zone)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.decide_reviewer_review(uuid,uuid,integer,text,text,timestamp with time zone)',
      'execute'
    ),
  'only the service role may submit reviewer decisions'
);

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000030'),
  ('00000000-0000-4000-8000-000000000031');

insert into public.agent_credentials (id, user_id, name, secret_hash)
values
  (
    '10000000-0000-4000-8000-000000000030',
    '00000000-0000-4000-8000-000000000030',
    'Reviewer A test agent',
    'reviewer-a-test-secret-hash'
  ),
  (
    '10000000-0000-4000-8000-000000000031',
    '00000000-0000-4000-8000-000000000031',
    'Reviewer B test agent',
    'reviewer-b-test-secret-hash'
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
  submitted_at,
  expires_at
)
values
  (
    '20000000-0000-4000-8000-000000000030',
    '00000000-0000-4000-8000-000000000030',
    '10000000-0000-4000-8000-000000000030',
    'reviewer-decision-approval',
    'Approval Review',
    'The evidence supports approval.',
    '[{"id":"approval","prompt":"Approve the evidence."}]',
    'pending',
    3,
    now(),
    now() + interval '72 hours'
  ),
  (
    '20000000-0000-4000-8000-000000000031',
    '00000000-0000-4000-8000-000000000030',
    '10000000-0000-4000-8000-000000000030',
    'reviewer-decision-changes',
    'Changes Review',
    'The evidence needs changes.',
    '[{"id":"changes","prompt":"Request specific changes."}]',
    'pending',
    3,
    now(),
    now() + interval '72 hours'
  ),
  (
    '20000000-0000-4000-8000-000000000032',
    '00000000-0000-4000-8000-000000000030',
    '10000000-0000-4000-8000-000000000030',
    'reviewer-decision-invalid',
    'Invalid Review',
    'Invalid decisions do not mutate this Review.',
    '[{"id":"invalid","prompt":"Reject invalid decisions."}]',
    'pending',
    3,
    now(),
    now() + interval '72 hours'
  ),
  (
    '20000000-0000-4000-8000-000000000033',
    '00000000-0000-4000-8000-000000000031',
    '10000000-0000-4000-8000-000000000031',
    'reviewer-b-decision',
    'Reviewer B Review',
    'Only Reviewer B may decide this Review.',
    '[{"id":"owner","prompt":"Enforce owner access."}]',
    'pending',
    1,
    now(),
    now() + interval '72 hours'
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
  delete_after
)
values
  (
    '30000000-0000-4000-8000-000000000030',
    '20000000-0000-4000-8000-000000000030',
    'ready',
    'reviewer-api-stream-approval',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() + interval '7 days'
  ),
  (
    '30000000-0000-4000-8000-000000000031',
    '20000000-0000-4000-8000-000000000031',
    'ready',
    'reviewer-api-stream-changes',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() + interval '7 days'
  ),
  (
    '30000000-0000-4000-8000-000000000032',
    '20000000-0000-4000-8000-000000000032',
    'ready',
    'reviewer-api-stream-invalid',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() + interval '7 days'
  ),
  (
    '30000000-0000-4000-8000-000000000033',
    '20000000-0000-4000-8000-000000000033',
    'ready',
    'reviewer-api-stream-owner',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() + interval '7 days'
  );

select is(
  (
    select
      status || ':' || version || ':' || outcome || ':'
        || coalesce(comment, 'none') || ':' || title || ':'
        || evidence_status || ':' || width
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000030',
      3,
      'approved',
      null,
      clock_timestamp() + interval '7 days'
    )
  ),
  'approved:4:approved:none:Approval Review:ready:1280',
  'approves an owned pending Review and returns its presentation data'
);

select is(
  (
    select status || ':' || version
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000030'
  ),
  'approved:4',
  'persists the terminal Review state and incremented version'
);

select is(
  (
    select count(*)::integer
    from public.decisions
    where review_id = '20000000-0000-4000-8000-000000000030'
      and user_id = '00000000-0000-4000-8000-000000000030'
      and outcome = 'approved'
      and comment is null
  ),
  1,
  'persists exactly one owner-linked approval Decision'
);

select isnt(
  (
    select resolved_at
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000030'
  ),
  null,
  'records the resolution timestamp in the same transaction'
);

select ok(
  (
    select delete_after between
      clock_timestamp() + interval '6 days 23 hours'
      and clock_timestamp() + interval '7 days 1 hour'
    from public.evidence
    where id = '30000000-0000-4000-8000-000000000030'
  ),
  'persists resolved Evidence retention in the decision transaction'
);

select throws_ok(
  $$
    select *
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000032',
      '00000000-0000-4000-8000-000000000030',
      3,
      'approved',
      null,
      '2000-01-01 00:00:00+00'
    )
  $$,
  'P0001',
  'invalid evidence expiration',
  'rejects a resolved Evidence expiry that is not in the future'
);

select is(
  (
    select count(*)::integer
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000033',
      '00000000-0000-4000-8000-000000000030',
      1,
      'approved',
      null,
      clock_timestamp() + interval '7 days'
    )
  ),
  0,
  'does not reveal a Review owned by another reviewer'
);

select is(
  (
    select count(*)::integer
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000099',
      '00000000-0000-4000-8000-000000000030',
      1,
      'approved',
      null,
      clock_timestamp() + interval '7 days'
    )
  ),
  0,
  'returns the same empty result for a missing Review'
);

select throws_ok(
  $$
    select *
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000032',
      '00000000-0000-4000-8000-000000000030',
      2,
      'approved',
      null,
      clock_timestamp() + interval '7 days'
    )
  $$,
  'P0001',
  'review decision conflict',
  'rejects a stale expected version'
);

select throws_ok(
  $$
    select *
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000032',
      '00000000-0000-4000-8000-000000000030',
      3,
      'deferred',
      null,
      clock_timestamp() + interval '7 days'
    )
  $$,
  'P0001',
  'invalid review decision',
  'rejects an unsupported Decision outcome'
);

select throws_ok(
  $$
    select *
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000030',
      3,
      'changes_requested',
      null,
      clock_timestamp() + interval '7 days'
    )
  $$,
  'P0001',
  'invalid review decision',
  'requires feedback when requesting changes'
);

select is(
  (
    select status || ':' || version || ':' || outcome || ':' || comment
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000031',
      '00000000-0000-4000-8000-000000000030',
      3,
      'changes_requested',
      'Show the expanded menu.',
      clock_timestamp() + interval '7 days'
    )
  ),
  'changes_requested:4:changes_requested:Show the expanded menu.',
  'requests changes with required feedback'
);

select is(
  (
    select comment
    from public.decisions
    where review_id = '20000000-0000-4000-8000-000000000031'
  ),
  'Show the expanded menu.',
  'persists actionable changes-requested feedback'
);

select throws_ok(
  $$
    select *
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000030',
      3,
      'approved',
      null,
      clock_timestamp() + interval '7 days'
    )
  $$,
  'P0001',
  'review decision conflict',
  'rejects an identical repeated decision'
);

select throws_ok(
  $$
    select *
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000030',
      '00000000-0000-4000-8000-000000000030',
      4,
      'changes_requested',
      'Use a different outcome.',
      clock_timestamp() + interval '7 days'
    )
  $$,
  'P0001',
  'review decision conflict',
  'rejects a different Decision after resolution'
);

select is(
  (
    select count(*)::integer
    from public.decisions
    where review_id = '20000000-0000-4000-8000-000000000030'
  ),
  1,
  'keeps exactly one terminal Decision after conflicts'
);

select is(
  (
    select status || ':' || version
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000032'
  ),
  'pending:3',
  'leaves the Review unchanged after invalid and stale decisions'
);

select is(
  (
    select status || ':' || version
    from public.decide_reviewer_review(
      '20000000-0000-4000-8000-000000000033',
      '00000000-0000-4000-8000-000000000031',
      1,
      'approved',
      'Reviewed by the owner.',
      clock_timestamp() + interval '7 days'
    )
  ),
  'approved:2',
  'allows the actual owner to decide the Review'
);

select is(
  (
    select count(*)::integer
    from public.decisions
    where review_id in (
      '20000000-0000-4000-8000-000000000030',
      '20000000-0000-4000-8000-000000000031',
      '20000000-0000-4000-8000-000000000033'
    )
  ),
  3,
  'persists one Decision for each successfully resolved Review'
);

select * from finish();

rollback;
