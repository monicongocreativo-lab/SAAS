begin;
select plan(12);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('b1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'quarantine-capture@example.invalid', now(), now()),
  ('b5000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'quarantine-warehouse@example.invalid', now(), now());
insert into public.companies (id, code, legal_name)
values ('b1000000-0000-4000-8000-000000000002', 'TEST-OFFLINE-Q', 'Empresa ficticia de cuarentena');
insert into public.company_memberships (id, company_id, user_id, status)
values
  ('b1000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000001', 'active'),
  ('b5000000-0000-4000-8000-000000000003', 'b1000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000001', 'active');
insert into public.sites (id, company_id, code, name)
values ('b1000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000002', 'SITE-Q', 'Sede ficticia');
insert into public.houses (id, company_id, site_id, code, name)
values ('b1000000-0000-4000-8000-000000000005', 'b1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000004', 'HOUSE-Q', 'Galpón ficticio');
insert into public.lots (id, company_id, site_id, house_id, code, status)
values ('b1000000-0000-4000-8000-000000000006', 'b1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000005', 'LOT-Q', 'active');
insert into public.role_assignments (company_id, membership_id, role_key, site_id, house_id, lot_id)
values
  ('b1000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000003', 'capture', 'b1000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000005', 'b1000000-0000-4000-8000-000000000006'),
  ('b1000000-0000-4000-8000-000000000002', 'b5000000-0000-4000-8000-000000000003', 'warehouse', 'b1000000-0000-4000-8000-000000000004', 'b1000000-0000-4000-8000-000000000005', 'b1000000-0000-4000-8000-000000000006');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'b1000000-0000-4000-8000-000000000001', true);
select set_config(
  'test.quarantine_grant',
  public.register_offline_capture_grant_v2(
    'b1000000-0000-4000-8000-000000000002',
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000004',
    'b1000000-0000-4000-8000-000000000005',
    'b1000000-0000-4000-8000-000000000006',
    'b3000000-0000-4000-8000-000000000001',
    repeat('Q', 43)
  )::text,
  true
);
select set_config(
  'test.quarantine_resolution',
  public.resolve_offline_capture_grant_v2(
    (current_setting('test.quarantine_grant')::jsonb->>'grant_id')::uuid,
    'b1000000-0000-4000-8000-000000000002',
    'b1000000-0000-4000-8000-000000000001',
    'b2000000-0000-4000-8000-000000000001',
    'b1000000-0000-4000-8000-000000000004',
    'b1000000-0000-4000-8000-000000000005',
    'b1000000-0000-4000-8000-000000000006'
  )::text,
  true
);
select is(current_setting('test.quarantine_resolution')::jsonb->>'registry_status', 'registry_current_unverified', 'resolver v2 conserva el estado explícitamente no verificado');
select is(current_setting('test.quarantine_resolution')::jsonb->>'device_key_thumbprint', repeat('Q', 43), 'resolver v2 entrega thumbprint solo tras coincidencia del ámbito');

select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select set_config(
  'test.quarantine_event',
  jsonb_build_object(
    'schema_version', 2,
    'event_id', 'b4000000-0000-4000-8000-000000000001',
    'company_id', 'b1000000-0000-4000-8000-000000000002',
    'site_id', 'b1000000-0000-4000-8000-000000000004',
    'house_id', 'b1000000-0000-4000-8000-000000000005',
    'lot_id', 'b1000000-0000-4000-8000-000000000006',
    'business_date', '2026-10-25',
    'occurrence', 1,
    'quantity_eggs', 300,
    'occurred_at', '2026-10-25T12:00:00.000Z',
    'captured_at', '2026-10-25T12:01:00.000Z',
    'actor_declared_id', 'b1000000-0000-4000-8000-000000000001',
    'device_id', 'b2000000-0000-4000-8000-000000000001'
  )::text,
  true
);
select set_config(
  'test.quarantine_binding',
  jsonb_build_object(
    'grant_id', current_setting('test.quarantine_grant')::jsonb->>'grant_id',
    'subject_user_id', 'b1000000-0000-4000-8000-000000000001',
    'attribution_status', 'pending_server_verification'
  )::text,
  true
);
select set_config(
  'test.quarantine_proof',
  '{"format":"tamago.offline-device-event-proof","schema_version":1,"jws":"synthetic-signed-proof"}',
  true
);
select set_config(
  'test.quarantine_receipt',
  public.quarantine_offline_collection_event(
    current_setting('test.quarantine_event')::jsonb,
    current_setting('test.quarantine_binding')::jsonb,
    current_setting('test.quarantine_proof')::jsonb,
    'b1000000-0000-4000-8000-000000000001',
    'verified',
    'expired',
    'grant_expired'
  )::text,
  true
);
select is(current_setting('test.quarantine_receipt')::jsonb->>'review_status', 'review_required', 'recepción expirada se conserva solo en revisión');
select is(
  (public.quarantine_offline_collection_event(
    current_setting('test.quarantine_event')::jsonb,
    current_setting('test.quarantine_binding')::jsonb,
    current_setting('test.quarantine_proof')::jsonb,
    'b1000000-0000-4000-8000-000000000001',
    'verified',
    'expired',
    'grant_expired'
  )->>'duplicate'),
  'true',
  'reenvío idéntico devuelve el recibo existente sin duplicar cuarentena'
);
select throws_ok($$
  select public.quarantine_offline_collection_event(
    jsonb_set(current_setting('test.quarantine_event')::jsonb, '{quantity_eggs}', '301'),
    current_setting('test.quarantine_binding')::jsonb,
    current_setting('test.quarantine_proof')::jsonb,
    'b1000000-0000-4000-8000-000000000001',
    'verified',
    'expired',
    'grant_expired'
  )
$$, '22023', null, 'mismo event_id con contenido cambiado crea conflicto sin reemplazar original');

select set_config(
  'test.offline_receipt_event',
  jsonb_set(
    jsonb_set(current_setting('test.quarantine_event')::jsonb, '{event_id}', '"b4000000-0000-4000-8000-000000000002"'),
    '{occurrence}',
    '2'
  )::text,
  true
);
select set_config(
  'test.offline_receipt',
  public.receive_offline_collection_event(
    current_setting('test.offline_receipt_event')::jsonb,
    (current_setting('test.quarantine_grant')::jsonb->>'grant_id')::uuid,
    'b1000000-0000-4000-8000-000000000001',
    current_setting('test.quarantine_proof')::jsonb,
    'b5000000-0000-4000-8000-000000000001'
  )::text,
  true
);
select is(current_setting('test.offline_receipt')::jsonb->>'review_status', 'pending', 'evento offline verificado conserva la revisión pendiente del flujo canónico');
select is(current_setting('test.offline_receipt')::jsonb->>'synchronization_user_id', 'b5000000-0000-4000-8000-000000000001', 'respuesta distingue a la persona que sincronizó del sujeto capturador');
select is(
  (select offline_grant_id::text from public.collection_events where event_id = 'b4000000-0000-4000-8000-000000000002'),
  current_setting('test.quarantine_grant')::jsonb->>'grant_id',
  'evento canónico persiste grant, autor de captura y prueba en la misma escritura'
);
select is(
  (select captured_by::text || ':' || capture_subject_id::text from public.collection_events where event_id = 'b4000000-0000-4000-8000-000000000002'),
  'b5000000-0000-4000-8000-000000000001:b1000000-0000-4000-8000-000000000001',
  'Postgres conserva sincronizador y capturador en campos distintos'
);
select is(
  (public.receive_offline_collection_event(
    current_setting('test.offline_receipt_event')::jsonb,
    (current_setting('test.quarantine_grant')::jsonb->>'grant_id')::uuid,
    'b1000000-0000-4000-8000-000000000001',
    current_setting('test.quarantine_proof')::jsonb,
    'b5000000-0000-4000-8000-000000000001'
  )->>'duplicate'),
  'true',
  'reintento canónico idéntico devuelve un recibo estable sin duplicar'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.role', 'authenticated', true);
select throws_ok($$
  select public.quarantine_offline_collection_event(
    current_setting('test.quarantine_event')::jsonb,
    current_setting('test.quarantine_binding')::jsonb,
    current_setting('test.quarantine_proof')::jsonb,
    'b1000000-0000-4000-8000-000000000001',
    'verified',
    'expired',
    'grant_expired'
  )
$$, '42501', null, 'usuario autenticado no puede invocar el escritor privilegiado de cuarentena');
select throws_ok($$
  select public.receive_offline_collection_event(
    current_setting('test.offline_receipt_event')::jsonb,
    (current_setting('test.quarantine_grant')::jsonb->>'grant_id')::uuid,
    'b1000000-0000-4000-8000-000000000001',
    current_setting('test.quarantine_proof')::jsonb,
    'b1000000-0000-4000-8000-000000000001'
  )
$$, '42501', null, 'usuario autenticado no puede omitir la verificación criptográfica de gateway');

select * from finish();
rollback;
