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

set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select set_config('test.catalog',pg_temp.item_event('product','F1')::text,true);select public.record_feed_catalog_item(current_setting('test.catalog')::jsonb);
select set_config('test.product',current_setting('test.catalog')::jsonb->>'item_id',true);
select set_config('test.catalog2',pg_temp.item_event('product','F2')::text,true);select public.record_feed_catalog_item(current_setting('test.catalog2')::jsonb);
select set_config('test.loc',pg_temp.item_event('location','L1')::text,true);select public.record_feed_catalog_item(current_setting('test.loc')::jsonb);select set_config('test.location',current_setting('test.loc')::jsonb->>'item_id',true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.count',pg_temp.count_event()::text,true);select public.record_feed_opening_count(current_setting('test.count')::jsonb);
select set_config('test.tie',pg_temp.move('delivery','3','2026-10-28T12:00:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.approve_feed_opening(jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.count')::jsonb->>'opening_id','count_id',current_setting('test.count')::jsonb->>'count_id','expected_revision',1,'reason','SYN-Revisado'));
select set_config('test.mapcount',pg_temp.link('count',(current_setting('test.count')::jsonb->>'count_id')::uuid)::text,true);select public.bind_feed_fact(current_setting('test.mapcount')::jsonb);
select set_config('test.map',pg_temp.link('delivery',(current_setting('test.tie')::jsonb->>'event_id')::uuid)::text,true);select public.bind_feed_fact(current_setting('test.map')::jsonb);
select set_config('test.decision',pg_temp.decision((current_setting('test.tie')::jsonb->>'event_id')::uuid,'delivery','after_count')::text,true);select public.record_feed_cutoff_decision(current_setting('test.decision')::jsonb);
create function pg_temp.correction(k text,target uuid,n integer,prev uuid default null) returns jsonb language sql as $$
 select jsonb_build_object('format','tamago.feed-inventory-correction','schema_version',1,'revision_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','target_kind',k,'target_id',target,'expected_revision',n,'previous_revision_id',prev,'reason','SYN-Soporte revisado')||case when k='binding' then jsonb_build_object('product_id',current_setting('test.catalog2')::jsonb->>'item_id','location_id',current_setting('test.location')) else jsonb_build_object('classification','included_in_count','expected_opening_binding_revision',0,'expected_movement_binding_revision',0) end;
$$;
select is(pg_temp.preview()->>'balance_bags','13','baseline before correction');
select set_config('test.dc',pg_temp.correction('cutoff',(current_setting('test.decision')::jsonb->>'action_id')::uuid,0)::text,true);
select is(public.correct_feed_inventory(current_setting('test.dc')::jsonb)->>'duplicate','false','decision corrected by new immutable event');
select is(pg_temp.preview()->>'balance_bags','10','corrected tie applied once');
select is(public.correct_feed_inventory(current_setting('test.dc')::jsonb)->>'duplicate','true','exact correction retry');
select throws_ok($$select public.correct_feed_inventory(current_setting('test.dc')::jsonb||'{"reason":"changed"}')$$,'23505','inventory correction id content conflict','correction ID cannot change payload');
select throws_ok($$select public.correct_feed_inventory(current_setting('test.dc')::jsonb||jsonb_build_object('revision_id',gen_random_uuid()))$$,'40001','inventory correction stale version','parallel writer with old version conflicts');
select set_config('test.b1',pg_temp.correction('binding',(current_setting('test.map')::jsonb->>'binding_id')::uuid,0)::text,true);
select is(public.correct_feed_inventory(current_setting('test.b1')::jsonb)->>'duplicate','false','binding corrected without overwriting original');
select is(pg_temp.preview()->>'balance_bags','10','movement now belongs to another account');
select is((select product_id::text from public.feed_fact_bindings where binding_id=(current_setting('test.map')::jsonb->>'binding_id')::uuid),current_setting('test.product'),'base binding remains unchanged');
select is((select event_payload from public.feed_delivery_events),current_setting('test.tie')::jsonb,'source payload remains unchanged');
select set_config('test.b2',(pg_temp.correction('binding',(current_setting('test.map')::jsonb->>'binding_id')::uuid,1,(current_setting('test.b1')::jsonb->>'revision_id')::uuid)||jsonb_build_object('product_id',current_setting('test.product')))::text,true);
select public.correct_feed_inventory(current_setting('test.b2')::jsonb);
select is(pg_temp.preview()->>'pending_tie_count','1','returning to former account does not resurrect old tie decision');
select is(pg_temp.preview()->>'balance_bags',null::text,'changed binding blocks preview until explicit review');
select throws_ok($$select public.correct_feed_inventory(pg_temp.correction('cutoff',(current_setting('test.decision')::jsonb->>'action_id')::uuid,1,(current_setting('test.dc')::jsonb->>'revision_id')::uuid))$$,'40001','inventory correction stale binding','decision requires current movement binding revision');
select set_config('test.dc2',(pg_temp.correction('cutoff',(current_setting('test.decision')::jsonb->>'action_id')::uuid,1,(current_setting('test.dc')::jsonb->>'revision_id')::uuid)||'{"expected_movement_binding_revision":2}')::text,true);
select public.correct_feed_inventory(current_setting('test.dc2')::jsonb);
select is(pg_temp.preview()->>'balance_bags','10','same choice revalidated against new binding context');
select is(public.correct_feed_inventory(current_setting('test.dc')::jsonb)->>'duplicate','true','old exact retry remains idempotent after newer corrections');
select is(pg_temp.preview()->>'balance_bags','10','old retry never restores obsolete correction');
select set_config('test.bc',pg_temp.correction('binding',(current_setting('test.mapcount')::jsonb->>'binding_id')::uuid,0)::text,true);select public.correct_feed_inventory(current_setting('test.bc')::jsonb);
select set_config('test.b3',pg_temp.correction('binding',(current_setting('test.map')::jsonb->>'binding_id')::uuid,2,(current_setting('test.b2')::jsonb->>'revision_id')::uuid)::text,true);select public.correct_feed_inventory(current_setting('test.b3')::jsonb);
select is(pg_temp.preview()->>'pending_tie_count','1','count binding correction also invalidates prior tie context');
select set_config('test.dc3',(pg_temp.correction('cutoff',(current_setting('test.decision')::jsonb->>'action_id')::uuid,2,(current_setting('test.dc2')::jsonb->>'revision_id')::uuid)||'{"expected_opening_binding_revision":1,"expected_movement_binding_revision":3}')::text,true);select public.correct_feed_inventory(current_setting('test.dc3')::jsonb);
select is(pg_temp.preview()->>'balance_bags','10','review on both corrected binding versions resolves');
select is(public.get_feed_fact_binding('c2000000-0000-4000-8000-000000000001','delivery',(current_setting('test.tie')::jsonb->>'event_id')::uuid)->>'correction_revision','3','binding read exposes effective version');
select is((select count(*)::int from public.feed_inventory_revisions),7,'all seven corrections retained');
select is(public.get_feed_inventory_history('c2000000-0000-4000-8000-000000000001','binding',(current_setting('test.map')::jsonb->>'binding_id')::uuid)->>'current_revision','3','history exposes current correction head');
select is(jsonb_array_length(public.get_feed_inventory_history('c2000000-0000-4000-8000-000000000001','binding',(current_setting('test.map')::jsonb->>'binding_id')::uuid)->'items'),3,'history contains every binding revision');
select throws_ok($$select public.correct_feed_inventory(pg_temp.correction('binding',(current_setting('test.map')::jsonb->>'binding_id')::uuid,3,(current_setting('test.b3')::jsonb->>'revision_id')::uuid))$$,'23514','inventory unchanged binding','unchanged binding does not manufacture revision');
select throws_ok($$select public.correct_feed_inventory(pg_temp.correction('binding',(current_setting('test.map')::jsonb->>'binding_id')::uuid,3,(current_setting('test.dc3')::jsonb->>'revision_id')::uuid))$$,'40001','inventory correction stale version','previous revision must be actual chain head');
select throws_ok($$update public.feed_inventory_revisions set version=99$$,'42501',null,'no direct revision update');
select throws_ok($$delete from public.feed_inventory_revisions$$,'42501',null,'no revision deletion');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.fresh',pg_temp.move('delivery','1','2026-10-28T12:00:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select set_config('test.fm',pg_temp.link('delivery',(current_setting('test.fresh')::jsonb->>'event_id')::uuid)::text,true);select public.bind_feed_fact(current_setting('test.fm')::jsonb);
select set_config('test.fc',pg_temp.correction('binding',(current_setting('test.fm')::jsonb->>'binding_id')::uuid,0)::text,true);select public.correct_feed_inventory(current_setting('test.fc')::jsonb);
select set_config('test.fd',pg_temp.decision((current_setting('test.fresh')::jsonb->>'event_id')::uuid,'delivery','after_count')::text,true);
select throws_ok($$select public.record_feed_cutoff_decision(current_setting('test.fd')::jsonb)$$,'23514','inventory reviewed binding version required','legacy first decision cannot silently accept corrected bindings');
select throws_ok($$select public.record_feed_cutoff_decision(current_setting('test.fd')::jsonb||'{"expected_opening_binding_revision":0,"expected_movement_binding_revision":1}')$$,'40001','inventory decision stale binding','new first decision checks reviewed opening version');
select lives_ok($$select public.record_feed_cutoff_decision(current_setting('test.fd')::jsonb||'{"expected_opening_binding_revision":1,"expected_movement_binding_revision":1}')$$,'version-guarded initial decision works after corrections');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(public.get_feed_inventory_history('c2000000-0000-4000-8000-000000000001','cutoff',(current_setting('test.decision')::jsonb->>'action_id')::uuid)->>'current_revision','3','capture may read authorized audit');
select throws_ok($$select public.correct_feed_inventory(current_setting('test.dc')::jsonb)$$,'42501','inventory forbidden','capture cannot retry Director correction');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is(public.get_feed_inventory_history('c2000000-0000-4000-8000-000000000001','cutoff',(current_setting('test.decision')::jsonb->>'action_id')::uuid),null::jsonb,'foreign history absent');
select is((select count(*)::int from public.feed_inventory_revisions),0,'foreign raw audit hidden by RLS');
select throws_ok($$select public.correct_feed_inventory(current_setting('test.dc')::jsonb)$$,'42501','inventory forbidden','foreign correction denied');
reset role;set local role anon;
select throws_ok($$select public.correct_feed_inventory('{}')$$,'42501',null,'anon cannot correct');
reset role;select * from finish();rollback;
