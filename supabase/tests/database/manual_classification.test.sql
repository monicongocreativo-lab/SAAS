begin;
select no_plan();

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

insert into public.collection_transfers(transfer_id,company_id,site_id,house_id,lot_id,origin_business_date,quantity_sent,sent_from,sent_to,sent_by,sent_at,status,received_quantity,received_at_location,received_by,received_at)
select ('ca000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'c2000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001',case when n=4 then '2026-10-26'::date else '2026-10-27'::date end,100,'Galpón','Bodega','c1000000-0000-4000-8000-000000000001','2026-10-27T13:00:00Z',case when n=3 then 'dispatched' else 'received' end,case when n=3 then null when n=2 then 0 else 100 end,case when n=3 then null else 'Bodega' end,case when n=3 then null else 'c1000000-0000-4000-8000-000000000002'::uuid end,case when n=3 then null else '2026-10-27T14:00:00Z'::timestamptz end from generate_series(1,4) n;
create function pg_temp.classification(q integer default 60,t uuid default 'ca000000-0000-4000-8000-000000000001',d date default '2026-10-27') returns jsonb language sql as $$
select jsonb_build_object('schema_version',1,'session_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','origin_business_date',d,'classified_at','2026-10-28T12:00:00.000Z','machine_configuration_reference',null,'notes',null,'inputs',jsonb_build_array(jsonb_build_object('transfer_id',t,'quantity_eggs',q)),'lines',jsonb_build_array(jsonb_build_object('line_id',gen_random_uuid(),'quantity_eggs',q,'typology','AA','condition','NORMAL','destination','PENDING')));$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select set_config('test.classification',pg_temp.classification()::text,true);
select is(public.record_manual_classification(current_setting('test.classification')::jsonb)->>'duplicate','false','first classification saved');
select is(public.record_manual_classification(current_setting('test.classification')::jsonb)->>'duplicate','true','retry has one effect');
select is((select count(*)::integer from public.manual_classification_sessions),1,'one session');
select is((select sum(quantity_eggs)::integer from public.manual_classification_inputs),60,'one consumption');
select is((select sum(quantity_eggs)::integer from public.manual_classification_lines),60,'balanced outputs');
select is((select configuration_status from public.manual_classification_sessions),'declared_unverified','no machine approval invented');
select is((select review_status from public.manual_classification_sessions),'pending','review remains pending');
select throws_ok($$select public.record_manual_classification(current_setting('test.classification')::jsonb||'{"notes":"changed"}')$$,'23505','classification id content conflict','altered retry fails');
select throws_ok($$select public.record_manual_classification(pg_temp.classification(41))$$,'23514','classification exceeds received quantity','overconsumption fails');
select throws_ok($$select public.record_manual_classification(pg_temp.classification(1,'ca000000-0000-4000-8000-000000000002'))$$,'23514','classification exceeds received quantity','zero received cannot be consumed');
select throws_ok($$select public.record_manual_classification(pg_temp.classification(1,'ca000000-0000-4000-8000-000000000003'))$$,'55000','classification input not received','in transit cannot be consumed');
select throws_ok($$select public.record_manual_classification(pg_temp.classification(1,'ca000000-0000-4000-8000-000000000004'))$$,'42501','classification input origin mismatch','different date cannot mix');
select lives_ok($$select public.record_manual_classification(pg_temp.classification(1,'ca000000-0000-4000-8000-000000000004','2026-10-26'))$$,'old origin may be classified later');
select throws_ok($$select public.record_manual_classification(jsonb_set(pg_temp.classification(),'{lines,0,quantity_eggs}','59'))$$,'23514','classification quantities do not balance','unbalanced totals fail');
select throws_ok($$select public.record_manual_classification(jsonb_set(pg_temp.classification(),'{lines,0,typology}','"PIPO"'))$$,'22023','invalid classification line','PIPO must be discarded');
select throws_ok($$select public.record_manual_classification(pg_temp.classification()||'{"recorded_by":"fake"}')$$,'22023','invalid manual classification','client cannot assert actor');
select throws_ok($$select public.record_manual_classification(pg_temp.classification()||'{"classified_at":"2026-10-27T04:59:59.000Z"}')$$,'22023','classification predates origin','Colombian date boundary enforced');
select throws_ok($$select public.record_manual_classification(pg_temp.classification()||'{"classified_at":"2026-10-28T24:00:00.000Z"}')$$,'22023','invalid manual classification','normalization cannot hide invalid time');
select throws_ok($$select public.record_manual_classification(jsonb_set(pg_temp.classification(),'{inputs,0,quantity_eggs}','0.5'))$$,'22023','invalid classification input','fraction rejected');
select throws_ok($$select public.record_manual_classification(pg_temp.classification()||'{"lines":[]}'::jsonb)$$,'22023','invalid manual classification','empty output rejected');
select throws_ok($$update public.manual_classification_sessions set review_status='pending'$$,'42501',null,'direct mutation denied');
select throws_ok($$delete from public.manual_classification_lines$$,'42501',null,'direct delete denied');
select is(public.list_manual_classification_inputs('c2000000-0000-4000-8000-000000000001','2026-10-27')->>'authorized','true','warehouse can list');
select is((select sum((value->>'quantity_available')::integer)::integer from jsonb_array_elements(public.list_manual_classification_inputs('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items')),40,'only received minus successful consumption available');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select throws_ok($$select public.record_manual_classification(pg_temp.classification(1))$$,'42501','manual classification forbidden','capture cannot classify');
select is((select count(*)::integer from public.manual_classification_sessions),2,'capture can consult its scope');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.record_manual_classification(pg_temp.classification(1))$$,'42501','manual classification forbidden','director needs warehouse authority to capture');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select throws_ok($$select public.record_manual_classification(pg_temp.classification(1))$$,'42501','manual classification forbidden','foreign tenant cannot classify');
select is((select count(*)::integer from public.manual_classification_sessions),0,'foreign sessions hidden');
select is((select count(*)::integer from public.manual_classification_inputs),0,'foreign consumption hidden');
select is((select count(*)::integer from public.manual_classification_lines),0,'foreign outputs hidden');
select is(public.get_manual_classification('c2000000-0000-4000-8000-000000000001',(current_setting('test.classification')::jsonb->>'session_id')::uuid),null::jsonb,'foreign detail hidden');
reset role;
update auth.users set raw_app_meta_data='{"tamago_initial_access_state":"pending"}'::jsonb where id='c1000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.record_manual_classification(pg_temp.classification(1))$$,'42501','manual classification forbidden','temporary credential cannot classify');
select is((select count(*)::integer from public.manual_classification_sessions),0,'temporary credential cannot read');
reset role;
update auth.users set raw_app_meta_data='{}'::jsonb where id='c1000000-0000-4000-8000-000000000002';
update public.company_memberships set status='revoked',revoked_at=now() where user_id='c1000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select throws_ok($$select public.record_manual_classification(pg_temp.classification(1))$$,'42501','manual classification forbidden','revoked membership cannot write');
select is((select count(*)::integer from public.manual_classification_sessions),0,'revoked membership cannot read');
select * from finish();
rollback;
