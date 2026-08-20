begin;

select plan(21);

select has_function(
  'public',
  'transition_review_state',
  array['uuid', 'text', 'text', 'integer'],
  'creates the Review transition function'
);
select has_function(
  'public',
  'transition_evidence_state',
  array['uuid', 'text', 'text', 'text'],
  'creates the Evidence transition function'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.transition_review_state(uuid,text,text,integer)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.transition_review_state(uuid,text,text,integer)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.transition_review_state(uuid,text,text,integer)',
      'execute'
    ),
  'only the service role may transition Reviews'
);
select ok(
  has_function_privilege(
    'service_role',
    'public.transition_evidence_state(uuid,text,text,text)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.transition_evidence_state(uuid,text,text,text)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.transition_evidence_state(uuid,text,text,text)',
      'execute'
    ),
  'only the service role may transition Evidence'
);

with states(status) as (
  values
    ('draft'),
    ('pending'),
    ('approved'),
    ('changes_requested'),
    ('cancelled'),
    ('expired')
)
select is(
  (
    select count(*)::integer
    from states as source
    cross join states as target
    where public.is_allowed_review_state_transition(source.status, target.status)
      is distinct from (
        source.status = target.status
        or (
          source.status = 'draft'
          and target.status in ('pending', 'cancelled', 'expired')
        )
        or (
          source.status = 'pending'
          and target.status in (
            'approved',
            'changes_requested',
            'cancelled',
            'expired'
          )
        )
      )
  ),
  0,
  'defines exactly the approved Review transition graph'
);

with states(status) as (
  values
    ('awaiting_upload'),
    ('processing'),
    ('ready'),
    ('failed'),
    ('deleting'),
    ('deleted')
)
select is(
  (
    select count(*)::integer
    from states as source
    cross join states as target
    where public.is_allowed_evidence_state_transition(source.status, target.status)
      is distinct from (
        source.status = target.status
        or (
          source.status = 'awaiting_upload'
          and target.status in ('processing', 'failed', 'deleting')
        )
        or (
          source.status = 'processing'
          and target.status in ('ready', 'failed', 'deleting')
        )
        or (source.status in ('ready', 'failed') and target.status = 'deleting')
        or (source.status = 'deleting' and target.status = 'deleted')
      )
  ),
  0,
  'defines exactly the approved Evidence transition graph'
);

insert into auth.users (id)
values ('00000000-0000-4000-8000-000000000010');

insert into public.agent_credentials (id, user_id, name, secret_hash)
values (
  '10000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000010',
  'Transition test agent',
  'transition-test-secret-hash'
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
  '20000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000000010',
  '10000000-0000-4000-8000-000000000010',
  'transition-request',
  'Transition review',
  'The lifecycle advances safely.',
  '[{"id":"lifecycle","prompt":"The evidence is ready before review."}]',
  now() + interval '1 hour'
);

insert into public.evidence (
  id,
  review_id,
  media_type,
  size_bytes,
  delete_after
)
values (
  '30000000-0000-4000-8000-000000000010',
  '20000000-0000-4000-8000-000000000010',
  'video/webm',
  1024,
  now() + interval '7 days'
);

select throws_ok(
  $$
    select *
    from public.transition_review_state(
      '20000000-0000-4000-8000-000000000010',
      'draft',
      'pending',
      0
    )
  $$,
  'P0001',
  'review evidence is not ready',
  'does not submit a Review before its Evidence is ready'
);

select throws_ok(
  $$
    update public.evidence
    set status = 'ready'
    where id = '30000000-0000-4000-8000-000000000010'
  $$,
  'P0001',
  'invalid evidence state transition',
  'rejects invalid direct Evidence updates'
);

select is(
  (
    select status
    from public.transition_evidence_state(
      '30000000-0000-4000-8000-000000000010',
      'awaiting_upload',
      'processing',
      null
    )
  ),
  'processing',
  'moves Evidence into processing'
);
select is(
  (
    select status
    from public.transition_evidence_state(
      '30000000-0000-4000-8000-000000000010',
      'processing',
      'ready',
      null
    )
  ),
  'ready',
  'moves processed Evidence into ready'
);

select is(
  (
    select status || ':' || version
    from public.transition_review_state(
      '20000000-0000-4000-8000-000000000010',
      'draft',
      'pending',
      0
    )
  ),
  'pending:1',
  'submits a Review and increments its version'
);
select isnt(
  (
    select submitted_at
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000010'
  ),
  null,
  'records when a Review becomes pending'
);
select is(
  (
    select version
    from public.transition_review_state(
      '20000000-0000-4000-8000-000000000010',
      'pending',
      'pending',
      1
    )
  ),
  1,
  'treats a same-state retry as a no-op'
);
select is(
  (
    select count(*)::integer
    from public.transition_review_state(
      '20000000-0000-4000-8000-000000000010',
      'pending',
      'approved',
      0
    )
  ),
  0,
  'does not mutate a Review when its expected version is stale'
);
select is(
  (
    select status || ':' || version
    from public.transition_review_state(
      '20000000-0000-4000-8000-000000000010',
      'pending',
      'approved',
      1
    )
  ),
  'approved:2',
  'resolves a pending Review'
);
select isnt(
  (
    select resolved_at
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000010'
  ),
  null,
  'records when a Review reaches a terminal state'
);
select throws_ok(
  $$
    select *
    from public.transition_review_state(
      '20000000-0000-4000-8000-000000000010',
      'approved',
      'pending',
      2
    )
  $$,
  'P0001',
  'invalid review state transition',
  'does not reopen a terminal Review'
);

select is(
  (
    select status
    from public.transition_evidence_state(
      '30000000-0000-4000-8000-000000000010',
      'ready',
      'deleting',
      null
    )
  ),
  'deleting',
  'schedules ready Evidence for deletion'
);
select is(
  (
    select status
    from public.transition_evidence_state(
      '30000000-0000-4000-8000-000000000010',
      'deleting',
      'deleted',
      null
    )
  ),
  'deleted',
  'marks deleting Evidence as deleted'
);
select isnt(
  (
    select deleted_at
    from public.evidence
    where id = '30000000-0000-4000-8000-000000000010'
  ),
  null,
  'records when Evidence is deleted'
);
select throws_ok(
  $$
    update public.reviews
    set status = 'pending'
    where id = '20000000-0000-4000-8000-000000000010'
  $$,
  'P0001',
  'invalid review state transition',
  'rejects invalid direct Review updates'
);

select * from finish();

rollback;
