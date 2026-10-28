
-- Typed foreign keys retain referenced source facts; payloads remain unchanged.
alter table public.feed_supply_events add constraint feed_supply_company_event_key unique(company_id,event_id);
alter table public.feed_delivery_events add constraint feed_delivery_company_event_key unique(company_id,event_id);
alter table public.feed_opening_counts add constraint feed_count_company_count_key unique(company_id,count_id);
alter table public.feed_fact_bindings add column supply_id uuid,add column delivery_id uuid,add column count_id uuid;
update public.feed_fact_bindings set supply_id=case when source_kind='supply' then source_id end,delivery_id=case when source_kind='delivery' then source_id end,count_id=case when source_kind='count' then source_id end;
alter table public.feed_fact_bindings add constraint feed_binding_typed_source check(
 (source_kind='supply' and supply_id is not distinct from source_id and delivery_id is null and count_id is null)
 or(source_kind='delivery' and delivery_id is not distinct from source_id and supply_id is null and count_id is null)
 or(source_kind='count' and count_id is not distinct from source_id and supply_id is null and delivery_id is null));
alter table public.feed_fact_bindings add foreign key(company_id,supply_id) references public.feed_supply_events(company_id,event_id) on delete restrict;
alter table public.feed_fact_bindings add foreign key(company_id,delivery_id) references public.feed_delivery_events(company_id,event_id) on delete restrict;
alter table public.feed_fact_bindings add foreign key(company_id,count_id) references public.feed_opening_counts(company_id,count_id) on delete restrict;
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
