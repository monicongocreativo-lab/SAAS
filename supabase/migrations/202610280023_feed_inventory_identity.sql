-- Stable identities and reviewed links; no inventory activation or destructive remapping.
create table public.feed_catalog_items (
 item_id uuid primary key,company_id uuid not null references public.companies(id) on delete restrict,
 kind text not null check(kind in('product','location')),code text not null check(code~'^[A-Z0-9][A-Z0-9_-]{0,63}$'),label text not null check(length(trim(label)) between 1 and 200),
 unit text,site_id uuid,house_id uuid,event_payload jsonb not null,recorded_by uuid not null references auth.users(id) on delete restrict,recorded_at timestamptz not null default statement_timestamp(),
 unique(company_id,item_id),unique(company_id,kind,code),
 foreign key(company_id,site_id,house_id) references public.houses(company_id,site_id,id) on delete restrict,
 check((kind='product' and unit='BAG_40KG' and site_id is null and house_id is null) or (kind='location' and unit is null and site_id is not null and house_id is not null))
);
create table public.feed_fact_bindings (
 binding_id uuid primary key,company_id uuid not null,site_id uuid not null,house_id uuid not null,lot_id uuid not null,
 source_kind text not null check(source_kind in('supply','delivery','count')),source_id uuid not null,
 product_id uuid not null,location_id uuid not null,source_snapshot jsonb not null,event_payload jsonb not null,
 recorded_by uuid not null references auth.users(id) on delete restrict,recorded_at timestamptz not null default statement_timestamp(),
 unique(company_id,source_kind,source_id),
 foreign key(company_id,site_id,house_id,lot_id) references public.lots(company_id,site_id,house_id,id) on delete restrict,
 foreign key(company_id,product_id) references public.feed_catalog_items(company_id,item_id) on delete restrict,
 foreign key(company_id,location_id) references public.feed_catalog_items(company_id,item_id) on delete restrict
);
create table public.feed_cutoff_decisions (
 action_id uuid primary key,company_id uuid not null,opening_id uuid not null,count_id uuid not null,revision integer not null,
 source_kind text not null check(source_kind in('supply','delivery')),source_id uuid not null,classification text not null check(classification in('included_in_count','after_count')),
 event_payload jsonb not null,recorded_by uuid not null references auth.users(id) on delete restrict,recorded_at timestamptz not null default statement_timestamp(),
 unique(opening_id,source_kind,source_id),
 foreign key(opening_id,company_id,count_id,revision) references public.feed_opening_counts(opening_id,company_id,count_id,revision) on delete restrict,
 foreign key(company_id,source_kind,source_id) references public.feed_fact_bindings(company_id,source_kind,source_id) on delete restrict
);
alter table public.feed_catalog_items enable row level security;alter table public.feed_catalog_items force row level security;
alter table public.feed_fact_bindings enable row level security;alter table public.feed_fact_bindings force row level security;
alter table public.feed_cutoff_decisions enable row level security;alter table public.feed_cutoff_decisions force row level security;
create policy feed_catalog_read on public.feed_catalog_items for select to authenticated using(exists(select 1 from public.lots l where l.company_id=feed_catalog_items.company_id and (feed_catalog_items.kind='product' or (l.site_id=feed_catalog_items.site_id and l.house_id=feed_catalog_items.house_id)) and (private.has_lot_role(l.company_id,l.site_id,l.house_id,l.id,'capture') or private.has_lot_role(l.company_id,l.site_id,l.house_id,l.id,'director'))));
create policy feed_bindings_read on public.feed_fact_bindings for select to authenticated using(private.has_lot_role(company_id,site_id,house_id,lot_id,'capture') or private.has_lot_role(company_id,site_id,house_id,lot_id,'director'));
create policy feed_cutoff_read on public.feed_cutoff_decisions for select to authenticated using(exists(select 1 from public.feed_openings o where o.company_id=feed_cutoff_decisions.company_id and o.opening_id=feed_cutoff_decisions.opening_id));
revoke all on public.feed_catalog_items,public.feed_fact_bindings,public.feed_cutoff_decisions from public,anon,authenticated;
grant select on public.feed_catalog_items,public.feed_fact_bindings,public.feed_cutoff_decisions to authenticated;

create function private.feed_inventory_ack(e jsonb,a uuid,t timestamptz,d boolean) returns jsonb language sql immutable set search_path='' as $$select jsonb_build_object('format','tamago.feed-inventory-command-receipt','schema_version',1,'event',e,'actor_id',a,'recorded_at',t,'inventory_check','not_applied','duplicate',d);$$;
revoke all on function private.feed_inventory_ack(jsonb,uuid,timestamptz,boolean) from public,anon,authenticated;

-- Private normalized source reader; original records remain unchanged.
create function private.feed_fact(c uuid,k text,i uuid) returns jsonb language plpgsql set search_path='' as $$
declare result jsonb;
begin
 if k='supply' then select to_jsonb(s) into result from public.feed_supply_events s where s.company_id=c and s.event_id=i;
 elsif k='delivery' then select to_jsonb(s) into result from public.feed_delivery_events s where s.company_id=c and s.event_id=i;
 elsif k='count' then select c2.event_payload||jsonb_build_object('event_id',c2.count_id,'occurred_at',c2.event_payload->>'cutoff_at','event_payload',c2.event_payload) into result from public.feed_opening_counts c2 where c2.company_id=c and c2.count_id=i;end if;
 return result;
end;$$;
revoke all on function private.feed_fact(uuid,text,uuid) from public,anon,authenticated;

create function public.record_feed_catalog_item(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());item public.feed_catalog_items%rowtype;c uuid;s uuid;h uuid;l uuid;i uuid;v jsonb;
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='inventory forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid inventory command';end if;
 if octet_length(p_event::text)>8192 or (p_event-array['format','schema_version','item_id','company_id','site_id','house_id','lot_id','kind','code','label','unit','reason'])<>'{}'::jsonb or not(p_event ?& array['format','schema_version','item_id','company_id','site_id','house_id','lot_id','kind','code','label','unit','reason']) or p_event->'format' is distinct from '"tamago.feed-catalog-item"'::jsonb or p_event->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='invalid inventory command';end if;
 for v in select value from jsonb_each(p_event) where key in('item_id','company_id','site_id','house_id','lot_id') loop
 if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid inventory command';end if;end loop;
 if jsonb_typeof(p_event->'kind') is distinct from 'string' or p_event->>'kind' not in('product','location') or jsonb_typeof(p_event->'code') is distinct from 'string' or (p_event->>'code') !~ '^[A-Z0-9][A-Z0-9_-]{0,63}$' or jsonb_typeof(p_event->'label') is distinct from 'string' or length(trim(p_event->>'label'))<1 or length(p_event->>'label')>200 or jsonb_typeof(p_event->'reason') is distinct from 'string' or length(trim(p_event->>'reason'))<1 or length(p_event->>'reason')>2000 or (p_event->>'kind'='product' and p_event->'unit' is distinct from '"BAG_40KG"'::jsonb) or (p_event->>'kind'='location' and p_event->'unit' is distinct from 'null'::jsonb) then raise exception using errcode='22023',message='invalid inventory command';end if;
 c:=(p_event->>'company_id')::uuid;s:=(p_event->>'site_id')::uuid;h:=(p_event->>'house_id')::uuid;l:=(p_event->>'lot_id')::uuid;i:=(p_event->>'item_id')::uuid;
 if not private.has_lot_role(c,s,h,l,'director') or not exists(select 1 from public.lots where company_id=c and site_id=s and house_id=h and id=l) then raise exception using errcode='42501',message='inventory forbidden';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-catalog:'||i::text,0));
 select * into item from public.feed_catalog_items where item_id=i;
 if found then if item.event_payload<>p_event or item.recorded_by<>actor then raise exception using errcode='23505',message='inventory id content conflict';end if;return private.feed_inventory_ack(item.event_payload,item.recorded_by,item.recorded_at,true);end if;
 insert into public.feed_catalog_items(item_id,company_id,kind,code,label,unit,site_id,house_id,event_payload,recorded_by)
 values(i,c,p_event->>'kind',p_event->>'code',p_event->>'label',p_event->>'unit',case when p_event->>'kind'='location' then s else null end,case when p_event->>'kind'='location' then h else null end,p_event,actor) returning * into item;
 return private.feed_inventory_ack(item.event_payload,item.recorded_by,item.recorded_at,false);
end;$$;
revoke all on function public.record_feed_catalog_item(jsonb) from public,anon,service_role;
grant execute on function public.record_feed_catalog_item(jsonb) to authenticated;

-- Safe catalog projection does not disclose another lot's creation/audit payload.
revoke select on public.feed_catalog_items from authenticated;
grant select(item_id,company_id,kind,code,label,unit,site_id,house_id,recorded_by,recorded_at) on public.feed_catalog_items to authenticated;

create function public.bind_feed_fact(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());c uuid;i uuid;p uuid;loc uuid;src uuid;k text;fact jsonb;v jsonb;row_value public.feed_fact_bindings%rowtype;
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='inventory forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid inventory command';end if;
 if octet_length(p_event::text)>8192 or (p_event-array['format','schema_version','binding_id','company_id','source_kind','source_id','product_id','location_id','reason'])<>'{}'::jsonb or not(p_event ?& array['format','schema_version','binding_id','company_id','source_kind','source_id','product_id','location_id','reason']) or p_event->'format' is distinct from '"tamago.feed-fact-binding"'::jsonb or p_event->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='invalid inventory command';end if;
 for v in select value from jsonb_each(p_event) where key in('binding_id','company_id','source_id','product_id','location_id') loop
 if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid inventory command';end if;end loop;
 if jsonb_typeof(p_event->'source_kind') is distinct from 'string' or p_event->>'source_kind' not in('supply','delivery','count') or jsonb_typeof(p_event->'reason') is distinct from 'string' or length(trim(p_event->>'reason'))<1 or length(p_event->>'reason')>2000 then raise exception using errcode='22023',message='invalid inventory command';end if;
 c:=(p_event->>'company_id')::uuid;i:=(p_event->>'binding_id')::uuid;src:=(p_event->>'source_id')::uuid;p:=(p_event->>'product_id')::uuid;loc:=(p_event->>'location_id')::uuid;k:=p_event->>'source_kind';
 fact:=private.feed_fact(c,k,src);
 if fact is null or not private.has_lot_role(c,(fact->>'site_id')::uuid,(fact->>'house_id')::uuid,(fact->>'lot_id')::uuid,'director') then raise exception using errcode='42501',message='inventory forbidden';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-binding:'||c::text||k||src::text,0));
 select * into row_value from public.feed_fact_bindings where binding_id=i;
 if found then if row_value.event_payload<>p_event or row_value.recorded_by<>actor then raise exception using errcode='23505',message='inventory id content conflict';end if;return private.feed_inventory_ack(row_value.event_payload,row_value.recorded_by,row_value.recorded_at,true);end if;
 if not exists(select 1 from public.feed_catalog_items where company_id=c and item_id=p and kind='product' and unit=fact->>'unit') or not exists(select 1 from public.feed_catalog_items where company_id=c and item_id=loc and kind='location' and site_id=(fact->>'site_id')::uuid and house_id=(fact->>'house_id')::uuid) then raise exception using errcode='23514',message='inventory catalog scope conflict';end if;
 insert into public.feed_fact_bindings(binding_id,company_id,site_id,house_id,lot_id,source_kind,source_id,product_id,location_id,source_snapshot,event_payload,recorded_by)
 values(i,c,(fact->>'site_id')::uuid,(fact->>'house_id')::uuid,(fact->>'lot_id')::uuid,k,src,p,loc,fact,p_event,actor) returning * into row_value;
 return private.feed_inventory_ack(row_value.event_payload,row_value.recorded_by,row_value.recorded_at,false);
end;$$;
revoke all on function public.bind_feed_fact(jsonb) from public,anon,service_role;
grant execute on function public.bind_feed_fact(jsonb) to authenticated;

create function public.record_feed_cutoff_decision(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());c uuid;i uuid;src uuid;op uuid;ct uuid;k text;v jsonb;head record;fact jsonb;opening_map public.feed_fact_bindings%rowtype;movement_map public.feed_fact_bindings%rowtype;row_value public.feed_cutoff_decisions%rowtype;
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='inventory forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid inventory command';end if;
 if octet_length(p_event::text)>8192 or (p_event-array['format','schema_version','action_id','company_id','opening_id','count_id','source_kind','source_id','classification','reason'])<>'{}'::jsonb or not(p_event ?& array['format','schema_version','action_id','company_id','opening_id','count_id','source_kind','source_id','classification','reason']) or p_event->'format' is distinct from '"tamago.feed-cutoff-decision"'::jsonb or p_event->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='invalid inventory command';end if;
 for v in select value from jsonb_each(p_event) where key in('action_id','company_id','opening_id','count_id','source_id') loop
 if jsonb_typeof(v) is distinct from 'string' or (v#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid inventory command';end if;end loop;
 if jsonb_typeof(p_event->'source_kind') is distinct from 'string' or p_event->>'source_kind' not in('supply','delivery') or jsonb_typeof(p_event->'classification') is distinct from 'string' or p_event->>'classification' not in('included_in_count','after_count') or jsonb_typeof(p_event->'reason') is distinct from 'string' or length(trim(p_event->>'reason'))<1 or length(p_event->>'reason')>2000 then raise exception using errcode='22023',message='invalid inventory command';end if;
 c:=(p_event->>'company_id')::uuid;i:=(p_event->>'action_id')::uuid;op:=(p_event->>'opening_id')::uuid;ct:=(p_event->>'count_id')::uuid;src:=(p_event->>'source_id')::uuid;k:=p_event->>'source_kind';
 select o.*,a.count_id,a.revision,q.event_payload into head from public.feed_openings o join public.feed_opening_approvals a using(opening_id,company_id) join public.feed_opening_counts q on q.count_id=a.count_id and q.opening_id=a.opening_id and q.company_id=a.company_id where o.company_id=c and o.opening_id=op and o.status='approved';
 if not found then raise exception using errcode='42501',message='inventory forbidden';end if;
 if not private.has_lot_role(c,head.site_id,head.house_id,head.lot_id,'director') then raise exception using errcode='42501',message='inventory forbidden';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-cutoff:'||op::text||k||src::text,0));
 select * into row_value from public.feed_cutoff_decisions where action_id=i;
 if found then if row_value.event_payload<>p_event or row_value.recorded_by<>actor then raise exception using errcode='23505',message='inventory id content conflict';end if;return private.feed_inventory_ack(row_value.event_payload,row_value.recorded_by,row_value.recorded_at,true);end if;
 if head.count_id<>ct then raise exception using errcode='23514',message='inventory approved count conflict';end if;
 select * into opening_map from public.feed_fact_bindings where company_id=c and source_kind='count' and source_id=ct;
 if not found then raise exception using errcode='23514',message='inventory opening not linked';end if;
 select * into movement_map from public.feed_fact_bindings where company_id=c and source_kind=k and source_id=src;
 if not found then raise exception using errcode='23514',message='inventory movement not linked';end if;
 fact:=private.feed_fact(c,k,src);
 if fact is null or movement_map.site_id<>head.site_id or movement_map.house_id<>head.house_id or movement_map.lot_id<>head.lot_id or movement_map.product_id<>opening_map.product_id or movement_map.location_id<>opening_map.location_id or (fact->>'occurred_at')::timestamptz<>(head.event_payload->>'cutoff_at')::timestamptz then raise exception using errcode='23514',message='inventory cutoff scope conflict';end if;
 insert into public.feed_cutoff_decisions(action_id,company_id,opening_id,count_id,revision,source_kind,source_id,classification,event_payload,recorded_by) values(i,c,op,ct,head.revision,k,src,p_event->>'classification',p_event,actor) returning * into row_value;
 return private.feed_inventory_ack(row_value.event_payload,row_value.recorded_by,row_value.recorded_at,false);
end;$$;
revoke all on function public.record_feed_cutoff_decision(jsonb) from public,anon,service_role;
grant execute on function public.record_feed_cutoff_decision(jsonb) to authenticated;

create function public.list_feed_catalog(p_company_id uuid,p_lot_id uuid,p_offset integer default 0) returns jsonb language plpgsql security invoker set search_path='' as $$
declare lot public.lots%rowtype;rows_value jsonb;
begin
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='invalid inventory page';end if;
 select * into lot from public.lots where company_id=p_company_id and id=p_lot_id;
 if not found then raise exception using errcode='42501',message='inventory forbidden';end if;
 if not private.has_lot_role(p_company_id,lot.site_id,lot.house_id,lot.id,'capture') and not private.has_lot_role(p_company_id,lot.site_id,lot.house_id,lot.id,'director') then raise exception using errcode='42501',message='inventory forbidden';end if;
 select coalesce(jsonb_agg(to_jsonb(i) order by i.item_id),'[]'::jsonb) into rows_value from(select item_id,company_id,kind,code,label,unit,site_id,house_id,recorded_by,recorded_at from public.feed_catalog_items where company_id=p_company_id and(kind='product' or(site_id=lot.site_id and house_id=lot.house_id)) order by item_id limit 26 offset p_offset)i;
 return jsonb_build_object('format','tamago.feed-catalog','schema_version',1,'company_id',p_company_id,'lot_id',p_lot_id,'items',coalesce((select jsonb_agg(value order by ordinality) from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end);
end;$$;
revoke all on function public.list_feed_catalog(uuid,uuid,integer) from public,anon,service_role;
grant execute on function public.list_feed_catalog(uuid,uuid,integer) to authenticated;

create function public.get_feed_fact_binding(p_company_id uuid,p_source_kind text,p_source_id uuid) returns jsonb language sql security invoker set search_path='' as $$
 select to_jsonb(b) from public.feed_fact_bindings b where b.company_id=p_company_id and b.source_kind=p_source_kind and b.source_id=p_source_id;
$$;
revoke all on function public.get_feed_fact_binding(uuid,text,uuid) from public,anon,service_role;
grant execute on function public.get_feed_fact_binding(uuid,text,uuid) to authenticated;

create function public.get_feed_balance_preview(p_company_id uuid,p_opening_id uuid,p_through_at timestamptz default statement_timestamp()) returns jsonb language plpgsql security invoker set search_path='' as $$
declare root record;mapping public.feed_fact_bindings%rowtype;result jsonb;base jsonb;cutoff timestamptz;opening_quantity numeric;
begin
 if p_through_at is null or not pg_catalog.isfinite(p_through_at) then raise exception using errcode='22023',message='invalid inventory window';end if;
 base:=jsonb_build_object('format','tamago.feed-balance-preview','schema_version',1,'company_id',p_company_id,'opening_id',p_opening_id,'purpose','reconciliation_preview','inventory_check','not_applied','coverage','server_records_only','through_at',p_through_at,
 'status','blocked','reason',null,'product_id',null,'location_id',null,'count_id',null,'cutoff_at',null,'opening_bags',null,'known_receipts_bags',null,'known_supplied_bags',null,'diagnostic_balance_bags',null,'balance_bags',null,'unmapped_count',0,'pending_tie_count',0,'blockers','[]'::jsonb,'blockers_truncated',false);
 select o.*,a.count_id,q.event_payload into root from public.feed_openings o left join public.feed_opening_approvals a using(opening_id,company_id) left join public.feed_opening_counts q on q.count_id=a.count_id and q.opening_id=a.opening_id and q.company_id=a.company_id where o.company_id=p_company_id and o.opening_id=p_opening_id;
 if not found then return null;end if;
 if root.status<>'approved' or root.count_id is null then return base||jsonb_build_object('reason','opening_not_approved');end if;
 cutoff:=(root.event_payload->>'cutoff_at')::timestamptz;opening_quantity:=(root.event_payload->>'quantity')::numeric;
 base:=base||jsonb_build_object('count_id',root.count_id,'cutoff_at',cutoff,'opening_bags',pg_catalog.trim_scale(opening_quantity)::text);
 if cutoff>p_through_at then return base||jsonb_build_object('reason','cutoff_after_through');end if;
 select * into mapping from public.feed_fact_bindings where company_id=p_company_id and source_kind='count' and source_id=root.count_id;
 if not found then return base||jsonb_build_object('reason','opening_not_linked');end if;
 base:=base||jsonb_build_object('product_id',mapping.product_id,'location_id',mapping.location_id);
 with movements as (
  select 'delivery'::text as kind,d.event_id as id,d.occurred_at,d.quantity::numeric as quantity from public.feed_delivery_events d where d.company_id=p_company_id and d.site_id=root.site_id and d.house_id=root.house_id and d.lot_id=root.lot_id and d.occurred_at<=p_through_at
  union all
  select 'supply'::text,s.event_id,s.occurred_at,s.quantity::numeric from public.feed_supply_events s where s.company_id=p_company_id and s.site_id=root.site_id and s.house_id=root.house_id and s.lot_id=root.lot_id and s.occurred_at<=p_through_at
 ), marked as (
  select m.*,b.binding_id is null and m.occurred_at>=cutoff as unmapped,
   coalesce(b.product_id=mapping.product_id and b.location_id=mapping.location_id,false) and m.occurred_at=cutoff and d.action_id is null as pending_tie,
   coalesce(b.product_id=mapping.product_id and b.location_id=mapping.location_id,false) and (m.occurred_at>cutoff or(m.occurred_at=cutoff and d.classification='after_count')) as eligible
  from movements m left join public.feed_fact_bindings b on b.company_id=p_company_id and b.source_kind=m.kind and b.source_id=m.id
  left join public.feed_cutoff_decisions d on d.company_id=p_company_id and d.opening_id=p_opening_id and d.source_kind=m.kind and d.source_id=m.id
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
 'blockers',coalesce((select jsonb_agg(jsonb_build_object('source_kind',kind,'source_id',id,'problem',case when unmapped then 'unmapped' else 'cutoff_tie' end) order by kind,id) from(select * from marked where unmapped or pending_tie order by kind,id limit 25)x),'[]'::jsonb),
 'blockers_truncated',unmapped_count+pending_tie_count>25) into result from evaluated;
 return result;
end;$$;
revoke all on function public.get_feed_balance_preview(uuid,uuid,timestamptz) from public,anon,service_role;
grant execute on function public.get_feed_balance_preview(uuid,uuid,timestamptz) to authenticated;
