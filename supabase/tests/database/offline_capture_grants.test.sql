begin;
select plan(16);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'offline-capture@example.invalid', now(), now()),
  ('92000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'offline-director@example.invalid', now(), now()),
  ('93000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'offline-outside@example.invalid', now(), now()),
  ('96000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'offline-other-lot@example.invalid', now(), now());
insert into public.companies (id, code, legal_name)
values
  ('91000000-0000-4000-8000-000000000002', 'TEST-OFFLINE-A', 'Empresa ficticia A'),
  ('93000000-0000-4000-8000-000000000002', 'TEST-OFFLINE-B', 'Empresa ficticia B');
insert into public.company_memberships (id, company_id, user_id, status)
values
  ('91000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000001', 'active'),
  ('92000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000001', 'active'),
  ('93000000-0000-4000-8000-000000000003', '93000000-0000-4000-8000-000000000002', '93000000-0000-4000-8000-000000000001', 'active'),
  ('96000000-0000-4000-8000-000000000003', '91000000-0000-4000-8000-000000000002', '96000000-0000-4000-8000-000000000001', 'active');
insert into public.sites (id, company_id, code, name)
values ('91000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000002', 'SITE-OFF', 'Sede ficticia');
insert into public.houses (id, company_id, site_id, code, name)
values ('91000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000004', 'HOUSE-OFF', 'Galpón ficticio');
insert into public.lots (id, company_id, site_id, house_id, code, status)
values
  ('91000000-0000-4000-8000-000000000006', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000005', 'LOT-OFF', 'active'),
  ('91000000-0000-4000-8000-000000000007', '91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000005', 'LOT-OTRO', 'active');
insert into public.role_assignments (company_id, membership_id, role_key, site_id, house_id, lot_id, valid_until)
values
  ('91000000-0000-4000-8000-000000000002', '91000000-0000-4000-8000-000000000003', 'capture', '91000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-000000000006', now() + interval '1 hour'),
  ('91000000-0000-4000-8000-000000000002', '92000000-0000-4000-8000-000000000003', 'director', null, null, null, null),
  ('91000000-0000-4000-8000-000000000002', '96000000-0000-4000-8000-000000000003', 'capture', '91000000-0000-4000-8000-000000000004', '91000000-0000-4000-8000-000000000005', '91000000-0000-4000-8000-000000000007', null);

set local role authenticated;
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select set_config(
  'test.offline_grant_response',
  public.register_offline_capture_grant(
    '91000000-0000-4000-8000-000000000002',
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )::text,
  true
);
select is(
  current_setting('test.offline_grant_response')::jsonb->>'registry_status',
  'registered',
  'capturador con alcance actual registra una capacidad pendiente de firma'
);
select set_config(
  'test.offline_grant_id',
  current_setting('test.offline_grant_response')::jsonb->>'grant_id',
  true
);
select ok(
  (
    (current_setting('test.offline_grant_response')::jsonb->>'expires_at')::timestamptz
    - (current_setting('test.offline_grant_response')::jsonb->>'issued_at')::timestamptz
  ) <= interval '24 hours',
  'vigencia registrada no supera 24 horas'
);
select ok(
  (
    (current_setting('test.offline_grant_response')::jsonb->>'expires_at')::timestamptz
    - (current_setting('test.offline_grant_response')::jsonb->>'issued_at')::timestamptz
  ) <= interval '1 hour',
  'capacidad respeta la caducidad más próxima de la asignación'
);
select is(
  (public.resolve_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )->>'registry_status'),
  'registry_current_unverified',
  'consulta devuelve estado explícitamente no verificado'
);
select is(
  (public.resolve_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )->>'authorizes_event'),
  'false',
  'resolver de registro nunca autoriza ni acepta la recogida'
);
select is(
  (public.resolve_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    '95000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )->>'registry_status'),
  'scope_mismatch',
  'consulta detecta dispositivo distinto del registrado'
);
select is(
  (public.resolve_offline_capture_grant(
    '99900000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )->>'registry_status'),
  'not_found',
  'referencia inexistente no se reconoce'
);

reset role;
update public.role_assignments
set revoked_at = statement_timestamp()
where company_id = '91000000-0000-4000-8000-000000000002'
  and membership_id = '91000000-0000-4000-8000-000000000003'
  and role_key = 'capture';
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-4000-8000-000000000001', true);
select is(
  (public.resolve_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )->>'registry_status'),
  'authorization_no_longer_current',
  'consulta detecta asignación retirada después de emitir'
);

select set_config('request.jwt.claim.sub', '92000000-0000-4000-8000-000000000001', true);
select throws_ok($$
  select public.register_offline_capture_grant(
    '91000000-0000-4000-8000-000000000002',
    '94000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )
$$, '42501', null, 'sin rol capture no se registra una capacidad');
select set_config('request.jwt.claim.sub', '91000000-0000-4000-8000-000000000001', true);
select throws_ok($$
  select public.revoke_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    'intento sin dirección'
  )
$$, '42501', null, 'capturador no puede revocar desde el cliente');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '92000000-0000-4000-8000-000000000001', true);
select set_config(
  'test.offline_revoke_response',
  public.revoke_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    'Cambio autorizado por dirección'
  )::text,
  true
);
select is(
  current_setting('test.offline_revoke_response')::jsonb->>'registry_status',
  'revoked',
  'Dirección revoca con motivo auditado'
);
select is(
  (public.revoke_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    'No reemplazar la primera auditoría'
  )->>'revoked_at'),
  current_setting('test.offline_revoke_response')::jsonb->>'revoked_at',
  'repetir revocación no reemplaza la fecha del historial'
);
select is(
  (public.resolve_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )->>'registry_status'),
  'revoked',
  'la consulta posterior informa revocación'
);

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '96000000-0000-4000-8000-000000000001', true);
select throws_ok($$
  select public.resolve_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )
$$, '42501', null, 'miembro con otro lote no puede consultar este registro');

reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '93000000-0000-4000-8000-000000000001', true);
select throws_ok($$
  select public.resolve_offline_capture_grant(
    current_setting('test.offline_grant_id')::uuid,
    '91000000-0000-4000-8000-000000000002',
    '91000000-0000-4000-8000-000000000001',
    '94000000-0000-4000-8000-000000000001',
    '91000000-0000-4000-8000-000000000004',
    '91000000-0000-4000-8000-000000000005',
    '91000000-0000-4000-8000-000000000006'
  )
$$, '42501', null, 'usuario de otra empresa no puede consultar la capacidad');
select throws_ok($$ select * from public.offline_capture_grants $$,
  '42501', null, 'usuario autenticado no puede consultar directamente la tabla');

select * from finish();
rollback;
