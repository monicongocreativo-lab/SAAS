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




create function pg_temp.item_event(k text,code text) returns jsonb language sql as $$select jsonb_build_object('format','tamago.feed-catalog-item','schema_version',1,'item_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','kind',k,'code',code,'label','SYN-Mismo texto no es identidad','unit',case when k='product' then 'BAG_40KG' end,'reason','SYN-Validación Dirección');$$;
create function pg_temp.count_event() returns jsonb language sql as $$select jsonb_build_object('format','tamago.feed-opening-count','schema_version',1,'opening_id',gen_random_uuid(),'count_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date','2026-10-28','cutoff_at','2026-10-28T12:00:00.000Z','product_declared','SYN-Texto original','location_declared','SYN-Origen original','quantity','10','unit','BAG_40KG','evidence_reference','SYN-Conteo','notes',null,'expected_revision',0,'previous_count_id',null);$$;
create function pg_temp.move(k text,q text,t text) returns jsonb language plpgsql as $$declare e jsonb;begin
e:=jsonb_build_object('schema_version',1,'event_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date','2026-10-28','occurred_at',t,'product_declared','SYN-Texto original','quantity',q,'unit','BAG_40KG','physical_batch_declared',null,'notes',null);
if k='supply' then e:=e||jsonb_build_object('source_declared',null);perform public.record_feed_supply(e);else e:=e||jsonb_build_object('format','tamago.feed-delivery','location_declared','SYN-Origen original','supplier_declared',null,'delivery_reference_declared',null);perform public.record_feed_delivery(e);end if;return e;end;$$;
create function pg_temp.link(k text,src uuid,p uuid default null) returns jsonb language sql as $$ select jsonb_build_object('format','tamago.feed-fact-binding','schema_version',1,'binding_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','source_kind',k,'source_id',src,'product_id',coalesce(p,current_setting('test.product')::uuid),'location_id',current_setting('test.location')::uuid,'reason','SYN-Fuente física revisada');$$;
create function pg_temp.decision(src uuid,k text,choice text) returns jsonb language sql as $$select jsonb_build_object('format','tamago.feed-cutoff-decision','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.count')::jsonb->>'opening_id','count_id',current_setting('test.count')::jsonb->>'count_id','source_kind',k,'source_id',src,'classification',choice,'reason','SYN-Orden físico confirmado por Dirección');$$;
create function pg_temp.preview() returns jsonb language sql as $$select public.get_feed_balance_preview('c2000000-0000-4000-8000-000000000001',(current_setting('test.count')::jsonb->>'opening_id')::uuid,'2026-10-28T17:00:00Z');$$;

set local role authenticated;select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select set_config('test.catalog',pg_temp.item_event('product','MONTH')::text,true);select public.record_feed_catalog_item(current_setting('test.catalog')::jsonb);select set_config('test.product',current_setting('test.catalog')::jsonb->>'item_id',true);
select set_config('test.catalog2',pg_temp.item_event('product','LARGE')::text,true);select public.record_feed_catalog_item(current_setting('test.catalog2')::jsonb);
select set_config('test.loc',pg_temp.item_event('location','L1')::text,true);select public.record_feed_catalog_item(current_setting('test.loc')::jsonb);select set_config('test.location',current_setting('test.loc')::jsonb->>'item_id',true);
select set_config('test.count',(pg_temp.count_event()||'{"business_date":"2026-09-01","cutoff_at":"2026-09-01T12:00:00.000Z"}')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);select public.record_feed_opening_count(current_setting('test.count')::jsonb);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.approve_feed_opening(jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.count')::jsonb->>'opening_id','count_id',current_setting('test.count')::jsonb->>'count_id','expected_revision',1,'reason','SYN-Mes ficticio'));
select public.bind_feed_fact(pg_temp.link('count',(current_setting('test.count')::jsonb->>'count_id')::uuid));
create function pg_temp.monthbook() returns jsonb language sql as $$select public.get_feed_ledger_review('c2000000-0000-4000-8000-000000000001',(current_setting('test.count')::jsonb->>'opening_id')::uuid,'2026-09-30T23:00:00Z');$$;
create function pg_temp.monthcommand(activation boolean) returns jsonb language sql as $$select jsonb_build_object('format',case when activation then 'tamago.feed-inventory-activation' else 'tamago.feed-inventory-posting' end,'schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','through_at','2026-09-30T23:00:00.000Z','review_token',pg_temp.monthbook()->>'review_token','reason','SYN-Revisión mensual')||case when activation then jsonb_build_object('opening_id',current_setting('test.count')::jsonb->>'opening_id') else jsonb_build_object('account_id',pg_temp.monthbook()->'account'->>'account_id','expected_revision',(pg_temp.monthbook()->>'revision')::integer) end;$$;
do $$declare e jsonb;d text;begin
for n in 1..31 loop
 d:=to_char(date '2026-09-01'+(least(n,30)-1),'YYYY-MM-DD');
 e:=jsonb_build_object('schema_version',1,'event_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date',d,'occurred_at',d||case when n=31 then 'T15:00:00.000Z' else 'T14:00:00.000Z' end,'product_declared','SYN-Mes','quantity',case when n=31 then '0' else '0.25' end,'unit','BAG_40KG','source_declared',null,'physical_batch_declared',null,'notes',null);
 perform set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);perform public.record_feed_supply(e);perform public.record_feed_supply(e);
 perform set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);perform public.bind_feed_fact(pg_temp.link('supply',(e->>'event_id')::uuid));
end loop;end;$$;
select is((select count(*)::int from public.feed_supply_events),31,'month retries preserve 30 supplies plus explicit zero');
select is(pg_temp.monthbook()->>'source_count','31','month review counts all known sources');
select is(pg_temp.monthbook()->>'pending_sources','30','zero is retained without inventing a nonzero book effect');
select is(pg_temp.monthbook()->>'proposed_balance_bags','2.5','10 minus 30 times0.25 equals2.5 exactly');
select set_config('test.activation',pg_temp.monthcommand(true)::text,true);
select is(public.apply_feed_ledger(current_setting('test.activation')::jsonb)->>'balance_bags','2.5','full month applied atomically');
select is(public.apply_feed_ledger(current_setting('test.activation')::jsonb)->>'duplicate','true','full month activation retry exact');
select is((select count(*)::int from public.feed_ledger_entries),31,'one opening and30 nonzero immutable entries');
select is(jsonb_array_length(public.get_feed_ledger_entries('c2000000-0000-4000-8000-000000000001',(current_setting('test.activation')::jsonb->>'action_id')::uuid)->'items'),25,'history first25 entries');
select is(jsonb_array_length(public.get_feed_ledger_entries('c2000000-0000-4000-8000-000000000001',(current_setting('test.activation')::jsonb->>'action_id')::uuid,25)->'items'),6,'history remaining6 entries');
select is(jsonb_typeof(public.get_feed_ledger_entries('c2000000-0000-4000-8000-000000000001',(current_setting('test.activation')::jsonb->>'action_id')::uuid)->'items'->0->'delta'),'string','entry quantities serialize without Number precision loss');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.late',jsonb_build_object('schema_version',1,'event_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date','2026-09-15','occurred_at','2026-09-15T16:00:00.000Z','product_declared','SYN-Tardío','quantity','0.5','unit','BAG_40KG','source_declared',null,'physical_batch_declared',null,'notes',null)::text,true);select public.record_feed_supply(current_setting('test.late')::jsonb);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);select public.bind_feed_fact(pg_temp.link('supply',(current_setting('test.late')::jsonb->>'event_id')::uuid));
select is(pg_temp.monthbook()->>'book_balance_bags','2.5','late physical fact does not rewrite month book');
select is(pg_temp.monthbook()->>'status','pending','late fact requires explicit application');
select is(public.apply_feed_ledger(pg_temp.monthcommand(false))->>'balance_bags','2','late0.5 applied exactly once');
select is(public.apply_feed_ledger(current_setting('test.activation')::jsonb)->>'balance_bags','2.5','old monthly acknowledgment remains historical');
select is(pg_temp.monthbook()->>'available_bags','2','old acknowledgment cannot reset current month');
-- Large opening and tiny positive receipt survive every JSON boundary as strings.
select set_config('test.big',(pg_temp.count_event()||jsonb_build_object('opening_id',gen_random_uuid(),'count_id',gen_random_uuid(),'business_date','2026-09-01','cutoff_at','2026-09-01T12:00:00.000Z','quantity','9007199254740993.125'))::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);select public.record_feed_opening_count(current_setting('test.big')::jsonb);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);select public.approve_feed_opening(jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.big')::jsonb->>'opening_id','count_id',current_setting('test.big')::jsonb->>'count_id','expected_revision',1,'reason','SYN-Exactitud'));select public.bind_feed_fact(pg_temp.link('count',(current_setting('test.big')::jsonb->>'count_id')::uuid,(current_setting('test.catalog2')::jsonb->>'item_id')::uuid));
select set_config('test.bigtoken',public.get_feed_ledger_review('c2000000-0000-4000-8000-000000000001',(current_setting('test.big')::jsonb->>'opening_id')::uuid,'2026-09-30T23:00:00Z')->>'review_token',true);
select set_config('test.bigact',jsonb_build_object('format','tamago.feed-inventory-activation','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.big')::jsonb->>'opening_id','through_at','2026-09-30T23:00:00.000Z','review_token',current_setting('test.bigtoken'),'reason','SYN-Exactitud')::text,true);
select is(public.apply_feed_ledger(current_setting('test.bigact')::jsonb)->>'balance_bags','9007199254740993.125','large opening does not round through JSON');
select is(jsonb_typeof(public.get_feed_ledger_review('c2000000-0000-4000-8000-000000000001',(current_setting('test.big')::jsonb->>'opening_id')::uuid,'2026-09-30T23:00:00Z')->'account'->'opening_quantity'),'string','account opening amount remains decimal string');
reset role;select * from finish();rollback;
