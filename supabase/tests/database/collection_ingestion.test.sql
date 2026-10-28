begin;
select plan(9);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('81000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated', 'capture-scope@example.invalid', now(), now()),
  ('82000000-0000-4000-8000-000000000008', 'authenticated', 'authenticated', 'other-scope@example.invalid', now(), now());
insert into public.companies (id, code, legal_name)
values ('81000000-0000-4000-8000-000000000008', 'TEST-COLLECTION', 'Empresa ficticia de recogidas');
insert into public.company_memberships (id, company_id, user_id, status)
values
  ('81100000-0000-4000-8000-000000000008', '81000000-0000-4000-8000-000000000008', '81000000-0000-4000-8000-000000000008', 'active'),
  ('81200000-0000-4000-8000-000000000008', '81000000-0000-4000-8000-000000000008', '82000000-0000-4000-8000-000000000008', 'active');
insert into public.sites (id, company_id, code, name)
values
  ('81300000-0000-4000-8000-000000000008', '81000000-0000-4000-8000-000000000008', 'SITE-C', 'Sede ficticia'),
  ('81300000-0000-4000-8000-000000000009', '81000000-0000-4000-8000-000000000008', 'SITE-D', 'Otra sede ficticia');
insert into public.houses (id, company_id, site_id, code, name)
values ('81400000-0000-4000-8000-000000000008', '81000000-0000-4000-8000-000000000008', '81300000-0000-4000-8000-000000000008', 'HOUSE-C', 'Galpón ficticio');
insert into public.lots (id, company_id, site_id, house_id, code, status)
values
  ('81500000-0000-4000-8000-000000000008', '81000000-0000-4000-8000-000000000008', '81300000-0000-4000-8000-000000000008', '81400000-0000-4000-8000-000000000008', 'LOT-C', 'active'),
  ('81500000-0000-4000-8000-000000000009', '81000000-0000-4000-8000-000000000008', '81300000-0000-4000-8000-000000000008', '81400000-0000-4000-8000-000000000008', 'LOT-D', 'active');
insert into public.role_assignments (company_id, membership_id, role_key, site_id, house_id, lot_id)
values
  ('81000000-0000-4000-8000-000000000008', '81100000-0000-4000-8000-000000000008', 'capture', '81300000-0000-4000-8000-000000000008', '81400000-0000-4000-8000-000000000008', '81500000-0000-4000-8000-000000000008'),
  ('81000000-0000-4000-8000-000000000008', '81100000-0000-4000-8000-000000000008', 'capture', '81300000-0000-4000-8000-000000000008', '81400000-0000-4000-8000-000000000008', '81500000-0000-4000-8000-000000000009'),
  ('81000000-0000-4000-8000-000000000008', '81200000-0000-4000-8000-000000000008', 'capture', '81300000-0000-4000-8000-000000000009', null, null);

set local role authenticated;
select set_config('request.jwt.claim.sub', '81000000-0000-4000-8000-000000000008', true);
select ok(private.can_capture_lot('81000000-0000-4000-8000-000000000008', '81300000-0000-4000-8000-000000000008', '81400000-0000-4000-8000-000000000008', '81500000-0000-4000-8000-000000000008'), 'la asignación por lote permite capturar en su ámbito');
select ok(private.can_capture_lot('81000000-0000-4000-8000-000000000008', '81300000-0000-4000-8000-000000000008', '81400000-0000-4000-8000-000000000008', '81500000-0000-4000-8000-000000000009'), 'la misma persona puede recibir el rol en más de un lote');
select is((public.receive_collection_event('{"schema_version":2,"event_id":"81600000-0000-4000-8000-000000000008","company_id":"81000000-0000-4000-8000-000000000008","site_id":"81300000-0000-4000-8000-000000000008","house_id":"81400000-0000-4000-8000-000000000008","lot_id":"81500000-0000-4000-8000-000000000008","business_date":"2026-10-23","occurrence":1,"quantity_eggs":300,"occurred_at":"2026-10-23T12:00:00Z","captured_at":"2026-10-23T12:01:00Z","actor_declared_id":"tablet-ficticia","device_id":"81700000-0000-4000-8000-000000000008"}'::jsonb)->>'receipt_status'), 'received', 'la API recibe el evento con JWT del usuario');
select is((public.receive_collection_event('{"schema_version":2,"event_id":"81600000-0000-4000-8000-000000000008","company_id":"81000000-0000-4000-8000-000000000008","site_id":"81300000-0000-4000-8000-000000000008","house_id":"81400000-0000-4000-8000-000000000008","lot_id":"81500000-0000-4000-8000-000000000008","business_date":"2026-10-23","occurrence":1,"quantity_eggs":300,"occurred_at":"2026-10-23T12:00:00Z","captured_at":"2026-10-23T12:01:00Z","actor_declared_id":"tablet-ficticia","device_id":"81700000-0000-4000-8000-000000000008"}'::jsonb)->>'duplicate'), 'true', 'reintentar el mismo ID y contenido no duplica');
select is((select count(*)::integer from public.collection_events), 1, 'hay una sola fila tras repetir el evento');
select is((select captured_by from public.collection_events limit 1), '81000000-0000-4000-8000-000000000008'::uuid, 'el usuario acreditado proviene de auth.uid');
select is((select review_status from public.collection_events limit 1), 'pending', 'recepción no cierra revisión operativa');
select throws_ok($$ select public.receive_collection_event('{"schema_version":2,"event_id":"81800000-0000-4000-8000-000000000008","company_id":"81000000-0000-4000-8000-000000000008","site_id":"81300000-0000-4000-8000-000000000008","house_id":"81400000-0000-4000-8000-000000000008","lot_id":"81500000-0000-4000-8000-000000000008","business_date":"2026-10-23","occurrence":1,"quantity_eggs":301,"occurred_at":"2026-10-23T12:00:00Z","captured_at":"2026-10-23T12:02:00Z","actor_declared_id":"tablet-ficticia","device_id":"81700000-0000-4000-8000-000000000008"}'::jsonb) $$, '23505', null, 'otro ID no puede reutilizar la misma ocurrencia diaria');
select set_config('request.jwt.claim.sub', '82000000-0000-4000-8000-000000000008', true);
select throws_ok($$ select public.receive_collection_event('{"schema_version":2,"event_id":"81900000-0000-4000-8000-000000000008","company_id":"81000000-0000-4000-8000-000000000008","site_id":"81300000-0000-4000-8000-000000000008","house_id":"81400000-0000-4000-8000-000000000008","lot_id":"81500000-0000-4000-8000-000000000008","business_date":"2026-10-23","occurrence":2,"quantity_eggs":300,"occurred_at":"2026-10-23T12:00:00Z","captured_at":"2026-10-23T12:01:00Z","actor_declared_id":"tablet-ajena","device_id":"81700000-0000-4000-8000-000000000008"}'::jsonb) $$, '42501', null, 'otra identidad sin permiso de lote no puede registrar');

reset role;
rollback;
