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
create function pg_temp.count_event() returns jsonb language sql as $$select jsonb_build_object('format','tamago.feed-opening-count','schema_version',1,'opening_id',gen_random_uuid(),'count_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date','2026-10-27','cutoff_at','2026-10-27T12:00:00.000Z','product_declared','SYN-Texto original','location_declared','SYN-Origen original','quantity','10','unit','BAG_40KG','evidence_reference','SYN-Conteo','notes',null,'expected_revision',0,'previous_count_id',null);$$;
create function pg_temp.move(k text,q text,t text) returns jsonb language plpgsql as $$declare e jsonb;begin
e:=jsonb_build_object('schema_version',1,'event_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','site_id','c4000000-0000-4000-8000-000000000001','house_id','c5000000-0000-4000-8000-000000000001','lot_id','c6000000-0000-4000-8000-000000000001','business_date','2026-10-27','occurred_at',t,'product_declared','SYN-Texto original','quantity',q,'unit','BAG_40KG','physical_batch_declared',null,'notes',null);
if k='supply' then e:=e||jsonb_build_object('source_declared',null);perform public.record_feed_supply(e);else e:=e||jsonb_build_object('format','tamago.feed-delivery','location_declared','SYN-Origen original','supplier_declared',null,'delivery_reference_declared',null);perform public.record_feed_delivery(e);end if;return e;end;$$;
create function pg_temp.link(k text,src uuid,p uuid default null) returns jsonb language sql as $$ select jsonb_build_object('format','tamago.feed-fact-binding','schema_version',1,'binding_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','source_kind',k,'source_id',src,'product_id',coalesce(p,current_setting('test.product')::uuid),'location_id',current_setting('test.location')::uuid,'reason','SYN-Fuente física revisada');$$;
create function pg_temp.decision(src uuid,k text,choice text) returns jsonb language sql as $$select jsonb_build_object('format','tamago.feed-cutoff-decision','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.count')::jsonb->>'opening_id','count_id',current_setting('test.count')::jsonb->>'count_id','source_kind',k,'source_id',src,'classification',choice,'reason','SYN-Orden físico confirmado por Dirección');$$;
create function pg_temp.preview() returns jsonb language sql as $$select public.get_feed_balance_preview('c2000000-0000-4000-8000-000000000001',(current_setting('test.count')::jsonb->>'opening_id')::uuid,'2026-10-27T17:00:00Z');$$;

set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select set_config('test.catalog',pg_temp.item_event('product','F1')::text,true);select public.record_feed_catalog_item(current_setting('test.catalog')::jsonb);
select set_config('test.product',current_setting('test.catalog')::jsonb->>'item_id',true);
select set_config('test.catalog2',pg_temp.item_event('product','F2')::text,true);select public.record_feed_catalog_item(current_setting('test.catalog2')::jsonb);
select set_config('test.loc',pg_temp.item_event('location','L1')::text,true);select public.record_feed_catalog_item(current_setting('test.loc')::jsonb);select set_config('test.location',current_setting('test.loc')::jsonb->>'item_id',true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.count',pg_temp.count_event()::text,true);select public.record_feed_opening_count(current_setting('test.count')::jsonb);
select set_config('test.tie',pg_temp.move('delivery','3','2026-10-27T12:00:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.approve_feed_opening(jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.count')::jsonb->>'opening_id','count_id',current_setting('test.count')::jsonb->>'count_id','expected_revision',1,'reason','SYN-Revisado'));
select set_config('test.mapcount',pg_temp.link('count',(current_setting('test.count')::jsonb->>'count_id')::uuid)::text,true);select public.bind_feed_fact(current_setting('test.mapcount')::jsonb);
select set_config('test.map',pg_temp.link('delivery',(current_setting('test.tie')::jsonb->>'event_id')::uuid)::text,true);select public.bind_feed_fact(current_setting('test.map')::jsonb);
select set_config('test.decision',pg_temp.decision((current_setting('test.tie')::jsonb->>'event_id')::uuid,'delivery','after_count')::text,true);select public.record_feed_cutoff_decision(current_setting('test.decision')::jsonb);

create function pg_temp.book() returns jsonb language sql as $$select public.get_feed_ledger_review('c2000000-0000-4000-8000-000000000001',(current_setting('test.count')::jsonb->>'opening_id')::uuid,'2026-10-27T17:00:00Z');$$;
create function pg_temp.command(activation boolean default false) returns jsonb language plpgsql as $$declare b jsonb:=pg_temp.book();begin
 return jsonb_build_object('format',case when activation then 'tamago.feed-inventory-activation' else 'tamago.feed-inventory-posting' end,'schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','through_at','2026-10-27T17:00:00.000Z','review_token',b->>'review_token','reason','SYN-Libro revisado')||case when activation then jsonb_build_object('opening_id',current_setting('test.count')::jsonb->>'opening_id') else jsonb_build_object('account_id',b->'account'->>'account_id','expected_revision',(b->>'revision')::integer) end;
end;$$;
select is(pg_temp.book()->>'status','needs_activation','approved count still requires explicit activation');
select set_config('test.activation',pg_temp.command(true)::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select is(pg_temp.book()->>'can_activate','false','capture cannot activate');
select throws_ok($$select public.apply_feed_ledger(current_setting('test.activation')::jsonb)$$,'42501','ledger forbidden','capture activation denied');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select is(public.apply_feed_ledger(current_setting('test.activation')::jsonb)->>'balance_bags','13','opening10 + reviewed tie3 applied once');
select is(public.apply_feed_ledger(current_setting('test.activation')::jsonb)->>'duplicate','true','activation retry preserves original receipt');
select is(pg_temp.book()->>'available_bags','13','current book available at reviewed window');
select is((select count(*)::int from public.feed_ledger_entries),2,'one opening and one source entry');
select throws_ok($$update public.feed_inventory_accounts set opening_quantity=999$$,'42501',null,'opening cannot be overwritten');
select throws_ok($$delete from public.feed_ledger_entries$$,'42501',null,'book entries cannot be erased');
select throws_ok($$select private.record_feed_supply_prebook('{}')$$,'42501',null,'old source writer is not publicly callable');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.supply',pg_temp.move('supply','1.25','2026-10-27T14:00:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select is(pg_temp.book()->>'status','blocked','unmapped physical source blocks book freshness');
select is(pg_temp.book()->>'available_bags',null::text,'stale book not offered as available');
select public.bind_feed_fact(pg_temp.link('supply',(current_setting('test.supply')::jsonb->>'event_id')::uuid));
select is(pg_temp.book()->>'status','pending','mapped source requires explicit application');
select is(pg_temp.book()->>'book_balance_bags','13','capturing source never silently changes book');
select is(pg_temp.book()->>'proposed_balance_bags','11.75','proposed debit exact');
select set_config('test.post',pg_temp.command()::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.receipt',pg_temp.move('delivery','2','2026-10-27T15:00:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select throws_ok($$select public.apply_feed_ledger(current_setting('test.post')::jsonb)$$,'40001','ledger reviewed set changed','late source invalidates reviewed token');
select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.receipt')::jsonb->>'event_id')::uuid));
select set_config('test.post',pg_temp.command()::text,true);
select is(public.apply_feed_ledger(current_setting('test.post')::jsonb)->>'balance_bags','13.75','reviewed receipt and supply applied atomically');
select is(public.apply_feed_ledger(current_setting('test.post')::jsonb)->>'duplicate','true','posting retry never doubles movements');
select is(public.apply_feed_ledger(current_setting('test.activation')::jsonb)->>'balance_bags','13','old activation retry returns old action not current balance');
select is(pg_temp.book()->>'book_balance_bags','13.75','old retry does not reset current book');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.excess',pg_temp.move('supply','100','2026-10-27T16:00:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.bind_feed_fact(pg_temp.link('supply',(current_setting('test.excess')::jsonb->>'event_id')::uuid));
select is(pg_temp.book()->>'status','insufficient','insufficient supply remains pending review');
select is(pg_temp.book()->>'book_balance_bags','13.75','insufficient proposal does not mutate book');
select is(pg_temp.book()->>'available_bags',null::text,'insufficient proposal cannot claim availability');
select throws_ok($$select public.apply_feed_ledger(pg_temp.command())$$,'23514','ledger application pending review','negative book rejected atomically');
select is((select count(*)::int from public.feed_supply_events),2,'physical supplies preserved even when unapplied');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);
select set_config('test.fix',pg_temp.move('delivery','100','2026-10-27T16:30:00.000Z')::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.bind_feed_fact(pg_temp.link('delivery',(current_setting('test.fix')::jsonb->>'event_id')::uuid));
select is(public.apply_feed_ledger(pg_temp.command())->>'balance_bags','13.75','later evidenced receipt permits full reviewed set without dropping supply');
select public.correct_feed_inventory(jsonb_build_object('format','tamago.feed-inventory-correction','schema_version',1,'revision_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','target_kind','cutoff','target_id',current_setting('test.decision')::jsonb->>'action_id','expected_revision',0,'previous_revision_id',null,'classification','included_in_count','expected_opening_binding_revision',0,'expected_movement_binding_revision',0,'reason','SYN-Revisión de empate'));
select is(pg_temp.book()->>'book_balance_bags','13.75','correction itself does not rewrite book');
select is(pg_temp.book()->>'proposed_balance_bags','10.75','correction proposes compensated source effect');
select is(public.apply_feed_ledger(pg_temp.command())->>'balance_bags','10.75','compensating entry records correction');
select is((select count(*)::int from public.feed_ledger_entries where source_id=(current_setting('test.tie')::jsonb->>'event_id')::uuid),2,'original and compensating source entries retained');
select is((select sum(delta)::text from public.feed_ledger_entries where source_id=(current_setting('test.tie')::jsonb->>'event_id')::uuid),'0','corrected tie has zero net effect');
select throws_ok($$select public.apply_feed_ledger(pg_temp.command())$$,'23514','ledger application pending review','same set cannot be applied again with a new ID');
select is((select count(*)::int from public.feed_inventory_accounts),1,'only first effective opening exists');
select is(public.get_feed_ledger_review('c2000000-0000-4000-8000-000000000001',(current_setting('test.count')::jsonb->>'opening_id')::uuid,'2026-10-27T16:00:00Z')->>'status','earlier_window','book window never goes backwards');
select is(public.get_feed_ledger_review('c2000000-0000-4000-8000-000000000001',(current_setting('test.count')::jsonb->>'opening_id')::uuid,'2099-10-27T17:00:00Z')->>'status','future_window','future window cannot be applied');
-- A second approved case in the same account cannot replace the effective opening.
select set_config('test.othercount',(pg_temp.count_event()||jsonb_build_object('opening_id',gen_random_uuid(),'count_id',gen_random_uuid(),'quantity','5'))::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);select public.record_feed_opening_count(current_setting('test.othercount')::jsonb);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.approve_feed_opening(jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.othercount')::jsonb->>'opening_id','count_id',current_setting('test.othercount')::jsonb->>'count_id','expected_revision',1,'reason','SYN-Otro caso'));
select public.bind_feed_fact(pg_temp.link('count',(current_setting('test.othercount')::jsonb->>'count_id')::uuid));
select is(public.get_feed_ledger_review('c2000000-0000-4000-8000-000000000001',(current_setting('test.othercount')::jsonb->>'opening_id')::uuid,'2026-10-27T17:00:00Z')->>'status','already_active','another approved count cannot silently replace active opening');
-- Independent zero opening for the other product.
select set_config('test.countb',(pg_temp.count_event()||jsonb_build_object('opening_id',gen_random_uuid(),'count_id',gen_random_uuid(),'quantity','0'))::text,true);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000001',true);select public.record_feed_opening_count(current_setting('test.countb')::jsonb);
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select public.approve_feed_opening(jsonb_build_object('format','tamago.feed-opening-approval','schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','opening_id',current_setting('test.countb')::jsonb->>'opening_id','count_id',current_setting('test.countb')::jsonb->>'count_id','expected_revision',1,'reason','SYN-Cero físico'));
select public.bind_feed_fact(pg_temp.link('count',(current_setting('test.countb')::jsonb->>'count_id')::uuid,(current_setting('test.catalog2')::jsonb->>'item_id')::uuid));
create function pg_temp.bookb() returns jsonb language sql as $$select public.get_feed_ledger_review('c2000000-0000-4000-8000-000000000001',(current_setting('test.countb')::jsonb->>'opening_id')::uuid,'2026-10-27T17:00:00Z');$$;
create function pg_temp.commandb(activation boolean default false) returns jsonb language sql as $$select jsonb_build_object('format',case when activation then 'tamago.feed-inventory-activation' else 'tamago.feed-inventory-posting' end,'schema_version',1,'action_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','through_at','2026-10-27T17:00:00.000Z','review_token',pg_temp.bookb()->>'review_token','reason','SYN-Otra cuenta')||case when activation then jsonb_build_object('opening_id',current_setting('test.countb')::jsonb->>'opening_id') else jsonb_build_object('account_id',pg_temp.bookb()->'account'->>'account_id','expected_revision',(pg_temp.bookb()->>'revision')::integer) end;$$;
select is(public.apply_feed_ledger(pg_temp.commandb(true))->>'balance_bags','0','zero count creates explicit zero book');
select public.correct_feed_inventory(jsonb_build_object('format','tamago.feed-inventory-correction','schema_version',1,'revision_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','target_kind','binding','target_id',(select binding_id from public.feed_fact_bindings where source_kind='delivery' and source_id=(current_setting('test.receipt')::jsonb->>'event_id')::uuid),'expected_revision',0,'previous_revision_id',null,'product_id',current_setting('test.catalog2')::jsonb->>'item_id','location_id',current_setting('test.location'),'reason','SYN-Reclasificación explícita'));
select is(pg_temp.bookb()->>'status','other_account_pending','same source cannot credit two books');
select throws_ok($$select public.apply_feed_ledger(pg_temp.commandb())$$,'23514','ledger application pending review','target credit waits for origin compensation');
select is(public.apply_feed_ledger(pg_temp.command())->>'balance_bags','8.75','origin records -2 compensation');
select is(public.apply_feed_ledger(pg_temp.commandb())->>'balance_bags','2','target credits only after origin is compensated');
select is((select sum(delta)::text from public.feed_ledger_entries),'10.75','cross-account reclassification preserves total inventory');
select public.correct_feed_inventory(jsonb_build_object('format','tamago.feed-inventory-correction','schema_version',1,'revision_id',gen_random_uuid(),'company_id','c2000000-0000-4000-8000-000000000001','target_kind','binding','target_id',current_setting('test.mapcount')::jsonb->>'binding_id','expected_revision',0,'previous_revision_id',null,'product_id',current_setting('test.catalog2')::jsonb->>'item_id','location_id',current_setting('test.location'),'reason','SYN-Identidad de conteo corregida'));
select is(pg_temp.book()->>'status','opening_changed','count binding correction freezes book rather than moving its opening');
select is(pg_temp.book()->>'available_bags',null::text,'changed opening never claims available stock');
select throws_ok($$select public.apply_feed_ledger(pg_temp.command())$$,'23514','ledger application pending review','opening review/replacement remains outside this cut');
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is(pg_temp.book(),null::jsonb,'foreign company has no book review');
select is((select count(*)::int from public.feed_ledger_entries),0,'foreign raw ledger hidden');
select throws_ok($$select public.apply_feed_ledger(current_setting('test.activation')::jsonb)$$,'42501','ledger forbidden','foreign cannot replay activation');
reset role;select * from finish();rollback;
