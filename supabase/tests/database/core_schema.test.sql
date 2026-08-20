begin;

select plan(43);

select has_table('public', 'agent_credentials', 'creates AgentCredential storage');
select has_table('public', 'reviews', 'creates Review storage');
select has_table('public', 'evidence', 'creates Evidence storage');
select has_table('public', 'decisions', 'creates Decision storage');

select col_type_is('public', 'agent_credentials', 'id', 'uuid', 'uses UUID credential IDs');
select col_type_is('public', 'reviews', 'criteria', 'jsonb', 'stores criteria as JSONB');
select col_type_is('public', 'evidence', 'size_bytes', 'bigint', 'supports bounded media sizes');
select col_type_is('public', 'decisions', 'outcome', 'text', 'stores evolvable text states');

select has_pk('public', 'agent_credentials', 'credentials have a primary key');
select has_pk('public', 'reviews', 'reviews have a primary key');
select has_pk('public', 'evidence', 'evidence has a primary key');
select has_pk('public', 'decisions', 'decisions have a primary key');

select ok(
  to_regclass('public.agent_credentials_user_id_idx') is not null,
  'indexes credentials by owner'
);
select ok(
  to_regclass('public.reviews_user_status_created_at_idx') is not null,
  'indexes owner Review listings'
);
select ok(
  to_regclass('public.reviews_agent_credential_status_created_at_idx') is not null,
  'indexes open Reviews by agent credential'
);
select ok(
  to_regclass('public.evidence_due_deletion_idx') is not null,
  'indexes Evidence due for cleanup'
);

select fk_ok(
  'public',
  'reviews',
  array['agent_credential_id', 'user_id'],
  'public',
  'agent_credentials',
  array['id', 'user_id'],
  'review credentials must belong to the review owner'
);
select fk_ok(
  'public',
  'decisions',
  array['review_id', 'user_id'],
  'public',
  'reviews',
  array['id', 'user_id'],
  'decision makers must own the review'
);

select is(
  (select relrowsecurity from pg_class where oid = 'public.agent_credentials'::regclass),
  true,
  'credentials have row-level security enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.reviews'::regclass),
  true,
  'reviews have row-level security enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.evidence'::regclass),
  true,
  'evidence has row-level security enabled'
);
select is(
  (select relrowsecurity from pg_class where oid = 'public.decisions'::regclass),
  true,
  'decisions have row-level security enabled'
);

select is(
  (select count(*)::integer from pg_policies where schemaname = 'public' and tablename in (
    'agent_credentials', 'reviews', 'evidence', 'decisions'
  )),
  0,
  'browser roles have no table policies'
);
select ok(
  not has_table_privilege('anon', 'public.reviews', 'select')
    and not has_table_privilege('authenticated', 'public.reviews', 'select'),
  'browser roles cannot read reviews directly'
);
select ok(
  has_table_privilege('service_role', 'public.reviews', 'select,insert,update,delete'),
  'the trusted service role can manage reviews'
);
select ok(
  has_function_privilege('service_role', 'public.is_valid_review_criteria(jsonb)', 'execute')
    and not has_function_privilege('anon', 'public.is_valid_review_criteria(jsonb)', 'execute')
    and not has_function_privilege('authenticated', 'public.is_valid_review_criteria(jsonb)', 'execute'),
  'only the trusted service role can execute the criteria validator'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.enforce_active_agent_credential_quota()',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.enforce_active_agent_credential_quota()',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.enforce_active_agent_credential_quota()',
      'execute'
    ),
  'only the trusted service role can execute the credential quota trigger'
);

select ok(
  public.is_valid_review_criteria('[{"id":"layout","prompt":"Fits the viewport"}]'::jsonb),
  'accepts valid review criteria'
);
select ok(
  not public.is_valid_review_criteria('[{"id":"layout","prompt":"First"},{"id":"layout","prompt":"Second"}]'::jsonb),
  'rejects duplicate criterion IDs'
);
select ok(
  not public.is_valid_review_criteria('[{"id":"layout","prompt":"Fits","extra":true}]'::jsonb),
  'rejects undocumented criterion fields'
);
select ok(
  not public.is_valid_review_criteria('[{"id":" layout ","prompt":"Fits"}]'::jsonb),
  'requires normalized criterion text'
);

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000001'),
  ('00000000-0000-4000-8000-000000000002');

insert into public.agent_credentials (id, user_id, name, secret_hash)
values (
  '10000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'Test agent',
  'test-secret-hash'
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
values (
  '20000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'request-1',
  'Review title',
  'The feature works.',
  '[{"id":"layout","prompt":"Fits the viewport"}]',
  now() + interval '1 hour'
);

select is(
  (select status || ':' || version from public.reviews where client_request_id = 'request-1'),
  'draft:0',
  'new reviews receive draft state and version defaults'
);

select throws_ok(
  $$
    insert into public.reviews (
      user_id, agent_credential_id, client_request_id, title, claim, criteria, expires_at
    ) values (
      '00000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000001',
      'wrong-owner',
      'Review title',
      'The feature works.',
      '[{"id":"layout","prompt":"Fits the viewport"}]',
      now() + interval '1 hour'
    )
  $$,
  '23503',
  null,
  'rejects a credential owned by another user'
);

select throws_ok(
  $$
    insert into public.reviews (
      user_id, agent_credential_id, client_request_id, title, claim, criteria, expires_at
    ) values (
      '00000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      'request-1',
      'Review title',
      'The feature works.',
      '[{"id":"layout","prompt":"Fits the viewport"}]',
      now() + interval '1 hour'
    )
  $$,
  '23505',
  null,
  'enforces creation idempotency per credential'
);

select throws_ok(
  $$
    update public.reviews
    set criteria = '[{"id":"layout","prompt":"Fits","extra":true}]'
    where id = '20000000-0000-4000-8000-000000000001'
  $$,
  '23514',
  null,
  'enforces the criteria contract on stored reviews'
);

select throws_ok(
  $$
    insert into public.evidence (
      review_id, media_type, size_bytes, delete_after
    ) values (
      '20000000-0000-4000-8000-000000000001',
      'image/png',
      1024,
      now() + interval '7 days'
    )
  $$,
  '23514',
  null,
  'rejects non-video evidence'
);

insert into public.evidence (
  id,
  review_id,
  media_type,
  size_bytes,
  delete_after
)
values (
  '30000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001',
  'video/webm',
  1024,
  now() + interval '7 days'
);

select throws_ok(
  $$
    insert into public.evidence (
      review_id, media_type, size_bytes, delete_after
    ) values (
      '20000000-0000-4000-8000-000000000001',
      'video/webm',
      1024,
      now() + interval '7 days'
    )
  $$,
  '23505',
  null,
  'allows only one Evidence record per Review'
);

select throws_ok(
  $$
    insert into public.decisions (review_id, user_id, outcome)
    values (
      '20000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      'changes_requested'
    )
  $$,
  '23514',
  null,
  'requires feedback when changes are requested'
);

select throws_ok(
  $$
    insert into public.decisions (review_id, user_id, outcome)
    values (
      '20000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      'approved'
    )
  $$,
  '23503',
  null,
  'rejects a decision from a user who does not own the Review'
);

insert into public.decisions (review_id, user_id, outcome)
values (
  '20000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000001',
  'approved'
);

insert into public.agent_credentials (user_id, name, secret_hash)
select
  '00000000-0000-4000-8000-000000000001',
  'Quota credential ' || credential_number,
  'quota-hash-' || credential_number
from generate_series(2, 20) as credential_number;

select throws_ok(
  $$
    insert into public.agent_credentials (user_id, name, secret_hash)
    values (
      '00000000-0000-4000-8000-000000000001',
      'Over quota',
      'over-quota-hash'
    )
  $$,
  'P0001',
  'active agent credential quota exceeded',
  'limits each reviewer to 20 active credentials'
);

update public.agent_credentials
set revoked_at = now()
where id = '10000000-0000-4000-8000-000000000001';

select lives_ok(
  $$
    insert into public.agent_credentials (user_id, name, secret_hash)
    values (
      '00000000-0000-4000-8000-000000000001',
      'Replacement credential',
      'replacement-hash'
    )
  $$,
  'revoking a credential frees an active quota slot'
);

select throws_ok(
  $$
    insert into public.decisions (review_id, user_id, outcome)
    values (
      '20000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000001',
      'approved'
    )
  $$,
  '23505',
  null,
  'allows only one terminal Decision per Review'
);

select throws_ok(
  $$
    delete from public.reviews
    where id = '20000000-0000-4000-8000-000000000001'
  $$,
  '23503',
  null,
  'restricts hard deletion while dependent evidence exists'
);

select * from finish();

rollback;
