begin;

select plan(15);

select has_function(
  'public',
  'delete_stale_revoked_agent_credentials',
  array['timestamp with time zone', 'integer'],
  'creates the revoked credential cleanup function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.delete_stale_revoked_agent_credentials(timestamp with time zone,integer)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.delete_stale_revoked_agent_credentials(timestamp with time zone,integer)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.delete_stale_revoked_agent_credentials(timestamp with time zone,integer)',
      'execute'
    ),
  'only the service role may delete stale revoked credentials'
);

select ok(
  to_regclass('public.agent_credentials_user_created_at_idx') is not null,
  'indexes credential creation history by owner'
);

select ok(
  to_regclass('public.agent_credentials_revoked_at_idx') is not null,
  'indexes revoked credentials for cleanup'
);

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000071'),
  ('00000000-0000-4000-8000-000000000072');

insert into public.agent_credentials (
  user_id,
  name,
  secret_hash,
  created_at,
  revoked_at
)
select
  '00000000-0000-4000-8000-000000000071',
  'Daily quota credential ' || credential_number,
  'daily-quota-hash-' || credential_number,
  now() - interval '1 hour',
  now()
from generate_series(1, 50) as credential_number;

select throws_ok(
  $$
    insert into public.agent_credentials (user_id, name, secret_hash)
    values (
      '00000000-0000-4000-8000-000000000071',
      'Over daily quota',
      'over-daily-quota-hash'
    )
  $$,
  'P0001',
  'daily agent credential creation quota exceeded',
  'limits each reviewer to 50 credential creations in 24 hours'
);

update public.agent_credentials
set created_at = now() - interval '25 hours'
where user_id = '00000000-0000-4000-8000-000000000071'
  and name = 'Daily quota credential 1';

select lives_ok(
  $$
    insert into public.agent_credentials (user_id, name, secret_hash)
    values (
      '00000000-0000-4000-8000-000000000071',
      'Next rolling-window credential',
      'next-rolling-window-hash'
    )
  $$,
  'allows creation after an older credential leaves the rolling window'
);

insert into public.agent_credentials (
  id,
  user_id,
  name,
  secret_hash,
  created_at,
  revoked_at
)
values
  (
    '10000000-0000-4000-8000-000000000071',
    '00000000-0000-4000-8000-000000000072',
    'Old unreferenced credential one',
    'old-unreferenced-hash-one',
    now() - interval '32 days',
    now() - interval '31 days'
  ),
  (
    '10000000-0000-4000-8000-000000000072',
    '00000000-0000-4000-8000-000000000072',
    'Old unreferenced credential two',
    'old-unreferenced-hash-two',
    now() - interval '32 days',
    now() - interval '31 days'
  ),
  (
    '10000000-0000-4000-8000-000000000073',
    '00000000-0000-4000-8000-000000000072',
    'Recent revoked credential',
    'recent-revoked-hash',
    now() - interval '10 days',
    now() - interval '9 days'
  ),
  (
    '10000000-0000-4000-8000-000000000074',
    '00000000-0000-4000-8000-000000000072',
    'Referenced revoked credential',
    'referenced-revoked-hash',
    now() - interval '32 days',
    now() - interval '31 days'
  ),
  (
    '10000000-0000-4000-8000-000000000075',
    '00000000-0000-4000-8000-000000000072',
    'Active credential',
    'active-hash',
    now() - interval '32 days',
    null
  );

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
  '00000000-0000-4000-8000-000000000072',
  '10000000-0000-4000-8000-000000000074',
  'retained-credential-review',
  'Retained credential Review',
  'The referenced credential remains available for provenance.',
  '[{"id":"retention","prompt":"Retain credential provenance."}]',
  now() + interval '1 hour'
);

select is(
  (
    select deleted_count
    from public.delete_stale_revoked_agent_credentials(
      clock_timestamp(),
      1
    )
  ),
  1,
  'deletes only the requested credential batch size'
);

select is(
  (
    select count(*)::integer
    from public.agent_credentials
    where id in (
      '10000000-0000-4000-8000-000000000071',
      '10000000-0000-4000-8000-000000000072'
    )
  ),
  1,
  'leaves the remaining stale credential eligible for a later batch'
);

select is(
  (
    select deleted_count
    from public.delete_stale_revoked_agent_credentials(
      clock_timestamp(),
      100
    )
  ),
  1,
  'deletes the remaining stale unreferenced credential'
);

select is(
  (
    select count(*)::integer
    from public.agent_credentials
    where id = '10000000-0000-4000-8000-000000000073'
  ),
  1,
  'retains revoked credentials within the 30-day grace period'
);

select is(
  (
    select count(*)::integer
    from public.agent_credentials
    where id = '10000000-0000-4000-8000-000000000074'
  ),
  1,
  'retains revoked credentials referenced by Reviews'
);

select is(
  (
    select count(*)::integer
    from public.agent_credentials
    where id = '10000000-0000-4000-8000-000000000075'
  ),
  1,
  'retains active credentials regardless of age'
);

select is(
  (
    select deleted_count
    from public.delete_stale_revoked_agent_credentials(
      clock_timestamp(),
      100
    )
  ),
  0,
  'repeats cleanup as an idempotent success'
);

select throws_ok(
  $$
    select *
    from public.delete_stale_revoked_agent_credentials(
      clock_timestamp() + interval '10 minutes',
      100
    )
  $$,
  'P0001',
  'invalid credential cleanup request',
  'rejects a cleanup boundary too far in the future'
);

select throws_ok(
  $$
    select *
    from public.delete_stale_revoked_agent_credentials(
      clock_timestamp(),
      101
    )
  $$,
  'P0001',
  'invalid credential cleanup request',
  'rejects an unbounded cleanup batch'
);

select * from finish();

rollback;
