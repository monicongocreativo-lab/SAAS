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


create function pg_temp.delivery(q text default '4.25') returns jsonb language sql as $$
select jsonb_build_object('format','tamago.feed-delivery','schema_version',1,'event_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date','2026-10-28','occurred_at','2026-10-29T04:59:59.000Z','product_declared','Fórmula ficticia','quantity',q,'unit','BAG_40KG','location_declared','SYN-Bodega galpón','supplier_declared',null,'delivery_reference_declared',null,'physical_batch_declared',null,'notes',null);$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.delivery',pg_temp.delivery()::text,true);
select is(public.record_feed_delivery(current_setting('test.delivery')::jsonb)->>'duplicate','false','first delivery persisted');
select is(public.record_feed_delivery(current_setting('test.delivery')::jsonb)->>'duplicate','true','retry one effect');
select is((select count(*)::int from public.feed_delivery_events),1,'one stable event');
select is(public.record_feed_delivery(current_setting('test.delivery')::jsonb)->>'recorded_by','c1000000-0000-4000-8000-000000000001','SQL actor, not declared author');
select is(public.record_feed_delivery(current_setting('test.delivery')::jsonb)->>'inventory_check','not_evaluated','no stock approval');
select is((select quantity from public.feed_delivery_events),'4.25','exact bag quantity retained');
select throws_ok($$select public.record_feed_delivery(current_setting('test.delivery')::jsonb||'{"quantity":"5"}')$$,'23505','feed delivery id content conflict','altered retry rejected');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery('0'))$$,'22023','invalid feed delivery','zero is not a physical delivery');
select is(public.record_feed_delivery(pg_temp.delivery())->'event'->>'quantity','4.25','same quantity different delivery is allowed');
select is((select count(*)::int from public.feed_supply_events),0,'delivery never creates supply');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery()||'{"location_declared":null}')$$,'22023','invalid feed delivery','physical location required');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery()||'{"format":"tamago.feed-supply"}')$$,'22023','invalid feed delivery','kind cannot be confused');
select is(public.record_feed_delivery(pg_temp.delivery('0.000000000000000000001'))->'event'->>'quantity','0.000000000000000000001','fraction not rounded');
select is(public.record_feed_delivery(pg_temp.delivery('9007199254740993.125'))->'event'->>'quantity','9007199254740993.125','no float precision loss');
select is((select count(*)::int from public.feed_delivery_events where business_date='2026-10-27'),0,'absence is no event');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery('-1'))$$,'22023','invalid feed delivery','negative rejected');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery()||'{"quantity":4.25}')$$,'22023','invalid feed delivery','float number rejected');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery('01'))$$,'22023','invalid feed delivery','noncanonical rejected');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery()||'{"unit":"BAG"}')$$,'22023','invalid feed delivery','ambiguous bag rejected');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery()||'{"recorded_by":"forged"}')$$,'22023','invalid feed delivery','forged actor rejected');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery()||'{"business_date":"2026-10-29"}')$$,'22023','invalid feed delivery','Colombian occurrence date enforced');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery()||'{"occurred_at":"2026-02-30T12:00:00.000Z"}')$$,'22023','invalid feed delivery','nonexistent timestamp rejected');
select throws_ok($$update public.feed_delivery_events set quantity='99'$$,'42501',null,'direct update forbidden');
select throws_ok($$delete from public.feed_delivery_events$$,'42501',null,'direct delete forbidden');
select throws_ok($$insert into public.feed_delivery_events select * from public.feed_delivery_events$$,'42501',null,'direct insert forbidden');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select is((select count(*)::int from public.feed_delivery_events),0,'warehouse has no delivery scope by default');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery())$$,'42501','feed delivery forbidden','warehouse cannot record delivery');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select is((select count(*)::int from public.feed_delivery_events),4,'director scoped read');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery())$$,'42501','feed delivery forbidden','director requires capture role to record');
reset role;
insert into public.role_assignments(company_id,membership_id,role_key,site_id,house_id,lot_id) values('c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000003','capture','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001');
set local role authenticated;
select throws_ok($$select public.record_feed_delivery(current_setting('test.delivery')::jsonb)$$,'23505','feed delivery id content conflict','another authorized actor cannot claim original receipt');
reset role;
update auth.users set raw_app_meta_data='{"tamago_initial_access_state":"pending"}'::jsonb where id='c1000000-0000-4000-8000-000000000003';
set local role authenticated;
select is((select count(*)::int from public.feed_delivery_events),0,'pending initial access has no read');
select throws_ok($$select public.record_feed_delivery(pg_temp.delivery())$$,'42501','feed delivery forbidden','pending initial access cannot record');
reset role;
update auth.users set raw_app_meta_data='{}'::jsonb where id='c1000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is((select count(*)::int from public.feed_delivery_events),0,'other company no read');
select throws_ok($$select public.record_feed_delivery(current_setting('test.delivery')::jsonb)$$,'42501','feed delivery forbidden','other company cannot retry');
reset role;
update public.role_assignments set revoked_at=now() where role_key='capture';
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is((select count(*)::int from public.feed_delivery_events),0,'revoked capture no read');
select throws_ok($$select public.record_feed_delivery(current_setting('test.delivery')::jsonb)$$,'42501','feed delivery forbidden','revoked capture no retry');
reset role;
set local role anon;
select throws_ok($$select public.record_feed_delivery('{}')$$,'42501',null,'anon cannot execute');
reset role;
select * from finish();rollback;
