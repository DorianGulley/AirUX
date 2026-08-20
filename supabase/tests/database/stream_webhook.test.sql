begin;

select plan(17);

select has_function(
  'public',
  'process_stream_webhook',
  array['text', 'text', 'text', 'integer', 'integer', 'integer'],
  'creates the atomic Stream webhook function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.process_stream_webhook(text,text,text,integer,integer,integer)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.process_stream_webhook(text,text,text,integer,integer,integer)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.process_stream_webhook(text,text,text,integer,integer,integer)',
      'execute'
    ),
  'only the service role may process Stream webhooks'
);

insert into auth.users (id)
values ('00000000-0000-4000-8000-000000000044');

insert into public.agent_credentials (id, user_id, name, secret_hash)
values (
  '10000000-0000-4000-8000-000000000044',
  '00000000-0000-4000-8000-000000000044',
  'Stream webhook agent',
  'stream-webhook-agent-secret-hash'
);

insert into public.reviews (
  id,
  user_id,
  agent_credential_id,
  client_request_id,
  title,
  claim,
  criteria,
  expires_at
)
values
  (
    '20000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000044',
    '10000000-0000-4000-8000-000000000044',
    'stream-ready',
    'Ready Stream webhook',
    'The webhook submits this Review.',
    '[{"id":"ready","prompt":"The evidence is ready."}]',
    now() + interval '1 hour'
  ),
  (
    '20000000-0000-4000-8000-000000000042',
    '00000000-0000-4000-8000-000000000044',
    '10000000-0000-4000-8000-000000000044',
    'stream-failed',
    'Failed Stream webhook',
    'The webhook records a processing failure.',
    '[{"id":"failed","prompt":"The failure is visible."}]',
    now() + interval '1 hour'
  ),
  (
    '20000000-0000-4000-8000-000000000043',
    '00000000-0000-4000-8000-000000000044',
    '10000000-0000-4000-8000-000000000044',
    'stream-cancelled',
    'Cancelled Stream webhook',
    'Late evidence does not reopen this Review.',
    '[{"id":"cancelled","prompt":"The Review stays cancelled."}]',
    now() + interval '1 hour'
  );

insert into public.evidence (
  id,
  review_id,
  stream_video_id,
  media_type,
  size_bytes,
  delete_after
)
values
  (
    '30000000-0000-4000-8000-000000000041',
    '20000000-0000-4000-8000-000000000041',
    'stream-ready-video',
    'video/webm',
    4096,
    now() + interval '7 days'
  ),
  (
    '30000000-0000-4000-8000-000000000042',
    '20000000-0000-4000-8000-000000000042',
    'stream-failed-video',
    'video/webm',
    4096,
    now() + interval '7 days'
  ),
  (
    '30000000-0000-4000-8000-000000000043',
    '20000000-0000-4000-8000-000000000043',
    'stream-cancelled-video',
    'video/webm',
    4096,
    now() + interval '7 days'
  );

select is(
  (
    select evidence_status || ':' || review_status || ':' || review_version
    from public.process_stream_webhook(
      'stream-ready-video',
      'ready',
      null,
      15500,
      1280,
      720
    )
  ),
  'ready:pending:1',
  'makes ready Evidence reviewable atomically'
);

select is(
  (
    select duration_ms || ':' || width || ':' || height
    from public.evidence
    where id = '30000000-0000-4000-8000-000000000041'
  ),
  '15500:1280:720',
  'stores presentation metadata from Stream'
);

select isnt(
  (
    select submitted_at
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000041'
  ),
  null,
  'records when the Review becomes pending'
);

select is(
  (
    select review_version
    from public.process_stream_webhook(
      'stream-ready-video',
      'ready',
      null,
      15500,
      1280,
      720
    )
  ),
  1,
  'treats duplicate ready notifications as no-ops'
);

select is(
  (
    select evidence_status || ':' || review_status
    from public.process_stream_webhook(
      'stream-failed-video',
      'failed',
      'ERR_MALFORMED_VIDEO',
      null,
      null,
      null
    )
  ),
  'failed:draft',
  'marks failed Evidence without submitting its Review'
);

select is(
  (
    select failure_code
    from public.evidence
    where id = '30000000-0000-4000-8000-000000000042'
  ),
  'ERR_MALFORMED_VIDEO',
  'persists the bounded Stream failure code'
);

select is(
  (
    select status
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000042'
  ),
  'draft',
  'keeps a Review with failed Evidence in draft'
);

select is(
  (
    select evidence_status
    from public.process_stream_webhook(
      'stream-failed-video',
      'ready',
      null,
      15500,
      1280,
      720
    )
  ),
  'failed',
  'does not revive terminal failed Evidence'
);

select is(
  (
    select count(*)::integer
    from public.process_stream_webhook(
      'unknown-stream-video',
      'ready',
      null,
      15500,
      1280,
      720
    )
  ),
  0,
  'ignores videos that are not attached to AirUX Evidence'
);

select throws_ok(
  $$
    select *
    from public.process_stream_webhook(
      'stream-ready-video',
      'processing',
      null,
      null,
      null,
      null
    )
  $$,
  'P0001',
  'invalid Stream webhook transition',
  'rejects unsupported target states'
);

select throws_ok(
  $$
    select *
    from public.process_stream_webhook(
      'stream-ready-video',
      'ready',
      null,
      0,
      1280,
      720
    )
  $$,
  'P0001',
  'invalid Stream webhook metadata',
  'rejects invalid ready metadata'
);

select is(
  (
    select status
    from public.transition_review_state(
      '20000000-0000-4000-8000-000000000043',
      'draft',
      'cancelled',
      0
    )
  ),
  'cancelled',
  'prepares a cancelled Review for a late webhook'
);

select is(
  (
    select evidence_status || ':' || review_status
    from public.process_stream_webhook(
      'stream-cancelled-video',
      'ready',
      null,
      15500,
      1280,
      720
    )
  ),
  'ready:cancelled',
  'records late ready Evidence without reopening a cancelled Review'
);

select is(
  (
    select status
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000043'
  ),
  'cancelled',
  'preserves the terminal Review state'
);

select throws_ok(
  $$
    select *
    from public.process_stream_webhook(
      'stream-failed-video',
      'failed',
      null,
      null,
      null,
      null
    )
  $$,
  'P0001',
  'invalid Stream webhook failure',
  'requires a failure code for failed processing'
);

select * from finish();

rollback;
