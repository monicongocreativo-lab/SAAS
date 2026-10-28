begin;

select plan(39);

-- Fully synthetic identities. The transaction rolls back so tests leave no rows.
insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'tamago-test@example.invalid', now(), now()),
  ('30000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'tamago-site-test@example.invalid', now(), now()),
  ('20000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'paulina-test@example.invalid', now(), now()),
  ('40000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'tamago-admin-test@example.invalid', now(), now()),
  ('50000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'tamago-invite-test@example.invalid', now(), now()),
  ('60000000-0000-4000-8000-000000000006', 'authenticated', 'authenticated', 'tamago-director-test@example.invalid', now(), now());

insert into auth.users (id, aud, role, email, raw_app_meta_data, created_at, updated_at)
values ('70000000-0000-4000-8000-000000000007', 'authenticated', 'authenticated', 'tamago-temporary-test@example.invalid', '{"tamago_initial_access_state":"pending"}', now(), now());

insert into public.companies (id, code, legal_name)
values
  ('a0000000-0000-4000-8000-000000000001', 'TEST-TAMAGO', 'Empresa ficticia Tamago'),
  ('b0000000-0000-4000-8000-000000000002', 'TEST-PAULINA', 'Empresa ficticia Paulina');

insert into public.company_memberships (id, company_id, user_id, status)
values
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'active'),
  ('a1010000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', 'active'),
  ('b1000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'active'),
  ('a1020000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000004', 'active');

insert into public.company_memberships (id, company_id, user_id, status)
values
  ('a1030000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', '70000000-0000-4000-8000-000000000007', 'active'),
  ('b1010000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', '70000000-0000-4000-8000-000000000007', 'invited');

insert into public.role_assignments (id, company_id, membership_id, role_key)
values
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'capture'),
  ('b2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'b1000000-0000-4000-8000-000000000002', 'director'),
  ('a2020000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1020000-0000-4000-8000-000000000001', 'admin');

insert into public.role_assignments (id, company_id, membership_id, role_key)
values ('a2030000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1030000-0000-4000-8000-000000000001', 'capture');

insert into public.sites (id, company_id, code, name)
values
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'SITE-A', 'Sede ficticia A'),
  ('a3010000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'SITE-A2', 'Sede ficticia A2'),
  ('b3000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'SITE-B', 'Sede ficticia B');

insert into public.role_assignments (id, company_id, membership_id, role_key, site_id)
values ('a2010000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1010000-0000-4000-8000-000000000001', 'capture', 'a3000000-0000-4000-8000-000000000001');

insert into public.houses (id, company_id, site_id, code, name)
values
  ('a4000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'GAL-A', 'Galpón ficticio A'),
  ('a4010000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a3010000-0000-4000-8000-000000000001', 'GAL-A2', 'Galpón ficticio A2'),
  ('b4000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000002', 'GAL-B', 'Galpón ficticio B');

insert into public.lots (id, company_id, site_id, house_id, code)
values
  ('a5000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 'LOTE-A'),
  ('a5010000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a3010000-0000-4000-8000-000000000001', 'a4010000-0000-4000-8000-000000000001', 'LOTE-A2'),
  ('b5000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'b3000000-0000-4000-8000-000000000002', 'b4000000-0000-4000-8000-000000000002', 'LOTE-B');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);

select is((select count(*)::integer from public.companies), 1, 'la persona de Tamago ve solo su empresa');
select is((select count(*)::integer from public.companies where id = 'b0000000-0000-4000-8000-000000000002'), 0, 'filtrar por ID de otra empresa no revela filas');
select is((select count(*)::integer from public.company_memberships), 1, 'solo ve su propia membresía');
select is((select count(*)::integer from public.sites), 2, 'el directorio de sedes queda limitado a su empresa');
select is((select count(*)::integer from public.lots), 2, 'los lotes quedan limitados a su empresa');
select set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000007', true);
select ok(not private.initial_access_complete(), 'la contraseña temporal mantiene bloqueado el acceso de empresa');
select is((select count(*)::integer from public.companies), 0, 'el usuario temporal no lee empresas por la API directa');
select is((select count(*)::integer from public.lots), 0, 'el usuario temporal no lee datos operativos por la API directa');
select throws_ok(
  $$ select public.manage_company_membership('b0000000-0000-4000-8000-000000000002', null, 'b1010000-0000-4000-8000-000000000002', 'accept', null) $$,
  '42501', null, 'la contraseña temporal impide aceptar una membresía antes del cambio'
);
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is((select count(*)::integer from public.lots where id = 'b5000000-0000-4000-8000-000000000002'), 0, 'un filtro por lote ajeno devuelve cero filas');
select ok(private.has_company_role('a0000000-0000-4000-8000-000000000001', 'capture'), 'reconoce el rol asignado en su empresa');
select ok(not private.has_company_role('a0000000-0000-4000-8000-000000000001', 'director'), 'no eleva el rol de captura a Dirección');
select ok(not private.has_company_role('b0000000-0000-4000-8000-000000000002', 'director'), 'no reconoce un rol de otra empresa');
select throws_ok(
  $$ insert into public.companies (code, legal_name) values ('INJECTED', 'No autorizado') $$,
  '42501', null, 'el cliente no puede crear empresas'
);

reset role;
update public.companies
set status = 'suspended'
where id = 'a0000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);
select is((select count(*)::integer from public.companies), 0, 'una empresa suspendida desaparece del directorio');
select is((select count(*)::integer from public.sites), 0, 'suspender empresa revoca lectura de sedes');
select is((select count(*)::integer from public.lots), 0, 'suspender empresa revoca lectura de lotes');

reset role;
update public.companies
set status = 'active'
where id = 'a0000000-0000-4000-8000-000000000001';
set local role authenticated;

select set_config('request.jwt.claim.sub', '20000000-0000-4000-8000-000000000002', true);
select is((select count(*)::integer from public.companies), 1, 'la segunda persona ve únicamente su empresa');

select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
select is((select count(*)::integer from public.sites), 1, 'el alcance de sede oculta las otras sedes de la misma empresa');
select is((select count(*)::integer from public.lots), 1, 'el alcance de sede limita también los lotes');

select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000004', true);
select ok(private.can_manage_company_members('a0000000-0000-4000-8000-000000000001'), 'admin global puede gestionar membresías de su empresa');
select ok(public.authorize_company_identity_creation('a0000000-0000-4000-8000-000000000001', 'capture'), 'admin puede solicitar alta de identidad con rol operativo');
select ok(not public.authorize_company_identity_creation('a0000000-0000-4000-8000-000000000001', 'director'), 'la preautorización no habilita crear el primer director');
select ok(not public.authorize_company_identity_creation('b0000000-0000-4000-8000-000000000002', 'capture'), 'la preautorización no cruza empresas');
select is((select count(*)::integer from public.company_memberships), 4, 'admin ve membresías de su empresa');
select is((select count(*)::integer from public.company_memberships where company_id = 'b0000000-0000-4000-8000-000000000002'), 0, 'admin no ve miembros de otra empresa');
select is(
  (public.manage_company_membership(
    'a0000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005', null, 'invite', 'warehouse'
  )->>'status'),
  'invited',
  'admin crea invitación y rol inicial en una transacción'
);
select throws_ok(
  $$ select public.manage_company_membership('a0000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000006', null, 'invite', 'director') $$,
  '42501', null, 'admin no puede conceder Dirección ni elevarse'
);

select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000005', true);
select is(
  (public.manage_company_membership(
    'a0000000-0000-4000-8000-000000000001', null,
    (select id from public.company_memberships where user_id = '50000000-0000-4000-8000-000000000005'),
    'accept', null
  )->>'status'),
  'active',
  'solo la persona invitada acepta su membresía'
);
select is((select count(*)::integer from public.companies), 1, 'aceptar da acceso solo a la empresa invitante');

select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000004', true);
select is(
  (public.manage_company_membership(
    'a0000000-0000-4000-8000-000000000001', null,
    (select id from public.company_memberships where user_id = '50000000-0000-4000-8000-000000000005'),
    'suspend', null
  )->>'status'),
  'suspended',
  'admin puede suspender una membresía de su empresa'
);
select set_config('request.jwt.claim.sub', '30000000-0000-4000-8000-000000000003', true);
select throws_ok(
  $$ select public.manage_company_membership('a0000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000006', null, 'invite', 'capture') $$,
  '42501', null, 'usuario de captura no puede administrar miembros'
);
select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000004', true);
select throws_ok(
  $$ select public.manage_company_membership('a0000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000004', null, 'invite', 'capture') $$,
  '22023', null, 'admin no puede invitarse a sí mismo'
);

select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000005', true);
select is((select count(*)::integer from public.companies), 0, 'suspender membresía corta nuevas lecturas');
select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000004', true);
select is(
  (public.manage_company_membership(
    'a0000000-0000-4000-8000-000000000001', null,
    (select id from public.company_memberships where user_id = '50000000-0000-4000-8000-000000000005'),
    'reactivate', null
  )->>'status'),
  'active',
  'admin puede reactivar una membresía suspendida'
);
select set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000005', true);
select is((select count(*)::integer from public.companies), 1, 'reactivar restablece acceso solo a su empresa');
select set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000004', true);
select is(
  (public.manage_company_membership(
    'a0000000-0000-4000-8000-000000000001', null,
    (select id from public.company_memberships where user_id = '50000000-0000-4000-8000-000000000005'),
    'revoke', null
  )->>'status'),
  'revoked',
  'admin puede revocar permanentemente una membresía'
);
select is(
  (public.manage_company_membership(
    'a0000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005', null, 'invite', 'capture'
  )->>'status'),
  'invited',
  'una cuenta revocada puede recibir una nueva membresía histórica'
);

set local role anon;
select throws_ok(
  $$ select count(*) from public.companies $$,
  '42501', null, 'la petición anónima no lee empresas privadas'
);

select * from finish();
rollback;
