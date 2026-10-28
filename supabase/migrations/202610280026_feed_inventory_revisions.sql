-- Append-only corrections. Source facts and original decisions are never rewritten.
alter table public.feed_fact_bindings add constraint feed_binding_company_id_key unique(company_id,binding_id);
alter table public.feed_cutoff_decisions add constraint feed_cutoff_company_id_key unique(company_id,action_id);
alter table public.feed_cutoff_decisions add column opening_binding_revision integer not null default 0 check(opening_binding_revision>=0),add column movement_binding_revision integer not null default 0 check(movement_binding_revision>=0);
create table public.feed_inventory_revisions (
 revision_id uuid primary key, company_id uuid not null references public.companies(id) on delete restrict,
 target_kind text not null check(target_kind in('binding','cutoff')),target_id uuid not null,
 version integer not null check(version>0),previous_revision_id uuid,
 binding_id uuid,cutoff_id uuid,product_id uuid,location_id uuid,classification text,
 opening_binding_revision integer,movement_binding_revision integer,
 event_payload jsonb not null,recorded_by uuid not null references auth.users(id) on delete restrict,recorded_at timestamptz not null default statement_timestamp(),
 unique(company_id,target_kind,target_id,version),unique(company_id,revision_id),
 foreign key(company_id,previous_revision_id) references public.feed_inventory_revisions(company_id,revision_id) on delete restrict,
 foreign key(company_id,binding_id) references public.feed_fact_bindings(company_id,binding_id) on delete restrict,
 foreign key(company_id,cutoff_id) references public.feed_cutoff_decisions(company_id,action_id) on delete restrict,
 foreign key(company_id,product_id) references public.feed_catalog_items(company_id,item_id) on delete restrict,
 foreign key(company_id,location_id) references public.feed_catalog_items(company_id,item_id) on delete restrict,
 check((version=1 and previous_revision_id is null) or(version>1 and previous_revision_id is not null)),
 check((target_kind='binding' and binding_id is not distinct from target_id and cutoff_id is null and product_id is not null and location_id is not null and classification is null and opening_binding_revision is null and movement_binding_revision is null)
 or(target_kind='cutoff' and cutoff_id is not distinct from target_id and binding_id is null and product_id is null and location_id is null and classification in('included_in_count','after_count') and opening_binding_revision is not null and opening_binding_revision>=0 and movement_binding_revision is not null and movement_binding_revision>=0))
);
alter table public.feed_inventory_revisions enable row level security;
alter table public.feed_inventory_revisions force row level security;
create policy feed_revision_read on public.feed_inventory_revisions for select to authenticated using(
 (target_kind='binding' and exists(select 1 from public.feed_fact_bindings b where b.company_id=feed_inventory_revisions.company_id and b.binding_id=feed_inventory_revisions.target_id))
 or(target_kind='cutoff' and exists(select 1 from public.feed_cutoff_decisions d where d.company_id=feed_inventory_revisions.company_id and d.action_id=feed_inventory_revisions.target_id)));
revoke all on public.feed_inventory_revisions from public,anon,authenticated;
grant select on public.feed_inventory_revisions to authenticated;

create view public.feed_effective_bindings with(security_invoker=true) as
 select b.binding_id,b.company_id,b.site_id,b.house_id,b.lot_id,b.source_kind,b.source_id,
 coalesce(r.product_id,b.product_id) as product_id,coalesce(r.location_id,b.location_id) as location_id,
 b.source_snapshot,b.event_payload,b.recorded_by,b.recorded_at,
 coalesce(r.version,0) as correction_revision,r.revision_id as current_revision_id,
 coalesce(r.event_payload,b.event_payload) as current_event,
 coalesce(r.recorded_by,b.recorded_by) as effective_actor,coalesce(r.recorded_at,b.recorded_at) as effective_recorded_at
 from public.feed_fact_bindings b left join lateral(select * from public.feed_inventory_revisions r where r.company_id=b.company_id and r.target_kind='binding' and r.target_id=b.binding_id order by r.version desc limit 1)r on true;
create view public.feed_effective_cutoffs with(security_invoker=true) as
 select d.action_id,d.company_id,d.opening_id,d.count_id,d.revision,d.source_kind,d.source_id,
 coalesce(r.classification,d.classification) as classification,
 coalesce(r.opening_binding_revision,d.opening_binding_revision) as opening_binding_revision,
 coalesce(r.movement_binding_revision,d.movement_binding_revision) as movement_binding_revision,
 coalesce(r.version,0) as correction_revision,r.revision_id as current_revision_id,
 d.event_payload,d.recorded_by,d.recorded_at,
 coalesce(r.event_payload,d.event_payload) as current_event,
 coalesce(r.recorded_by,d.recorded_by) as effective_actor,coalesce(r.recorded_at,d.recorded_at) as effective_recorded_at
 from public.feed_cutoff_decisions d left join lateral(select * from public.feed_inventory_revisions r where r.company_id=d.company_id and r.target_kind='cutoff' and r.target_id=d.action_id order by r.version desc limit 1)r on true;
revoke all on public.feed_effective_bindings,public.feed_effective_cutoffs from public,anon,authenticated;
grant select on public.feed_effective_bindings,public.feed_effective_cutoffs to authenticated;

create function public.correct_feed_inventory(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());c uuid;i uuid;target uuid;k text;v jsonb;b public.feed_effective_bindings%rowtype;d public.feed_effective_cutoffs%rowtype;o record;om public.feed_effective_bindings%rowtype;mm public.feed_effective_bindings%rowtype;existing public.feed_inventory_revisions%rowtype;last_row public.feed_inventory_revisions%rowtype;current_version integer;previous uuid;fact jsonb;allowed text[];
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='inventory forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid inventory correction';end if;
 k:=p_event->>'target_kind';
 allowed:=array['format','schema_version','revision_id','company_id','target_kind','target_id','expected_revision','previous_revision_id','reason'];
 if k='binding' then allowed:=allowed||array['product_id','location_id'];elsif k='cutoff' then allowed:=allowed||array['classification','expected_opening_binding_revision','expected_movement_binding_revision'];else raise exception using errcode='22023',message='invalid inventory correction';end if;
 if octet_length(p_event::text)>8192 or (p_event-allowed)<>'{}'::jsonb or not(p_event ?& allowed) or p_event->'format' is distinct from '"tamago.feed-inventory-correction"'::jsonb or p_event->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='invalid inventory correction';end if;
 for v in select value from jsonb_each(p_event) where key in('revision_id','company_id','target_id','product_id','location_id') loop
 if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid inventory correction';end if;end loop;
 if jsonb_typeof(p_event->'reason') is distinct from 'string' or length(trim(p_event->>'reason')) not between 1 and 2000 or jsonb_typeof(p_event->'expected_revision') is distinct from 'number' or (p_event->>'expected_revision') !~ '^(0|[1-9][0-9]{0,8})$' then raise exception using errcode='22023',message='invalid inventory correction';end if;
 if (p_event->>'expected_revision')::integer=0 then
 if p_event->'previous_revision_id' is distinct from 'null'::jsonb then raise exception using errcode='22023',message='invalid inventory correction';end if;
 elsif jsonb_typeof(p_event->'previous_revision_id') is distinct from 'string' or (p_event->>'previous_revision_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid inventory correction';end if;
 if k='cutoff' then
 if jsonb_typeof(p_event->'classification') is distinct from 'string' or p_event->>'classification' not in('included_in_count','after_count') then raise exception using errcode='22023',message='invalid inventory correction';end if;
 for v in select value from jsonb_each(p_event) where key in('expected_opening_binding_revision','expected_movement_binding_revision') loop
 if jsonb_typeof(v) is distinct from 'number' or (v#>>'{}') !~ '^(0|[1-9][0-9]{0,8})$' then raise exception using errcode='22023',message='invalid inventory correction';end if;end loop;
 end if;
 c:=(p_event->>'company_id')::uuid;i:=(p_event->>'revision_id')::uuid;target:=(p_event->>'target_id')::uuid;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-inventory-version:'||c::text,0));
 if k='binding' then
 select * into b from public.feed_effective_bindings where company_id=c and binding_id=target;
 if not found or not private.has_lot_role(c,b.site_id,b.house_id,b.lot_id,'director') then raise exception using errcode='42501',message='inventory forbidden';end if;
 else
 select * into d from public.feed_effective_cutoffs where company_id=c and action_id=target;
 if not found then raise exception using errcode='42501',message='inventory forbidden';end if;
 select h.*,a.count_id as approved_count into o from public.feed_openings h join public.feed_opening_approvals a using(opening_id,company_id) where h.company_id=c and h.opening_id=d.opening_id and h.status='approved';
 if not found or not private.has_lot_role(c,o.site_id,o.house_id,o.lot_id,'director') then raise exception using errcode='42501',message='inventory forbidden';end if;
 end if;
 select * into existing from public.feed_inventory_revisions where revision_id=i;
 if found then
 if existing.event_payload<>p_event or existing.recorded_by<>actor then raise exception using errcode='23505',message='inventory correction id content conflict';end if;
 return private.feed_inventory_ack(existing.event_payload,existing.recorded_by,existing.recorded_at,true);
 end if;
 select * into last_row from public.feed_inventory_revisions where company_id=c and target_kind=k and target_id=target order by version desc limit 1;
 current_version:=coalesce(last_row.version,0);previous:=last_row.revision_id;
 if current_version>=999999999 then raise exception using errcode='22023',message='inventory revision limit';end if;
 if current_version<>(p_event->>'expected_revision')::integer or previous is distinct from (p_event->>'previous_revision_id')::uuid then raise exception using errcode='40001',message='inventory correction stale version';end if;
 if k='binding' then
 fact:=private.feed_fact(c,b.source_kind,b.source_id);
 if not exists(select 1 from public.feed_catalog_items where company_id=c and item_id=(p_event->>'product_id')::uuid and kind='product' and unit=fact->>'unit') or not exists(select 1 from public.feed_catalog_items where company_id=c and item_id=(p_event->>'location_id')::uuid and kind='location' and site_id=b.site_id and house_id=b.house_id) then raise exception using errcode='23514',message='inventory catalog scope conflict';end if;
 if b.product_id=(p_event->>'product_id')::uuid and b.location_id=(p_event->>'location_id')::uuid then raise exception using errcode='23514',message='inventory unchanged binding';end if;
 else
 select * into om from public.feed_effective_bindings where company_id=c and source_kind='count' and source_id=d.count_id;
 if not found then raise exception using errcode='23514',message='inventory opening not linked';end if;
 select * into mm from public.feed_effective_bindings where company_id=c and source_kind=d.source_kind and source_id=d.source_id;
 if not found then raise exception using errcode='23514',message='inventory movement not linked';end if;
 fact:=private.feed_fact(c,d.source_kind,d.source_id);
 if d.count_id<>o.approved_count or mm.site_id<>o.site_id or mm.house_id<>o.house_id or mm.lot_id<>o.lot_id or mm.product_id<>om.product_id or mm.location_id<>om.location_id or (fact->>'occurred_at')::timestamptz<>(om.source_snapshot->>'occurred_at')::timestamptz then raise exception using errcode='23514',message='inventory cutoff scope conflict';end if;
 if om.correction_revision<>(p_event->>'expected_opening_binding_revision')::integer or mm.correction_revision<>(p_event->>'expected_movement_binding_revision')::integer then raise exception using errcode='40001',message='inventory correction stale binding';end if;
 if d.classification=p_event->>'classification' and d.opening_binding_revision=om.correction_revision and d.movement_binding_revision=mm.correction_revision then raise exception using errcode='23514',message='inventory unchanged decision';end if;
 end if;
 insert into public.feed_inventory_revisions(revision_id,company_id,target_kind,target_id,version,previous_revision_id,binding_id,cutoff_id,product_id,location_id,classification,opening_binding_revision,movement_binding_revision,event_payload,recorded_by)
 values(i,c,k,target,current_version+1,previous,case when k='binding' then target end,case when k='cutoff' then target end,(p_event->>'product_id')::uuid,(p_event->>'location_id')::uuid,p_event->>'classification',case when k='cutoff' then om.correction_revision end,case when k='cutoff' then mm.correction_revision end,p_event,actor) returning * into existing;
 return private.feed_inventory_ack(existing.event_payload,existing.recorded_by,existing.recorded_at,false);
end;$$;
revoke all on function public.correct_feed_inventory(jsonb) from public,anon,service_role;
grant execute on function public.correct_feed_inventory(jsonb) to authenticated;

create function public.get_feed_inventory_history(p_company_id uuid,p_target_kind text,p_target_id uuid,p_offset integer default 0) returns jsonb language plpgsql security invoker set search_path='' as $$
declare original jsonb;rows_value jsonb;head integer;
begin
 if p_offset is null or p_offset<0 or p_offset>100000 or p_target_kind not in('binding','cutoff') then raise exception using errcode='22023',message='invalid inventory history';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('feed-inventory-version:'||p_company_id::text,0));
 if p_target_kind='binding' then select to_jsonb(b) into original from public.feed_fact_bindings b where b.company_id=p_company_id and b.binding_id=p_target_id;
 else select to_jsonb(d) into original from public.feed_cutoff_decisions d where d.company_id=p_company_id and d.action_id=p_target_id;end if;
 if original is null then return null;end if;
 select coalesce(max(version),0) into head from public.feed_inventory_revisions where company_id=p_company_id and target_kind=p_target_kind and target_id=p_target_id;
 select coalesce(jsonb_agg(to_jsonb(r) order by r.version desc),'[]'::jsonb) into rows_value from(select * from public.feed_inventory_revisions where company_id=p_company_id and target_kind=p_target_kind and target_id=p_target_id order by version desc limit 26 offset p_offset)r;
 return jsonb_build_object('format','tamago.feed-inventory-history','schema_version',1,'company_id',p_company_id,'target_kind',p_target_kind,'target_id',p_target_id,'current_revision',head,'original',original,'items',coalesce((select jsonb_agg(value order by ordinality) from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end,'inventory_check','not_applied');
end;$$;
revoke all on function public.get_feed_inventory_history(uuid,text,uuid,integer) from public,anon,service_role;
grant execute on function public.get_feed_inventory_history(uuid,text,uuid,integer) to authenticated;

create or replace function public.record_feed_cutoff_decision(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());c uuid;i uuid;src uuid;op uuid;ct uuid;k text;v jsonb;head record;fact jsonb;opening_map public.feed_effective_bindings%rowtype;movement_map public.feed_effective_bindings%rowtype;row_value public.feed_cutoff_decisions%rowtype;allowed text[];
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='inventory forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid inventory command';end if;
 allowed:=array['format','schema_version','action_id','company_id','opening_id','count_id','source_kind','source_id','classification','reason'];
 if p_event ? 'expected_opening_binding_revision' or p_event ? 'expected_movement_binding_revision' then allowed:=allowed||array['expected_opening_binding_revision','expected_movement_binding_revision'];end if;
 if octet_length(p_event::text)>8192 or (p_event-allowed)<>'{}'::jsonb or not(p_event ?& allowed) or p_event->'format' is distinct from '"tamago.feed-cutoff-decision"'::jsonb or p_event->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='invalid inventory command';end if;
 for v in select value from jsonb_each(p_event) where key in('action_id','company_id','opening_id','count_id','source_id') loop
 if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid inventory command';end if;end loop;
 if jsonb_typeof(p_event->'source_kind') is distinct from 'string' or p_event->>'source_kind' not in('supply','delivery') or jsonb_typeof(p_event->'classification') is distinct from 'string' or p_event->>'classification' not in('included_in_count','after_count') or jsonb_typeof(p_event->'reason') is distinct from 'string' or length(trim(p_event->>'reason'))<1 or length(p_event->>'reason')>2000 then raise exception using errcode='22023',message='invalid inventory command';end if;
 c:=(p_event->>'company_id')::uuid;i:=(p_event->>'action_id')::uuid;op:=(p_event->>'opening_id')::uuid;ct:=(p_event->>'count_id')::uuid;src:=(p_event->>'source_id')::uuid;k:=p_event->>'source_kind';
 select o.*,a.count_id,a.revision,q.event_payload into head from public.feed_openings o join public.feed_opening_approvals a using(opening_id,company_id) join public.feed_opening_counts q on q.count_id=a.count_id and q.opening_id=a.opening_id and q.company_id=a.company_id where o.company_id=c and o.opening_id=op and o.status='approved';
 if not found then raise exception using errcode='42501',message='inventory forbidden';end if;
 if not private.has_lot_role(c,head.site_id,head.house_id,head.lot_id,'director') then raise exception using errcode='42501',message='inventory forbidden';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-inventory-version:'||c::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-cutoff:'||op::text||k||src::text,0));
 select * into row_value from public.feed_cutoff_decisions where action_id=i;
 if found then if row_value.event_payload<>p_event or row_value.recorded_by<>actor then raise exception using errcode='23505',message='inventory id content conflict';end if;return private.feed_inventory_ack(row_value.event_payload,row_value.recorded_by,row_value.recorded_at,true);end if;
 if head.count_id<>ct then raise exception using errcode='23514',message='inventory approved count conflict';end if;
 select * into opening_map from public.feed_effective_bindings where company_id=c and source_kind='count' and source_id=ct;
 if not found then raise exception using errcode='23514',message='inventory opening not linked';end if;
 select * into movement_map from public.feed_effective_bindings where company_id=c and source_kind=k and source_id=src;
 if not found then raise exception using errcode='23514',message='inventory movement not linked';end if;
 fact:=private.feed_fact(c,k,src);
 if fact is null or movement_map.site_id<>head.site_id or movement_map.house_id<>head.house_id or movement_map.lot_id<>head.lot_id or movement_map.product_id<>opening_map.product_id or movement_map.location_id<>opening_map.location_id or (fact->>'occurred_at')::timestamptz<>(head.event_payload->>'cutoff_at')::timestamptz then raise exception using errcode='23514',message='inventory cutoff scope conflict';end if;
 if p_event ? 'expected_opening_binding_revision' then
 for v in select value from jsonb_each(p_event) where key in('expected_opening_binding_revision','expected_movement_binding_revision') loop
 if jsonb_typeof(v) is distinct from 'number' or (v#>>'{}') !~ '^(0|[1-9][0-9]{0,8})$' then raise exception using errcode='22023',message='invalid inventory command';end if;end loop;
 if opening_map.correction_revision<>(p_event->>'expected_opening_binding_revision')::integer or movement_map.correction_revision<>(p_event->>'expected_movement_binding_revision')::integer then raise exception using errcode='40001',message='inventory decision stale binding';end if;
 elsif opening_map.correction_revision<>0 or movement_map.correction_revision<>0 then raise exception using errcode='23514',message='inventory reviewed binding version required';end if;
 insert into public.feed_cutoff_decisions(action_id,company_id,opening_id,count_id,revision,source_kind,source_id,classification,event_payload,recorded_by,opening_binding_revision,movement_binding_revision) values(i,c,op,ct,head.revision,k,src,p_event->>'classification',p_event,actor,opening_map.correction_revision,movement_map.correction_revision) returning * into row_value;
 return private.feed_inventory_ack(row_value.event_payload,row_value.recorded_by,row_value.recorded_at,false);
end;$$;
create or replace function public.get_feed_balance_preview(p_company_id uuid,p_opening_id uuid,p_through_at timestamptz default statement_timestamp()) returns jsonb language plpgsql security invoker set search_path='' as $$
declare root record;mapping public.feed_effective_bindings%rowtype;result jsonb;base jsonb;cutoff timestamptz;opening_quantity numeric;
begin
 if p_through_at is null or not pg_catalog.isfinite(p_through_at) then raise exception using errcode='22023',message='invalid inventory window';end if;
 perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended('feed-inventory-version:'||p_company_id::text,0));
 base:=jsonb_build_object('format','tamago.feed-balance-preview','schema_version',1,'company_id',p_company_id,'opening_id',p_opening_id,'purpose','reconciliation_preview','inventory_check','not_applied','coverage','server_records_only','through_at',p_through_at,
 'status','blocked','reason',null,'product_id',null,'location_id',null,'count_id',null,'cutoff_at',null,'opening_bags',null,'known_receipts_bags',null,'known_supplied_bags',null,'diagnostic_balance_bags',null,'balance_bags',null,'unmapped_count',0,'pending_tie_count',0,'blockers','[]'::jsonb,'blockers_truncated',false);
 select o.*,a.count_id,q.event_payload into root from public.feed_openings o left join public.feed_opening_approvals a using(opening_id,company_id) left join public.feed_opening_counts q on q.count_id=a.count_id and q.opening_id=a.opening_id and q.company_id=a.company_id where o.company_id=p_company_id and o.opening_id=p_opening_id;
 if not found then return null;end if;
 if root.status<>'approved' or root.count_id is null then return base||jsonb_build_object('reason','opening_not_approved');end if;
 cutoff:=(root.event_payload->>'cutoff_at')::timestamptz;opening_quantity:=(root.event_payload->>'quantity')::numeric;
 base:=base||jsonb_build_object('count_id',root.count_id,'cutoff_at',cutoff,'opening_bags',pg_catalog.trim_scale(opening_quantity)::text);
 if cutoff>p_through_at then return base||jsonb_build_object('reason','cutoff_after_through');end if;
 select * into mapping from public.feed_effective_bindings where company_id=p_company_id and source_kind='count' and source_id=root.count_id;
 if not found then return base||jsonb_build_object('reason','opening_not_linked');end if;
 base:=base||jsonb_build_object('product_id',mapping.product_id,'location_id',mapping.location_id);
 with movements as (
  select 'delivery'::text as kind,d.event_id as id,d.occurred_at,d.quantity::numeric as quantity from public.feed_delivery_events d where d.company_id=p_company_id and d.site_id=root.site_id and d.house_id=root.house_id and d.lot_id=root.lot_id and d.occurred_at<=p_through_at
  union all
  select 'supply'::text,s.event_id,s.occurred_at,s.quantity::numeric from public.feed_supply_events s where s.company_id=p_company_id and s.site_id=root.site_id and s.house_id=root.house_id and s.lot_id=root.lot_id and s.occurred_at<=p_through_at
 ), marked as (
  select m.*,b.binding_id is null and m.occurred_at>=cutoff as unmapped,
   d.action_id as previous_decision_id,
   coalesce(b.product_id=mapping.product_id and b.location_id=mapping.location_id,false) and m.occurred_at=cutoff and (d.action_id is null or d.opening_binding_revision is distinct from mapping.correction_revision or d.movement_binding_revision is distinct from b.correction_revision) as pending_tie,
   coalesce(b.product_id=mapping.product_id and b.location_id=mapping.location_id,false) and (m.occurred_at>cutoff or(m.occurred_at=cutoff and d.classification='after_count' and d.opening_binding_revision=mapping.correction_revision and d.movement_binding_revision=b.correction_revision)) as eligible
  from movements m left join public.feed_effective_bindings b on b.company_id=p_company_id and b.source_kind=m.kind and b.source_id=m.id
  left join public.feed_effective_cutoffs d on d.company_id=p_company_id and d.opening_id=p_opening_id and d.source_kind=m.kind and d.source_id=m.id
 ), totals as (
  select coalesce(sum(quantity) filter(where eligible and kind='delivery'),0) as receipts,
   coalesce(sum(quantity) filter(where eligible and kind='supply'),0) as supplied,
   count(*) filter(where unmapped) as unmapped_count,count(*) filter(where pending_tie) as pending_tie_count from marked
 ), evaluated as (
  select *,opening_quantity+receipts-supplied as balance from totals
 )
 select base||jsonb_build_object('status',case when unmapped_count+pending_tie_count>0 then 'blocked' when balance<0 then 'negative' else 'resolved' end,
 'known_receipts_bags',pg_catalog.trim_scale(receipts)::text,'known_supplied_bags',pg_catalog.trim_scale(supplied)::text,
 'diagnostic_balance_bags',pg_catalog.trim_scale(balance)::text,'balance_bags',case when unmapped_count+pending_tie_count=0 and balance>=0 then pg_catalog.trim_scale(balance)::text else null end,
 'unmapped_count',unmapped_count,'pending_tie_count',pending_tie_count,
 'blockers',coalesce((select jsonb_agg(jsonb_build_object('source_kind',kind,'source_id',id,'previous_decision_id',previous_decision_id,'problem',case when unmapped then 'unmapped' else 'cutoff_tie' end) order by kind,id) from(select * from marked where unmapped or pending_tie order by kind,id limit 25)x),'[]'::jsonb),
 'blockers_truncated',unmapped_count+pending_tie_count>25) into result from evaluated;
 return result;
end;$$;
create or replace function public.get_feed_fact_binding(p_company_id uuid,p_source_kind text,p_source_id uuid) returns jsonb language sql security invoker set search_path='' as $$
 select to_jsonb(b) from public.feed_effective_bindings b where b.company_id=p_company_id and b.source_kind=p_source_kind and b.source_id=p_source_id;
$$;
create or replace function public.bind_feed_fact(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());c uuid;i uuid;p uuid;loc uuid;src uuid;k text;fact jsonb;v jsonb;row_value public.feed_fact_bindings%rowtype;
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='inventory forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid inventory command';end if;
 if octet_length(p_event::text)>8192 or (p_event-array['format','schema_version','binding_id','company_id','source_kind','source_id','product_id','location_id','reason'])<>'{}'::jsonb or not(p_event ?& array['format','schema_version','binding_id','company_id','source_kind','source_id','product_id','location_id','reason']) or p_event->'format' is distinct from '"tamago.feed-fact-binding"'::jsonb or p_event->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='invalid inventory command';end if;
 for v in select value from jsonb_each(p_event) where key in('binding_id','company_id','source_id','product_id','location_id') loop
 if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid inventory command';end if;end loop;
 if jsonb_typeof(p_event->'source_kind') is distinct from 'string' or p_event->>'source_kind' not in('supply','delivery','count') or jsonb_typeof(p_event->'reason') is distinct from 'string' or length(trim(p_event->>'reason'))<1 or length(p_event->>'reason')>2000 then raise exception using errcode='22023',message='invalid inventory command';end if;
 c:=(p_event->>'company_id')::uuid;i:=(p_event->>'binding_id')::uuid;src:=(p_event->>'source_id')::uuid;p:=(p_event->>'product_id')::uuid;loc:=(p_event->>'location_id')::uuid;k:=p_event->>'source_kind';
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-inventory-version:'||c::text,0));
 fact:=private.feed_fact(c,k,src);
 if fact is null or not private.has_lot_role(c,(fact->>'site_id')::uuid,(fact->>'house_id')::uuid,(fact->>'lot_id')::uuid,'director') then raise exception using errcode='42501',message='inventory forbidden';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-binding:'||c::text||k||src::text,0));
 select * into row_value from public.feed_fact_bindings where binding_id=i;
 if found then if row_value.event_payload<>p_event or row_value.recorded_by<>actor then raise exception using errcode='23505',message='inventory id content conflict';end if;return private.feed_inventory_ack(row_value.event_payload,row_value.recorded_by,row_value.recorded_at,true);end if;
 if not exists(select 1 from public.feed_catalog_items where company_id=c and item_id=p and kind='product' and unit=fact->>'unit') or not exists(select 1 from public.feed_catalog_items where company_id=c and item_id=loc and kind='location' and site_id=(fact->>'site_id')::uuid and house_id=(fact->>'house_id')::uuid) then raise exception using errcode='23514',message='inventory catalog scope conflict';end if;
 insert into public.feed_fact_bindings(binding_id,company_id,site_id,house_id,lot_id,source_kind,source_id,product_id,location_id,source_snapshot,event_payload,recorded_by,supply_id,delivery_id,count_id)
 values(i,c,(fact->>'site_id')::uuid,(fact->>'house_id')::uuid,(fact->>'lot_id')::uuid,k,src,p,loc,fact,p_event,actor,case when k='supply' then src end,case when k='delivery' then src end,case when k='count' then src end) returning * into row_value;
 return private.feed_inventory_ack(row_value.event_payload,row_value.recorded_by,row_value.recorded_at,false);
end;$$;
