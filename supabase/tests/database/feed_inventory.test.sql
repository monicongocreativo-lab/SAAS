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
set local role authenticated;select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.count',pg_temp.count_event()::text,true);
select public.record_feed_opening_count(current_setting('test.count')::jsonb);
select is(pg_temp.preview()->>'reason','opening_not_approved','pending count is not a balance opening');
select throws_ok($$select public.record_feed_catalog_item(pg_temp.item_event('product','F1'))$$,'42501','inventory forbidden','capture cannot create catalog');
select set_config('test.pre',pg_temp.move('delivery','100','2026-10-28T10:00:00.000Z')::text,true);
select set_config('test.post',pg_temp.move('delivery','2.5','2026-10-28T13:00:00.000Z')::text,true);
select set_config('test.supply',pg_temp.move('supply','1.25','2026-10-28T14:00:00.000Z')::text,true);
select set_config('test.tie_in',pg_temp.move('delivery','3','2026-10-28T12:00:00.000Z')::text,true);
select set_config('test.tie_out',pg_temp.move('supply','0.5','2026-10-28T12:00:00.000Z')::text,true);
select set_config('test.other',pg_temp.move('delivery','7','2026-10-28T15:00:00.000Z')::text,true);
select set_config('test.unmapped',pg_temp.move('delivery','1','2026-10-28T16:00:00.000Z')::text,true);
select pg_temp.move('delivery','50','2026-10-28T18:00:00.000Z');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.approve_feed_opening(jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.count')::jsonb->>'opening_id','count_id',current_setting('test.count')::jsonb->>'count_id','expected_revision',1,'reason','SYN-Revisado'));
select is(pg_temp.preview()->>'reason','opening_not_linked','approved count still needs identity binding');
select set_config('test.catalog',pg_temp.item_event('product','F1')::text,true);
select is(public.record_feed_catalog_item(current_setting('test.catalog')::jsonb)->>'duplicate','false','director creates stable product');
select is(public.record_feed_catalog_item(current_setting('test.catalog')::jsonb)->>'duplicate','true','catalog retry stable');
select throws_ok($$select public.record_feed_catalog_item(current_setting('test.catalog')::jsonb||'{"label":"changed"}')$$,'23505','inventory id content conflict','catalog identity cannot silently change');
select set_config('test.product',current_setting('test.catalog')::jsonb->>'item_id',true);
select set_config('test.catalog2',pg_temp.item_event('product','F2')::text,true);select public.record_feed_catalog_item(current_setting('test.catalog2')::jsonb);
select set_config('test.loc',pg_temp.item_event('location','L1')::text,true);select public.record_feed_catalog_item(current_setting('test.loc')::jsonb);select set_config('test.location',current_setting('test.loc')::jsonb->>'item_id',true);
select is((select count(*)::int from public.feed_catalog_items where label='SYN-Mismo texto no es identidad'),3,'same labels have separate typed identities');
select is(jsonb_array_length(public.list_feed_catalog('c2000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001')->'items'),3,'scoped safe catalog projection');
select throws_ok($$select event_payload from public.feed_catalog_items$$,'42501',null,'raw catalog audit payload not exposed to client role');

select throws_ok($$select public.record_feed_catalog_item(pg_temp.item_event('product','F1'))$$,'23505',null,'code cannot be reused for another identity');
select throws_ok($$select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.pre')::jsonb->>'event_id')::uuid,current_setting('test.location')::uuid))$$,'23514','inventory catalog scope conflict','location cannot masquerade as product');
select set_config('test.binding',pg_temp.link('count',(current_setting('test.count')::jsonb->>'count_id')::uuid)::text,true);
select is(public.bind_feed_fact(current_setting('test.binding')::jsonb)->>'duplicate','false','count bound explicitly');
select is(public.bind_feed_fact(current_setting('test.binding')::jsonb)->>'duplicate','true','binding retry stable');
select throws_ok($$select public.bind_feed_fact(current_setting('test.binding')::jsonb||'{"reason":"changed"}')$$,'23505','inventory id content conflict','binding content immutable');
select is(pg_temp.preview()->>'unmapped_count','6','unmapped future excluded, earlier movement not counted twice');
select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.post')::jsonb->>'event_id')::uuid));
select public.bind_feed_fact(pg_temp.link('supply',(current_setting('test.supply')::jsonb->>'event_id')::uuid));
select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.tie_in')::jsonb->>'event_id')::uuid));
select public.bind_feed_fact(pg_temp.link('supply',(current_setting('test.tie_out')::jsonb->>'event_id')::uuid));
select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.other')::jsonb->>'event_id')::uuid,(current_setting('test.catalog2')::jsonb->>'item_id')::uuid));
select is(pg_temp.preview()->>'unmapped_count','1','unknown relevant movement blocks target account conservatively');
select is(pg_temp.preview()->>'pending_tie_count','2','ties do not get arbitrary chronological treatment');
select is(pg_temp.preview()->>'diagnostic_balance_bags','11.25','known partial arithmetic exact, other product excluded');
select is(pg_temp.preview()->>'balance_bags',null::text,'blocked balance never presented as verified');
select set_config('test.decision',pg_temp.decision((current_setting('test.tie_in')::jsonb->>'event_id')::uuid,'delivery','included_in_count')::text,true);
select is(public.record_feed_cutoff_decision(current_setting('test.decision')::jsonb)->>'duplicate','false','director resolves tie already counted');
select is(public.record_feed_cutoff_decision(current_setting('test.decision')::jsonb)->>'duplicate','true','decision retry stable');
select throws_ok($$select public.record_feed_cutoff_decision(current_setting('test.decision')::jsonb||'{"classification":"after_count"}')$$,'23505','inventory id content conflict','tie decision immutable');
select public.record_feed_cutoff_decision(pg_temp.decision((current_setting('test.tie_out')::jsonb->>'event_id')::uuid,'supply','after_count'));
select throws_ok($$select public.record_feed_cutoff_decision(pg_temp.decision((current_setting('test.post')::jsonb->>'event_id')::uuid,'delivery','included_in_count'))$$,'23514','inventory cutoff scope conflict','cannot override a different timestamp');
select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.unmapped')::jsonb->>'event_id')::uuid));
select is(pg_temp.preview()->>'status','resolved','all visible blockers resolved');
select is(pg_temp.preview()->>'balance_bags','11.75','10 + 2.5 + 1 - 1.25 - 0.5, no earlier or included tie duplicate');
select is(pg_temp.preview()->>'inventory_check','not_applied','preview is not inventory activation');
select is((select event_payload->>'product_declared' from public.feed_opening_counts),'SYN-Texto original','mapping never overwrites original declared labels');
select is(public.get_feed_balance_preview('c2000000-0000-4000-8000-000000000001',(current_setting('test.count')::jsonb->>'opening_id')::uuid,'2026-10-28T11:00:00Z')->>'reason','cutoff_after_through','cannot compute before physical opening cut');
select throws_ok($$update public.feed_fact_bindings set product_id=gen_random_uuid()$$,'42501',null,'no destructive remapping');
select throws_ok($$delete from public.feed_cutoff_decisions$$,'42501',null,'no destructive cutoff decision');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(pg_temp.preview()->>'balance_bags','11.75','capture may consult assigned account');
select throws_ok($$select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.pre')::jsonb->>'event_id')::uuid))$$,'42501','inventory forbidden','capture cannot assign identities');
select throws_ok($$select public.record_feed_cutoff_decision(current_setting('test.decision')::jsonb)$$,'42501','inventory forbidden','capture cannot claim director decision');

select set_config('test.tiny',pg_temp.move('delivery','0.000000000000000000001','2026-10-28T16:30:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.tiny')::jsonb->>'event_id')::uuid));
select is(pg_temp.preview()->>'balance_bags','11.750000000000000000001','SQL decimal mass retains tiny fraction exactly');
reset role;
select throws_ok($$delete from public.feed_delivery_events where event_id=(current_setting('test.post')::jsonb->>'event_id')::uuid$$,'23503',null,'even privileged deletion cannot orphan a bound source');
insert into public.feed_catalog_items(item_id,company_id,kind,code,label,unit,event_payload,recorded_by)
values('d9000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000002','product','FOREIGN','SYN-Mismo texto no es identidad','BAG_40KG','{}','c1000000-0000-4000-8000-000000000004');
set local role authenticated;select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.pre')::jsonb->>'event_id')::uuid,'d9000000-0000-4000-8000-000000000001'))$$,'23514','inventory catalog scope conflict','other company product cannot be assigned');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.countB',(current_setting('test.count')::jsonb||jsonb_build_object('opening_id',gen_random_uuid(),'count_id',gen_random_uuid(),'quantity','20'))::text,true);
select public.record_feed_opening_count(current_setting('test.countB')::jsonb);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.approve_feed_opening(jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.countB')::jsonb->>'opening_id','count_id',current_setting('test.countB')::jsonb->>'count_id','expected_revision',1,'reason','SYN-Caso independiente'));
select public.bind_feed_fact(pg_temp.link('count',(current_setting('test.countB')::jsonb->>'count_id')::uuid));
select is(public.get_feed_balance_preview('c2000000-0000-4000-8000-000000000001',(current_setting('test.countB')::jsonb->>'opening_id')::uuid,'2026-10-28T17:00:00Z')->>'pending_tie_count','2','decision of another opening never resolves this cut');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.excess',pg_temp.move('supply','100','2026-10-28T16:45:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.bind_feed_fact(pg_temp.link('supply',(current_setting('test.excess')::jsonb->>'event_id')::uuid));
select is(pg_temp.preview()->>'status','negative','negative diagnostic flagged without clamping');
select is(pg_temp.preview()->>'balance_bags',null::text,'negative diagnostic is not available stock');
select is(pg_temp.preview()->>'diagnostic_balance_bags','-88.249999999999999999999','negative arithmetic remains exact');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is(pg_temp.preview(),null::jsonb,'foreign company has no preview');
select throws_ok($$select public.list_feed_catalog('c2000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001')$$,'42501','inventory forbidden','foreign catalog access denied');
select throws_ok($$select public.get_feed_inventory_context('c2000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001')$$,'42501','inventory forbidden','foreign context denied');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select is(public.get_feed_inventory_context('c2000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001')->>'can_manage','true','Director manages approved case scope');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(public.get_feed_inventory_context('c2000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001')->>'can_manage','false','capture cannot manage catalog');
reset role;set local role anon;
select throws_ok($$select public.record_feed_catalog_item('{}')$$,'42501',null,'anon cannot create catalog');
reset role;select * from finish();rollback;
