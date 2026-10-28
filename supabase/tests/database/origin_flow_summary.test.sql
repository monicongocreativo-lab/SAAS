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

insert into public.collection_events(event_id,company_id,site_id,house_id,lot_id,business_date,occurrence,quantity_eggs,occurred_at,captured_at,actor_declared_id,device_id,captured_by)
select gen_random_uuid(),'c2000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001',d,o,q,d::timestamptz+interval '12 hours',d::timestamptz+interval '12 hours','ficticio',gen_random_uuid(),'c1000000-0000-4000-8000-000000000001'
from(values('2026-10-27'::date,1,100),('2026-10-26'::date,1,0),('2026-10-24'::date,1,1500000000),('2026-10-24'::date,2,1500000000)) t(d,o,q);
create function pg_temp.flow(d date default '2026-10-27') returns jsonb language sql as $$ select public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001',d)->'items'->0;$$;
create function pg_temp.dispatch(q integer) returns jsonb language sql as $$ select jsonb_build_object('transfer_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','origin_business_date','2026-10-27','quantity_sent',q,'sent_from','Galpón','sent_to','Bodega','sent_at','2026-10-27T13:00:00Z'); $$;
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(pg_temp.flow()->>'quantity_collected','100','canonical collected quantity');
select is(pg_temp.flow('2026-10-25')->'quantity_collected','null'::jsonb,'missing collection stays null');
select is(pg_temp.flow('2026-10-25')->'quantity_at_house','null'::jsonb,'unknown source never manufactures house stock');
select is(pg_temp.flow('2026-10-26')->>'quantity_collected','0','explicit zero retained');
select is(pg_temp.flow('2026-10-26')->>'collection_count','1','zero has real occurrence');
select is(pg_temp.flow('2026-10-24')->>'quantity_collected','3000000000','bigint aggregation does not overflow');
select set_config('test.transfer.a',(public.dispatch_collection_transfer(pg_temp.dispatch(60))->>'transfer_id'),true);
select set_config('test.transfer.b',(public.dispatch_collection_transfer(pg_temp.dispatch(30))->>'transfer_id'),true);
select public.dispatch_collection_transfer(pg_temp.dispatch(10));
select is(pg_temp.flow()->>'quantity_in_transit','100','only sent remains in transit before confirmation');
select is(pg_temp.flow()->>'quantity_at_house','0','all canonical eggs dispatched');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select public.confirm_collection_transfer_receipt(current_setting('test.transfer.a')::uuid,59,'Bodega','2026-10-27T14:00:00Z');
select public.confirm_collection_transfer_receipt(current_setting('test.transfer.b')::uuid,29,'Bodega','2026-10-27T14:00:00Z');
select is(pg_temp.flow()->>'quantity_collected','100','warehouse sees scoped canonical source');
select is(pg_temp.flow()->>'quantity_received','88','actual received counted once');
select is(pg_temp.flow()->>'receipt_count','2','confirmed receipts distinct from no information');
select is(pg_temp.flow()->>'quantity_in_transit','10','unreceived dispatch kept separate');
select is(pg_temp.flow()->>'custody_shortage','2','shortages independent of classification');
select is(pg_temp.flow()->>'open_incidents','2','open incidents visible');
select public.record_manual_classification(jsonb_build_object('schema_version',1,'session_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','origin_business_date','2026-10-27','classified_at','2026-10-28T12:00:00.000Z','machine_configuration_reference',null,'notes',null,
'inputs',jsonb_build_array(jsonb_build_object('transfer_id',current_setting('test.transfer.a'),'quantity_eggs',20),jsonb_build_object('transfer_id',current_setting('test.transfer.b'),'quantity_eggs',10)),
'lines',jsonb_build_array(jsonb_build_object('line_id',gen_random_uuid(),'quantity_eggs',25,'typology','AA','condition','DIRTY','destination','PENDING'),jsonb_build_object('line_id',gen_random_uuid(),'quantity_eggs',5,'typology','PIPO','condition','BROKEN','destination','DISCARD'))));
select is(pg_temp.flow()->>'quantity_collected','100','joining multiple lines/inputs never multiplies source');
select is(pg_temp.flow()->>'quantity_received','88','joining multiple lines never multiplies receipt');
select is(pg_temp.flow()->>'quantity_classified','30','inputs counted once across transfers');
select is(pg_temp.flow()->>'quantity_pending_classification','58','received minus consumed');
select is(pg_temp.flow()->>'quantity_destination_undefined','25','No definido is a destination, not unclassified');
select is(pg_temp.flow()->>'quantity_discard_declared','5','discard included in processed, not a second production');
select is(public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27')->>'purpose','consultation_only','no approval or close invented');
select throws_ok($$select public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27',-1)$$,'22023','invalid origin flow page','invalid pagination rejected');
-- Separate opposite custody differences must remain visible even when net=0.
reset role;
update public.collection_transfers set received_quantity=31 where transfer_id=current_setting('test.transfer.b')::uuid;
set local role authenticated;
select is(pg_temp.flow()->>'custody_difference','0','opposite differences have signed net zero');
select is(pg_temp.flow()->>'custody_shortage','1','net zero does not hide shortage');
select is(pg_temp.flow()->>'custody_surplus','1','net zero does not hide surplus');
select is(pg_temp.flow()->>'open_incidents','2','net zero does not close incidents');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is(jsonb_array_length(public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'),0,'foreign tenant sees no origin');
reset role;
update auth.users set raw_app_meta_data='{"tamago_initial_access_state":"pending"}' where id='c1000000-0000-4000-8000-000000000002';
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select is(jsonb_array_length(public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'),0,'temporary credential cannot consult origin data');
reset role;
insert into public.lots(id,company_id,site_id,house_id,code,status)
select gen_random_uuid(),'c2000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','SYN-PAGE-'||n,'active' from generate_series(1,26)n;
insert into public.role_assignments(company_id,membership_id,role_key) values('c2000000-0000-4000-8000-000000000001','c3000000-0000-4000-8000-000000000003','director');
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select is(jsonb_array_length(public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'),25,'first page 25 origins');
select is(public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27')->>'next_offset','25','more pages explicit');
select is(jsonb_array_length(public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27',25)->'items'),2,'second page 2 origins');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(jsonb_array_length(public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27')->'items'),1,'lot-scoped role cannot see other lots in company');
set local role anon;
select throws_ok($$select public.list_origin_flow_summary('c2000000-0000-4000-8000-000000000001','2026-10-27')$$,'42501',null,'anon cannot execute projection');
select * from finish();
rollback;
