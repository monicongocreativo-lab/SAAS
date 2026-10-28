begin;
select plan(5);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('a1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'key-capture@example.invalid', now(), now()),
  ('a2000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'key-director@example.invalid', now(), now());
insert into public.companies (id, code, legal_name)
values ('a1000000-0000-4000-8000-000000000002', 'TEST-KEY-BIND', 'Empresa ficticia de prueba de clave');
insert into public.company_memberships (id, company_id, user_id, status)
values
  ('a1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000001', 'active'),
  ('a2000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000001', 'active');
insert into public.sites (id, company_id, code, name)
values ('a1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000002', 'SITE-KEY', 'Sede ficticia');
insert into public.houses (id, company_id, site_id, code, name)
values ('a1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000004', 'HOUSE-KEY', 'Galpón ficticio');
insert into public.lots (id, company_id, site_id, house_id, code, status)
values ('a1000000-0000-4000-8000-000000000006', 'a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000005', 'LOT-KEY', 'active');
insert into public.role_assignments (company_id, membership_id, role_key, site_id, house_id, lot_id)
values
  ('a1000000-0000-4000-8000-000000000002', 'a1000000-0000-4000-8000-000000000003', 'capture', 'a1000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000005', 'a1000000-0000-4000-8000-000000000006'),
  ('a1000000-0000-4000-8000-000000000002', 'a2000000-0000-4000-8000-000000000003', 'director', null, null, null);

set local role authenticated;
select set_config('request.jwt.claim.sub', 'a1000000-0000-4000-8000-000000000001', true);
select set_config(
  'test.key_bound_grant',
  public.register_offline_capture_grant_v2(
    'a1000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000006',
    'a4000000-0000-4000-8000-000000000001',
    repeat('A', 43)
  )::text,
  true
);
select is(current_setting('test.key_bound_grant')::jsonb->>'registry_status', 'registered', 'registra permiso con clave ligada tras validar alcance');
select is(current_setting('test.key_bound_grant')::jsonb->>'device_key_thumbprint', repeat('A', 43), 'conserva el thumbprint exacto de la prueba verificada');
select is(
  (public.register_offline_capture_grant_v2(
    'a1000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000006',
    'a4000000-0000-4000-8000-000000000001',
    repeat('A', 43)
  )->>'grant_id'),
  current_setting('test.key_bound_grant')::jsonb->>'grant_id',
  'reintento idempotente recupera el mismo grant_id'
);
select throws_ok($$
  select public.register_offline_capture_grant_v2(
    'a1000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000001',
    'a1000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000006',
    'a4000000-0000-4000-8000-000000000001',
    repeat('B', 43)
  )
$$, '22023', null, 'mismo request_id con otra clave genera conflicto y no otro grant');

select set_config('request.jwt.claim.sub', 'a2000000-0000-4000-8000-000000000001', true);
select throws_ok($$
  select public.register_offline_capture_grant_v2(
    'a1000000-0000-4000-8000-000000000002',
    'a3000000-0000-4000-8000-000000000002',
    'a1000000-0000-4000-8000-000000000004',
    'a1000000-0000-4000-8000-000000000005',
    'a1000000-0000-4000-8000-000000000006',
    'a4000000-0000-4000-8000-000000000002',
    repeat('C', 43)
  )
$$, '42501', null, 'Dirección sin rol capture no registra permiso offline');

select * from finish();
rollback;
