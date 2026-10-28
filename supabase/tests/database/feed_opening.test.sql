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



create function pg_temp.count_event() returns jsonb language sql as $$ select jsonb_build_object('format','tamago.feed-opening-count','schema_version',1,'opening_id',gen_random_uuid(),'count_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date','2026-10-28','cutoff_at','2026-10-29T04:59:59.000Z','product_declared','SYN-Fórmula','location_declared','SYN-Bodega','quantity','0','unit','BAG_40KG','evidence_reference','SYN-Acta','notes',null,'expected_revision',0,'previous_count_id',null); $$;
create function pg_temp.approval(c jsonb) returns jsonb language sql as $$ select jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id',c->>'company_id','opening_id',c->>'opening_id','count_id',c->>'count_id','expected_revision',(c->>'expected_revision')::int+1,'reason','SYN-Conteo y soporte revisados');$$;
set local role authenticated;select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.c1',pg_temp.count_event()::text,true);
select is(public.record_feed_opening_count(current_setting('test.c1')::jsonb)->>'revision','1','first immutable count');
select is(public.record_feed_opening_count(current_setting('test.c1')::jsonb)->>'duplicate','true','count retry same effect');
select is((select event_payload->>'quantity' from public.feed_opening_counts),'0','physical zero preserved');
select is(public.get_feed_opening('c2000000-0000-4000-8000-000000000001',(current_setting('test.c1')::jsonb->>'opening_id')::uuid)->>'can_count','true','capture can count');
select is(public.get_feed_opening('c2000000-0000-4000-8000-000000000001',(current_setting('test.c1')::jsonb->>'opening_id')::uuid)->>'can_approve','false','capture has no approval hint');

select throws_ok($$select public.record_feed_opening_count(current_setting('test.c1')::jsonb||'{"quantity":"1"}')$$,'23505','opening id content conflict','altered count retry rejected');
select throws_ok($$select public.record_feed_opening_count(pg_temp.count_event()||'{"evidence_reference":""}')$$,'22023','invalid opening','evidence required');
select throws_ok($$select public.record_feed_opening_count(pg_temp.count_event()||'{"approved_by":"forged"}')$$,'22023','invalid opening','no forged approval');
select throws_ok($$select public.approve_feed_opening(pg_temp.approval(current_setting('test.c1')::jsonb))$$,'42501','opening forbidden','capture cannot approve');
select set_config('test.c2',(current_setting('test.c1')::jsonb||jsonb_build_object('count_id',gen_random_uuid(),'previous_count_id',current_setting('test.c1')::jsonb->>'count_id','expected_revision',1,'quantity','12.5','evidence_reference','SYN-Recuento'))::text,true);
select is(public.record_feed_opening_count(current_setting('test.c2')::jsonb)->>'revision','2','recount increments version');
select is((select count(*)::int from public.feed_opening_counts),2,'old count retained');
select is((select event_payload->>'quantity' from public.feed_opening_counts where revision=1),'0','original never overwritten');
select throws_ok($$select public.record_feed_opening_count(current_setting('test.c2')::jsonb||jsonb_build_object('count_id',gen_random_uuid()))$$,'40001','opening revision conflict','stale recount rejected');
select throws_ok($$select public.record_feed_opening_count(current_setting('test.c2')::jsonb||jsonb_build_object('count_id',gen_random_uuid(),'product_declared','Other'))$$,'23514','opening scope conflict','case product cannot silently change');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.record_feed_opening_count(pg_temp.count_event())$$,'42501','opening forbidden','director role alone cannot capture');
select is(public.get_feed_opening('c2000000-0000-4000-8000-000000000001',(current_setting('test.c1')::jsonb->>'opening_id')::uuid)->>'can_approve','true','director may approve pending version');

select throws_ok($$select public.approve_feed_opening(pg_temp.approval(current_setting('test.c1')::jsonb))$$,'40001','opening revision conflict','director cannot approve obsolete count');
select set_config('test.approve',pg_temp.approval(current_setting('test.c2')::jsonb)::text,true);
select is(public.approve_feed_opening(current_setting('test.approve')::jsonb)->>'state_at_recording','approved','director approves exact current version');
select is(public.approve_feed_opening(current_setting('test.approve')::jsonb)->>'inventory_check','not_applied','approval does not apply inventory');
select is(public.approve_feed_opening(current_setting('test.approve')::jsonb)->>'duplicate','true','approval retry stable');
select is(public.get_feed_opening('c2000000-0000-4000-8000-000000000001',(current_setting('test.c1')::jsonb->>'opening_id')::uuid)->>'can_approve','false','approved case offers no second approval');

select throws_ok($$select public.approve_feed_opening(current_setting('test.approve')::jsonb||'{"reason":"changed"}')$$,'23505','opening id content conflict','approval content immutable');
select throws_ok($$select public.approve_feed_opening(pg_temp.approval(current_setting('test.c2')::jsonb))$$,'55000','opening already approved','second action does not approve twice');
select is((public.get_feed_opening('c2000000-0000-4000-8000-000000000001',(current_setting('test.c1')::jsonb->>'opening_id')::uuid)->'counts'->0->>'revision'),'2','context latest version');
select is((public.get_feed_opening('c2000000-0000-4000-8000-000000000001',(current_setting('test.c1')::jsonb->>'opening_id')::uuid)->'approval'->'event_payload'->>'count_id'),current_setting('test.c2')::jsonb->>'count_id','decision references exact count');
select throws_ok($$update public.feed_openings set status='pending'$$,'42501',null,'no direct header edit');
select throws_ok($$delete from public.feed_opening_counts$$,'42501',null,'no destructive count deletion');
select throws_ok($$update public.feed_opening_approvals set event_payload='{}'$$,'42501',null,'no destructive approval edit');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(public.record_feed_opening_count(current_setting('test.c1')::jsonb)->>'duplicate','true','original receipt recoverable after approval');
select throws_ok($$select public.record_feed_opening_count(current_setting('test.c2')::jsonb||jsonb_build_object('count_id',gen_random_uuid(),'expected_revision',2,'previous_count_id',current_setting('test.c2')::jsonb->>'count_id'))$$,'55000','opening already approved','approved case blocks new recount');
select is((select count(*)::int from public.feed_supply_events),0,'no implicit supply');
select is((select count(*)::int from public.feed_delivery_events),0,'no implicit delivery');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is((select count(*)::int from public.feed_openings),0,'foreign company no case visibility');
select is(jsonb_array_length(public.list_feed_openings('c2000000-0000-4000-8000-000000000001')->'items'),0,'foreign list empty');

select is(public.get_feed_opening('c2000000-0000-4000-8000-000000000001',(current_setting('test.c1')::jsonb->>'opening_id')::uuid),null::jsonb,'foreign context not found');
select throws_ok($$select public.approve_feed_opening(current_setting('test.approve')::jsonb)$$,'42501','opening forbidden','foreign cannot retry approval');

reset role;
update auth.users set raw_app_meta_data='{"tamago_initial_access_state":"pending"}'::jsonb where id='c1000000-0000-4000-8000-000000000001';
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(public.get_feed_opening('c2000000-0000-4000-8000-000000000001',(current_setting('test.c1')::jsonb->>'opening_id')::uuid),null::jsonb,'initial access pending no read');
select throws_ok($$select public.record_feed_opening_count(pg_temp.count_event())$$,'42501','opening forbidden','initial access pending no write');
reset role;set local role anon;
select throws_ok($$select public.record_feed_opening_count('{}')$$,'42501',null,'anon no capture RPC');
select throws_ok($$select public.approve_feed_opening('{}')$$,'42501',null,'anon no approval RPC');
reset role;select * from finish();rollback;
