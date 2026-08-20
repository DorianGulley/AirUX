begin;

select plan(26);

select has_function(
  'public',
  'create_agent_review',
  array[
    'uuid', 'uuid', 'text', 'text', 'text', 'jsonb', 'text', 'text',
    'bigint', 'timestamp with time zone', 'timestamp with time zone'
  ],
  'creates the transactional agent Review function'
);
select has_function(
  'public',
  'replace_agent_review_upload',
  array['uuid', 'uuid', 'uuid', 'uuid', 'text'],
  'creates the owner-scoped Stream attachment function'
);
select has_function(
  'public',
  'cancel_agent_review',
  array['uuid', 'uuid', 'uuid'],
  'creates the owner-scoped cancellation function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.create_agent_review(uuid,uuid,text,text,text,jsonb,text,text,bigint,timestamptz,timestamptz)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.create_agent_review(uuid,uuid,text,text,text,jsonb,text,text,bigint,timestamptz,timestamptz)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.create_agent_review(uuid,uuid,text,text,text,jsonb,text,text,bigint,timestamptz,timestamptz)',
      'execute'
    ),
  'only the service role may create agent Reviews'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.replace_agent_review_upload(uuid,uuid,uuid,uuid,text)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.replace_agent_review_upload(uuid,uuid,uuid,uuid,text)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.replace_agent_review_upload(uuid,uuid,uuid,uuid,text)',
      'execute'
    ),
  'only the service role may attach Stream uploads'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.cancel_agent_review(uuid,uuid,uuid)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.cancel_agent_review(uuid,uuid,uuid)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.cancel_agent_review(uuid,uuid,uuid)',
      'execute'
    ),
  'only the service role may cancel agent Reviews'
);

insert into auth.users (id)
values ('00000000-0000-4000-8000-000000000020');

insert into public.agent_credentials (id, user_id, name, secret_hash)
values
  (
    '10000000-0000-4000-8000-000000000020',
    '00000000-0000-4000-8000-000000000020',
    'Primary API test agent',
    'primary-api-test-secret-hash'
  ),
  (
    '10000000-0000-4000-8000-000000000021',
    '00000000-0000-4000-8000-000000000020',
    'Other API test agent',
    'other-api-test-secret-hash'
  );

select is(
  (
    select status || ':' || created
    from public.create_agent_review(
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020',
      'agent-request-1',
      'Agent Review',
      'The responsive layout works.',
      '[{"id":"layout","prompt":"The layout fits."}]',
      'browser_video',
      'video/webm',
      1024,
      now() + interval '1 hour',
      now() + interval '1 hour'
    )
  ),
  'draft:true',
  'creates a draft Review and its Evidence atomically'
);

select is(
  (
    select count(*)::integer
    from public.reviews
    inner join public.evidence on evidence.review_id = reviews.id
    where reviews.agent_credential_id = '10000000-0000-4000-8000-000000000020'
      and reviews.client_request_id = 'agent-request-1'
  ),
  1,
  'persists exactly one Review and one Evidence record'
);

select is(
  (
    select review_id || ':' || created
    from public.create_agent_review(
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020',
      'agent-request-1',
      'Agent Review',
      'The responsive layout works.',
      '[{"id":"layout","prompt":"The layout fits."}]',
      'browser_video',
      'video/webm',
      1024,
      now() + interval '1 hour',
      now() + interval '1 hour'
    )
  ),
  (
    select id || ':false'
    from public.reviews
    where client_request_id = 'agent-request-1'
  ),
  'returns the existing Review for an identical creation retry'
);

select throws_ok(
  $$
    select *
    from public.create_agent_review(
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020',
      'agent-request-1',
      'Agent Review',
      'Different claim',
      '[{"id":"layout","prompt":"The layout fits."}]',
      'browser_video',
      'video/webm',
      1024,
      now() + interval '1 hour',
      now() + interval '1 hour'
    )
  $$,
  'P0001',
  'client request payload conflict',
  'rejects a reused request key with different content'
);

select is(
  (
    select status
    from public.create_agent_review(
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020',
      'agent-request-max',
      'Maximum upload',
      'The upload is within the basic POST limit.',
      '[{"id":"size","prompt":"The upload is accepted."}]',
      'browser_video',
      'video/webm',
      209715200,
      now() + interval '1 hour',
      now() + interval '1 hour'
    )
  ),
  'draft',
  'creates a Review at the basic Stream upload limit'
);

select is(
  (
    select evidence.size_bytes
    from public.evidence
    inner join public.reviews on reviews.id = evidence.review_id
    where reviews.client_request_id = 'agent-request-max'
  ),
  209715200::bigint,
  'accepts the 200 MiB basic Stream upload limit'
);

select throws_ok(
  $$
    select *
    from public.create_agent_review(
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020',
      'agent-request-too-large',
      'Oversized upload',
      'The upload exceeds the supported limit.',
      '[{"id":"size","prompt":"The upload is rejected."}]',
      'browser_video',
      'video/webm',
      209715201,
      now() + interval '1 hour',
      now() + interval '1 hour'
    )
  $$,
  '23514',
  null,
  'rejects Evidence larger than 200 MiB'
);

select is(
  (
    select coalesce(previous_stream_video_id, 'none')
    from public.replace_agent_review_upload(
      (select id from public.reviews where client_request_id = 'agent-request-1'),
      (
        select evidence.id
        from public.evidence
        inner join public.reviews on reviews.id = evidence.review_id
        where reviews.client_request_id = 'agent-request-1'
      ),
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020',
      'stream-upload-1'
    )
  ),
  'none',
  'attaches the first Stream upload to owned Evidence'
);

select is(
  (
    select evidence.stream_video_id
    from public.evidence
    inner join public.reviews on reviews.id = evidence.review_id
    where reviews.client_request_id = 'agent-request-1'
  ),
  'stream-upload-1',
  'persists the private Stream identifier'
);

select is(
  (
    select previous_stream_video_id
    from public.replace_agent_review_upload(
      (select id from public.reviews where client_request_id = 'agent-request-1'),
      (
        select evidence.id
        from public.evidence
        inner join public.reviews on reviews.id = evidence.review_id
        where reviews.client_request_id = 'agent-request-1'
      ),
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020',
      'stream-upload-2'
    )
  ),
  'stream-upload-1',
  'returns the replaced upload identifier for cleanup'
);

select is(
  (
    select count(*)::integer
    from public.replace_agent_review_upload(
      (select id from public.reviews where client_request_id = 'agent-request-1'),
      (
        select evidence.id
        from public.evidence
        inner join public.reviews on reviews.id = evidence.review_id
        where reviews.client_request_id = 'agent-request-1'
      ),
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000021',
      'foreign-stream-upload'
    )
  ),
  0,
  'does not attach uploads through another credential'
);

select is(
  (
    select count(*)::integer
    from public.cancel_agent_review(
      (select id from public.reviews where client_request_id = 'agent-request-1'),
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000021'
    )
  ),
  0,
  'does not cancel a Review through another credential'
);

select is(
  (
    select status || ':' || version
    from public.cancel_agent_review(
      (select id from public.reviews where client_request_id = 'agent-request-1'),
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020'
    )
  ),
  'cancelled:1',
  'cancels an owned draft Review atomically'
);

select is(
  (
    select status || ':' || version
    from public.cancel_agent_review(
      (select id from public.reviews where client_request_id = 'agent-request-1'),
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020'
    )
  ),
  'cancelled:1',
  'treats repeated cancellation as a no-op'
);

insert into public.reviews (
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
values (
  '00000000-0000-4000-8000-000000000020',
  '10000000-0000-4000-8000-000000000020',
  'agent-request-pending',
  'Pending cancellation',
  'The pending Review can be cancelled.',
  '[{"id":"cancel","prompt":"Cancellation succeeds."}]',
  'pending',
  1,
  now(),
  now() + interval '72 hours'
);

select is(
  (
    select status || ':' || version
    from public.cancel_agent_review(
      (select id from public.reviews where client_request_id = 'agent-request-pending'),
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020'
    )
  ),
  'cancelled:2',
  'cancels an owned pending Review atomically'
);

select is(
  (
    select status
    from public.transition_evidence_state(
      (
        select evidence.id
        from public.evidence
        inner join public.reviews on reviews.id = evidence.review_id
        where reviews.client_request_id = 'agent-request-max'
      ),
      'awaiting_upload',
      'processing',
      null
    )
  ),
  'processing',
  'prepares a second Review for terminal-state cancellation testing'
);
select is(
  (
    select status
    from public.transition_evidence_state(
      (
        select evidence.id
        from public.evidence
        inner join public.reviews on reviews.id = evidence.review_id
        where reviews.client_request_id = 'agent-request-max'
      ),
      'processing',
      'ready',
      null
    )
  ),
  'ready',
  'marks the second Evidence ready'
);
select is(
  (
    select status
    from public.transition_review_state(
      (select id from public.reviews where client_request_id = 'agent-request-max'),
      'draft',
      'pending',
      0
    )
  ),
  'pending',
  'submits the second Review'
);
select is(
  (
    select status
    from public.transition_review_state(
      (select id from public.reviews where client_request_id = 'agent-request-max'),
      'pending',
      'approved',
      1
    )
  ),
  'approved',
  'resolves the second Review'
);
select throws_ok(
  $$
    select *
    from public.cancel_agent_review(
      (select id from public.reviews where client_request_id = 'agent-request-max'),
      '00000000-0000-4000-8000-000000000020',
      '10000000-0000-4000-8000-000000000020'
    )
  $$,
  'P0001',
  'review cannot be cancelled',
  'does not cancel a Review after another terminal outcome'
);

select * from finish();

rollback;
