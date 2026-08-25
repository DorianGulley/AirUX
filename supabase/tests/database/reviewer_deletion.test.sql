begin;

select plan(18);

select has_function(
  'public',
  'delete_reviewer_review',
  array['uuid', 'uuid'],
  'creates the reviewer Review deletion function'
);

select ok(
  has_function_privilege(
    'service_role',
    'public.delete_reviewer_review(uuid,uuid)',
    'execute'
  )
    and not has_function_privilege(
      'anon',
      'public.delete_reviewer_review(uuid,uuid)',
      'execute'
    )
    and not has_function_privilege(
      'authenticated',
      'public.delete_reviewer_review(uuid,uuid)',
      'execute'
    ),
  'only the service role may delete reviewer Reviews'
);

insert into auth.users (id)
values
  ('00000000-0000-4000-8000-000000000080'),
  ('00000000-0000-4000-8000-000000000081');

insert into public.agent_credentials (id, user_id, name, secret_hash)
values
  (
    '10000000-0000-4000-8000-000000000080',
    '00000000-0000-4000-8000-000000000080',
    'Reviewer deletion owner agent',
    'reviewer-deletion-owner-secret-hash'
  ),
  (
    '10000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-000000000081',
    'Reviewer deletion foreign agent',
    'reviewer-deletion-foreign-secret-hash'
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
    '20000000-0000-4000-8000-000000000080',
    '00000000-0000-4000-8000-000000000080',
    '10000000-0000-4000-8000-000000000080',
    'reviewer-delete-pending',
    'Delete pending Review',
    'Deleting a pending Review revokes access.',
    '[{"id":"pending","prompt":"Delete the pending Review."}]',
    'pending',
    1,
    now() - interval '1 hour',
    now() - interval '30 minutes',
    now() + interval '72 hours',
    null
  ),
  (
    '20000000-0000-4000-8000-000000000081',
    '00000000-0000-4000-8000-000000000080',
    '10000000-0000-4000-8000-000000000080',
    'reviewer-delete-approved',
    'Delete approved Review',
    'Deleting a terminal Review preserves its outcome.',
    '[{"id":"approved","prompt":"Preserve the approved outcome."}]',
    'approved',
    4,
    now() - interval '2 hours',
    now() - interval '90 minutes',
    now() + interval '72 hours',
    now() - interval '1 hour'
  ),
  (
    '20000000-0000-4000-8000-000000000082',
    '00000000-0000-4000-8000-000000000081',
    '10000000-0000-4000-8000-000000000081',
    'reviewer-delete-foreign',
    'Foreign Review',
    'Another reviewer cannot delete this Review.',
    '[{"id":"owner","prompt":"Enforce Review ownership."}]',
    'pending',
    1,
    now() - interval '1 hour',
    now() - interval '30 minutes',
    now() + interval '72 hours',
    null
  ),
  (
    '20000000-0000-4000-8000-000000000083',
    '00000000-0000-4000-8000-000000000080',
    '10000000-0000-4000-8000-000000000080',
    'reviewer-delete-draft',
    'Delete draft Review',
    'Deleting a draft without an upload schedules local cleanup.',
    '[{"id":"draft","prompt":"Delete the draft Review."}]',
    'draft',
    0,
    now() - interval '1 hour',
    null,
    now() + interval '1 hour',
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
    '30000000-0000-4000-8000-000000000080',
    '20000000-0000-4000-8000-000000000080',
    'ready',
    'reviewer-delete-pending-video',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() + interval '72 hours',
    now() - interval '1 hour'
  ),
  (
    '30000000-0000-4000-8000-000000000081',
    '20000000-0000-4000-8000-000000000081',
    'ready',
    'reviewer-delete-approved-video',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() + interval '7 days',
    now() - interval '2 hours'
  ),
  (
    '30000000-0000-4000-8000-000000000082',
    '20000000-0000-4000-8000-000000000082',
    'ready',
    'reviewer-delete-foreign-video',
    'video/webm',
    1024,
    15000,
    1280,
    720,
    now() + interval '72 hours',
    now() - interval '1 hour'
  ),
  (
    '30000000-0000-4000-8000-000000000083',
    '20000000-0000-4000-8000-000000000083',
    'awaiting_upload',
    null,
    'video/webm',
    1024,
    null,
    null,
    null,
    now() + interval '1 hour',
    now() - interval '1 hour'
  );

select is(
  (
    select review_status || ':' || review_version || ':' || evidence_status
    from public.delete_reviewer_review(
      '20000000-0000-4000-8000-000000000080',
      '00000000-0000-4000-8000-000000000080'
    )
  ),
  'cancelled:2:deleting',
  'deletes an owned pending Review and starts Evidence deletion'
);

select isnt(
  (
    select deleted_at
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000080'
  ),
  null,
  'records the Review deletion timestamp'
);

select isnt(
  (
    select resolved_at
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000080'
  ),
  null,
  'resolves an open Review as cancelled during deletion'
);

select ok(
  (
    select delete_after <= clock_timestamp()
    from public.evidence
    where id = '30000000-0000-4000-8000-000000000080'
  ),
  'makes deleted Review Evidence immediately due'
);

select is(
  (
    select review_deleted_at
    from public.delete_reviewer_review(
      '20000000-0000-4000-8000-000000000080',
      '00000000-0000-4000-8000-000000000080'
    )
  ),
  (
    select deleted_at
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000080'
  ),
  'returns the original timestamp on repeated deletion'
);

select is(
  (
    select review_status || ':' || review_version || ':' || evidence_status
    from public.delete_reviewer_review(
      '20000000-0000-4000-8000-000000000080',
      '00000000-0000-4000-8000-000000000080'
    )
  ),
  'cancelled:2:deleting',
  'keeps repeated deletion idempotent'
);

select is(
  (
    select count(*)::integer
    from public.prepare_due_evidence_cleanup(clock_timestamp(), 100)
    where evidence_id = '30000000-0000-4000-8000-000000000080'
  ),
  1,
  'makes the deleted pending Review eligible for scheduled cleanup'
);

select is(
  (
    select review_status || ':' || review_version || ':' || evidence_status
    from public.delete_reviewer_review(
      '20000000-0000-4000-8000-000000000081',
      '00000000-0000-4000-8000-000000000080'
    )
  ),
  'approved:4:deleting',
  'preserves a terminal Review outcome while deleting its Evidence'
);

select is(
  (
    select count(*)::integer
    from public.decisions
    where review_id = '20000000-0000-4000-8000-000000000081'
  ),
  0,
  'does not create or replace a Decision during deletion'
);

select is(
  (
    select count(*)::integer
    from public.delete_reviewer_review(
      '20000000-0000-4000-8000-000000000082',
      '00000000-0000-4000-8000-000000000080'
    )
  ),
  0,
  'does not reveal a Review owned by another reviewer'
);

select is(
  (
    select count(*)::integer
    from public.delete_reviewer_review(
      '20000000-0000-4000-8000-000000000099',
      '00000000-0000-4000-8000-000000000080'
    )
  ),
  0,
  'returns the same empty result for a missing Review'
);

select is(
  (
    select status || ':' || version || ':' || (deleted_at is null)::text
    from public.reviews
    where id = '20000000-0000-4000-8000-000000000082'
  ),
  'pending:1:true',
  'leaves a foreign Review unchanged'
);

select is(
  (
    select review_status || ':' || review_version || ':' || evidence_status
    from public.delete_reviewer_review(
      '20000000-0000-4000-8000-000000000083',
      '00000000-0000-4000-8000-000000000080'
    )
  ),
  'cancelled:1:deleting',
  'deletes a draft Review without an uploaded Stream video'
);

select is(
  (
    select stream_video_id
    from public.evidence
    where id = '30000000-0000-4000-8000-000000000083'
  ),
  null,
  'preserves the absent Stream identifier for local-only cleanup'
);

select is(
  (
    select count(*)::integer
    from public.prepare_due_evidence_cleanup(clock_timestamp(), 100)
    where evidence_id in (
      '30000000-0000-4000-8000-000000000081',
      '30000000-0000-4000-8000-000000000083'
    )
  ),
  2,
  'schedules terminal and upload-free Evidence for cleanup'
);

select is(
  (
    select count(*)::integer
    from public.reviews
    where id in (
      '20000000-0000-4000-8000-000000000080',
      '20000000-0000-4000-8000-000000000081',
      '20000000-0000-4000-8000-000000000083'
    )
      and deleted_at is not null
  ),
  3,
  'soft-deletes every owned Review without removing its audit record'
);

select * from finish();

rollback;
