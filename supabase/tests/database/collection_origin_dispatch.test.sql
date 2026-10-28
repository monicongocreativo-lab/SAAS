begin;
select plan(21);

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


insert into public.role_assignments(company_id,membership_id,role_key,site_id,house_id,lot_id)
values('c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000003','transport','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001'),
('c2000000-0000-4000-8000-000000000002','c3000000-0000-4000-8000-000000000004','capture','c4000000-0000-4000-8000-000000000002','c5000000-0000-4000-8000-000000000002','c6000000-0000-4000-8000-000000000002');
insert into public.collection_events(event_id,company_id,site_id,house_id,lot_id,business_date,occurrence,quantity_eggs,occurred_at,captured_at,actor_declared_id,device_id,captured_by)
select gen_random_uuid(),'c2000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001',d,o,q,d::timestamptz+interval '12 hours',d::timestamptz+interval '12 hours','Ficticio','c8000000-0000-4000-8000-000000000001','c1000000-0000-4000-8000-000000000001'
from(values('2026-10-27'::date,1,100),('2026-10-27'::date,2,50),('2026-10-26'::date,1,0),('2026-10-24'::date,1,1000000000),('2026-10-24'::date,2,1000000000),('2026-10-24'::date,3,1000000000)) t(d,o,q);
insert into public.offline_collection_quarantine(event_id,company_id,site_id,house_id,lot_id,business_date,occurrence,event_payload,identity_binding,device_proof,received_by_user_id,proof_status,grant_status,quarantine_reason)
values(gen_random_uuid(),'c2000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001','2026-10-27',3,'{"quantity_eggs":999}','{}','{}','c1000000-0000-4000-8000-000000000001','verified','expired','grant_expired');
create function pg_temp.dispatch(p_quantity integer,p_date date default '2026-10-27',p_id uuid default gen_random_uuid())
returns jsonb language sql as $$ select jsonb_build_object('transfer_id',p_id,'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','origin_business_date',p_date,'quantity_sent',p_quantity,'sent_from','Galpón ficticio','sent_to','Bodega ficticia','sent_at','2026-10-27T13:00:00Z'); $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'->0->>'quantity_collected','150','un origen suma recogidas reales sin incluir cuarentena');
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'->0->>'occurrences','2','se conservan las dos recogidas intradía');
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-26')->'items'->0->>'quantity_collected','0','cero explícito aparece como origen informado');
select is(jsonb_array_length(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-25')->'items'),0,'ausencia no fabrica origen con cero');
select set_config('test.dispatch',pg_temp.dispatch(40)::text,true);
select public.dispatch_collection_transfer(current_setting('test.dispatch')::jsonb);
select public.dispatch_collection_transfer(pg_temp.dispatch(10));
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'->0->>'quantity_sent','50','suma traslados sin multiplicarlos por ocurrencias');
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'->0->>'quantity_available','100','disponible es recogidas menos enviados del mismo origen');
select is(public.dispatch_collection_transfer(current_setting('test.dispatch')::jsonb)->>'duplicate','true','reintento conserva identidad del traslado');
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'->0->>'quantity_available','100','reintento no descuenta dos veces');
select throws_ok($$ select public.dispatch_collection_transfer(pg_temp.dispatch(101)) $$,'23514','transfer exceeds confirmed daily origin','sobreenvío no se admite');
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-26')->'items'->0->>'quantity_available','0','otro día no pierde disponibilidad por traslados de hoy');
select throws_ok($$ select public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27',-1) $$,'22023','invalid collection origin page','paginación inválida se rechaza');
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-24')->'items'->0->>'quantity_collected','3000000000','sumas válidas de tres recogidas no desbordan int32');
select is(public.dispatch_collection_transfer(pg_temp.dispatch(1,'2026-10-24'))->>'status','dispatched','acumulador ancho permite enviar parcial de un total grande');
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-24')->'items'->0->>'quantity_available','2999999999','disponible grande se conserva exactamente');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select is(private.has_lot_role('c2000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001','capture'),false,'el transportador no necesita rol de captura');
select is(public.dispatch_collection_transfer(pg_temp.dispatch(25))->>'status','dispatched','Transporte con ámbito puede entregar');
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'->0->>'quantity_available','75','Transporte consulta el mismo disponible');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select is(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27')->>'authorized','false','Bodega sola no obtiene pantalla de envío');
select throws_ok($$ select public.dispatch_collection_transfer(pg_temp.dispatch(1)) $$,'42501','custody dispatch forbidden','Bodega sola no registra envío');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is(jsonb_array_length(public.list_collection_origins('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'),0,'capturador de otra empresa no ve orígenes');
select throws_ok($$ select public.dispatch_collection_transfer(pg_temp.dispatch(1)) $$,'42501','custody dispatch forbidden','capturador de otra empresa no entrega este origen');
reset role;
select * from finish();
rollback;
