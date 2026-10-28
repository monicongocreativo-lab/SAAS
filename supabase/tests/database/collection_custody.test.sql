begin;
select plan(20);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'custody-sender@example.invalid', now(), now()),
  ('c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'custody-warehouse@example.invalid', now(), now()),
  ('c1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'custody-director@example.invalid', now(), now()),
  ('c1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'custody-outsider@example.invalid', now(), now());
insert into public.companies (id, code, legal_name)
values
  ('c2000000-0000-4000-8000-000000000001', 'TEST-CUSTODY', 'Empresa ficticia de custodia'),
  ('c2000000-0000-4000-8000-000000000002', 'TEST-OTHER', 'Otra empresa ficticia');
insert into public.company_memberships (id, company_id, user_id, status)
values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'active'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'active'),
  ('c3000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'active'),
  ('c3000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', 'active');
insert into public.sites (id, company_id, code, name)
values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'SITE-C', 'Sede ficticia'),
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'SITE-O', 'Otra sede ficticia');
insert into public.houses (id, company_id, site_id, code, name)
values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'HOUSE-C', 'Galpón ficticio'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', 'HOUSE-O', 'Otro galpón ficticio');
insert into public.lots (id, company_id, site_id, house_id, code, status)
values
  ('c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'LOT-C', 'active'),
  ('c6000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', 'LOT-O', 'active');
insert into public.role_assignments (company_id, membership_id, role_key, site_id, house_id, lot_id)
values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'capture', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'warehouse', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003', 'director', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000004', 'warehouse', 'c4000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', 'c6000000-0000-4000-8000-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select public.receive_collection_event('{"schema_version":2,"event_id":"c7000000-0000-4000-8000-000000000001","company_id":"c2000000-0000-4000-8000-000000000001","site_id":"c4000000-0000-4000-8000-000000000001","house_id":"c5000000-0000-4000-8000-000000000001","lot_id":"c6000000-0000-4000-8000-000000000001","business_date":"2026-10-27","occurrence":1,"quantity_eggs":100,"occurred_at":"2026-10-27T12:00:00Z","captured_at":"2026-10-27T12:01:00Z","actor_declared_id":"capturador-ficticio","device_id":"c8000000-0000-4000-8000-000000000001"}'::jsonb);
select set_config('test.transfer', '{"transfer_id":"c9000000-0000-4000-8000-000000000001","company_id":"c2000000-0000-4000-8000-000000000001","site_id":"c4000000-0000-4000-8000-000000000001","house_id":"c5000000-0000-4000-8000-000000000001","lot_id":"c6000000-0000-4000-8000-000000000001","origin_business_date":"2026-10-27","quantity_sent":100,"sent_from":"Galpón C","sent_to":"Clasificación","sent_at":"2026-10-27T13:00:00Z"}', true);
select is(public.dispatch_collection_transfer(current_setting('test.transfer')::jsonb)->>'status', 'dispatched', 'captura autorizada registra el envío');
select is(public.dispatch_collection_transfer(current_setting('test.transfer')::jsonb)->>'duplicate', 'true', 'reintento idéntico del envío es idempotente');
select throws_ok($$ select public.dispatch_collection_transfer(jsonb_set(current_setting('test.transfer')::jsonb, '{quantity_sent}', '99')) $$, '22023', 'transfer id content conflict', 'reusar el ID del traslado con contenido distinto se rechaza');
select throws_ok($$ select public.dispatch_collection_transfer(jsonb_set(current_setting('test.transfer')::jsonb, '{transfer_id}', '"c9000000-0000-4000-8000-000000000002"')) $$, '23514', null, 'el envío excedente sobre el origen diario se rechaza');
select public.receive_collection_event('{"schema_version":2,"event_id":"c7000000-0000-4000-8000-000000000002","company_id":"c2000000-0000-4000-8000-000000000001","site_id":"c4000000-0000-4000-8000-000000000001","house_id":"c5000000-0000-4000-8000-000000000001","lot_id":"c6000000-0000-4000-8000-000000000001","business_date":"2026-10-27","occurrence":2,"quantity_eggs":50,"occurred_at":"2026-10-27T13:00:00Z","captured_at":"2026-10-27T13:01:00Z","actor_declared_id":"capturador-ficticio","device_id":"c8000000-0000-4000-8000-000000000001"}'::jsonb);
select set_config('test.transfer_second', '{"transfer_id":"c9000000-0000-4000-8000-000000000002","company_id":"c2000000-0000-4000-8000-000000000001","site_id":"c4000000-0000-4000-8000-000000000001","house_id":"c5000000-0000-4000-8000-000000000001","lot_id":"c6000000-0000-4000-8000-000000000001","origin_business_date":"2026-10-27","quantity_sent":50,"sent_from":"Galpón C","sent_to":"Clasificación","sent_at":"2026-10-27T15:00:00Z"}', true);
select is(public.dispatch_collection_transfer(current_setting('test.transfer_second')::jsonb)->>'status', 'dispatched', 'el origen diario suma las ocurrencias reales del mismo día');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000002', true);
select is((public.confirm_collection_transfer_receipt('c9000000-0000-4000-8000-000000000002', 50, 'Bodega', '2026-10-27T15:30:00Z', null)->>'status'), 'received', 'recepción igual confirma el traslado');
select is((select count(*)::integer from public.custody_incidents), 0, 'una recepción exacta no crea incidencia');
select is((public.confirm_collection_transfer_receipt('c9000000-0000-4000-8000-000000000001', 98, 'Bodega', '2026-10-27T14:00:00Z', 'Conteo físico ficticio')->>'status'), 'received', 'Bodega confirma cantidad recibida');
select is((select quantity_difference from public.custody_incidents limit 1), 2, 'la diferencia se deriva como enviada menos recibida');
select is((public.confirm_collection_transfer_receipt('c9000000-0000-4000-8000-000000000001', 98, 'Bodega', '2026-10-27T14:00:00Z', 'Conteo físico ficticio')->>'duplicate'), 'true', 'reintento idéntico de recepción no abre segunda incidencia');
select throws_ok($$ select public.confirm_collection_transfer_receipt('c9000000-0000-4000-8000-000000000001', 97, 'Bodega', '2026-10-27T14:00:00Z', 'Conteo físico ficticio') $$, '22023', 'transfer already received with different content', 'una recepción no puede reemplazarse con otra cantidad');
select is(public.add_custody_incident_evidence((select incident_id from public.custody_incidents), 'origin_card', 'tarjeta-27', 'Tarjeta manuscrita ficticia') is not null, true, 'Bodega agrega antecedente al expediente');
select public.submit_custody_incident_to_direction((select incident_id from public.custody_incidents), 'Se contrastó tarjeta y conteo; se solicita decisión de Dirección.');
select is((select status from public.custody_incidents limit 1), 'submitted_to_direction', 'Bodega presenta la investigación a Dirección');
select is((select count(*)::integer from public.collection_events), 2, 'el expediente conserva los eventos de recogida sin modificarlos');
select is((select quantity_eggs from public.collection_events where event_id = 'c7000000-0000-4000-8000-000000000001'), 100, 'la diferencia de custodia no altera la cantidad de recogida');

select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000001', true);
select throws_ok($$ select public.confirm_collection_transfer_receipt('c9000000-0000-4000-8000-000000000001', 98, 'Bodega', '2026-10-27T14:00:00Z', 'Conteo físico ficticio') $$, '42501', null, 'el rol de captura no puede confirmar como Bodega');
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000004', true);
select throws_ok($$ select public.add_custody_incident_evidence((select incident_id from public.custody_incidents), 'other', null, 'No autorizado') $$, '42501', null, 'usuario de otra empresa no puede investigar');
select is((select count(*)::integer from public.custody_incidents), 0, 'usuario de otra empresa no puede consultar el expediente');
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select is((select count(*)::integer from public.custody_incidents), 1, 'Dirección con ámbito puede consultar el expediente presentado');
reset role;
update auth.users set raw_app_meta_data = '{"tamago_initial_access_state":"pending"}'::jsonb
where id = 'c1000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub', 'c1000000-0000-4000-8000-000000000003', true);
select is(private.has_lot_role('c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001', 'director'), false, 'la contraseña temporal bloquea las operaciones de custodia');

reset role;
select * from finish();
rollback;
