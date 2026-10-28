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


create function pg_temp.supply(q text default '4.25') returns jsonb language sql as $$
select jsonb_build_object('schema_version',1,'event_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date','2026-10-28','occurred_at','2026-10-29T04:59:59.000Z','product_declared','Fórmula ficticia','quantity',q,'unit','BAG_40KG','source_declared',null,'physical_batch_declared',null,'notes',null);$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.supply',pg_temp.supply()::text,true);
select is(public.get_feed_supply_scope('c2000000-0000-4000-8000-000000000001')->'lots'->0->>'can_record','true','capture scope shows write permission');
select is(public.record_feed_supply(current_setting('test.supply')::jsonb)->>'duplicate','false','first supply persisted');
select is(public.record_feed_supply(current_setting('test.supply')::jsonb)->>'duplicate','true','retry one effect');
select is((select count(*)::int from public.feed_supply_events),1,'one stable event');
select is(public.record_feed_supply(current_setting('test.supply')::jsonb)->>'recorded_by','c1000000-0000-4000-8000-000000000001','SQL actor, not declared author');
select is(public.record_feed_supply(current_setting('test.supply')::jsonb)->>'inventory_check','not_evaluated','no stock approval');
select is((select quantity from public.feed_supply_events),'4.25','exact bag quantity retained');
select throws_ok($$select public.record_feed_supply(current_setting('test.supply')::jsonb||'{"quantity":"5"}')$$,'23505','feed supply id content conflict','altered retry rejected');
select is(public.record_feed_supply(pg_temp.supply('0'))->'event'->>'quantity','0','explicit zero retained');
select is(public.record_feed_supply(pg_temp.supply('0.000000000000000000001'))->'event'->>'quantity','0.000000000000000000001','fraction not rounded');
select is(public.record_feed_supply(pg_temp.supply('9007199254740993.125'))->'event'->>'quantity','9007199254740993.125','no float precision loss');
select is((select count(*)::int from public.feed_supply_events where business_date='2026-10-27'),0,'absence is no event');
select throws_ok($$select public.record_feed_supply(pg_temp.supply('-1'))$$,'22023','invalid feed supply','negative rejected');
select throws_ok($$select public.record_feed_supply(pg_temp.supply()||'{"quantity":4.25}')$$,'22023','invalid feed supply','float number rejected');
select throws_ok($$select public.record_feed_supply(pg_temp.supply('01'))$$,'22023','invalid feed supply','noncanonical rejected');
select throws_ok($$select public.record_feed_supply(pg_temp.supply()||'{"unit":"BAG"}')$$,'22023','invalid feed supply','ambiguous bag rejected');
select throws_ok($$select public.record_feed_supply(pg_temp.supply()||'{"recorded_by":"forged"}')$$,'22023','invalid feed supply','forged actor rejected');
select throws_ok($$select public.record_feed_supply(pg_temp.supply()||'{"business_date":"2026-10-29"}')$$,'22023','invalid feed supply','Colombian occurrence date enforced');
select throws_ok($$select public.record_feed_supply(pg_temp.supply()||'{"occurred_at":"2026-02-30T12:00:00.000Z"}')$$,'22023','invalid feed supply','nonexistent timestamp rejected');
select throws_ok($$update public.feed_supply_events set quantity='99'$$,'42501',null,'direct update forbidden');
select throws_ok($$delete from public.feed_supply_events$$,'42501',null,'direct delete forbidden');
select throws_ok($$insert into public.feed_supply_events select * from public.feed_supply_events$$,'42501',null,'direct insert forbidden');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select is(jsonb_array_length(public.get_feed_supply_scope('c2000000-0000-4000-8000-000000000001')->'lots'),0,'warehouse scope no capture implied');
select is((select count(*)::int from public.feed_supply_events),0,'warehouse has no supply scope by default');
select throws_ok($$select public.record_feed_supply(pg_temp.supply())$$,'42501','feed supply forbidden','warehouse cannot supply');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select is(public.get_feed_supply_scope('c2000000-0000-4000-8000-000000000001')->'lots'->0->>'can_record','false','director scope read only');
select is((select count(*)::int from public.feed_supply_events),4,'director scoped read');
select throws_ok($$select public.record_feed_supply(pg_temp.supply())$$,'42501','feed supply forbidden','director requires capture role to record');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is((select count(*)::int from public.feed_supply_events),0,'other company no read');
select throws_ok($$select public.record_feed_supply(current_setting('test.supply')::jsonb)$$,'42501','feed supply forbidden','other company cannot retry');
reset role;
update public.role_assignments set revoked_at=now() where role_key='capture';
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(jsonb_array_length(public.get_feed_supply_scope('c2000000-0000-4000-8000-000000000001')->'lots'),0,'revoked role removed from scope');
select is((select count(*)::int from public.feed_supply_events),0,'revoked capture no read');
select throws_ok($$select public.record_feed_supply(current_setting('test.supply')::jsonb)$$,'42501','feed supply forbidden','revoked capture no retry');
reset role;
set local role anon;
select throws_ok($$select public.record_feed_supply('{}')$$,'42501',null,'anon cannot execute');
reset role;
select * from finish();rollback;
