-- Declared supply facts only: no inventory opening, receipt, conversion or ingestion.
create table public.feed_supply_events (
 event_id uuid primary key,
 company_id uuid not null,site_id uuid not null,house_id uuid not null,lot_id uuid not null,
 business_date date not null,occurred_at timestamptz not null,
 product_declared text not null check(length(trim(product_declared)) between 1 and 200),
 quantity text not null check(length(quantity)<=100 and quantity ~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'),
 unit text not null check(unit in ('BAG_40KG')),
 source_declared text check(source_declared is null or length(trim(source_declared)) between 1 and 200),
 physical_batch_declared text check(physical_batch_declared is null or length(trim(physical_batch_declared)) between 1 and 200),
 notes text check(notes is null or length(notes)<=2000),
 recorded_by uuid not null references auth.users(id) on delete restrict,
 recorded_at timestamptz not null default statement_timestamp(),
 event_payload jsonb not null,
 foreign key(company_id,site_id,house_id,lot_id) references public.lots(company_id,site_id,house_id,id) on delete restrict,
 check((occurred_at at time zone 'America/Bogota')::date=business_date)
);
create index feed_supply_origin_idx on public.feed_supply_events(company_id,business_date,lot_id,recorded_at,event_id);
alter table public.feed_supply_events enable row level security;
alter table public.feed_supply_events force row level security;
create policy feed_supply_read_scope on public.feed_supply_events for select to authenticated using (
 private.has_lot_role(company_id,site_id,house_id,lot_id,'capture') or private.has_lot_role(company_id,site_id,house_id,lot_id,'director'));
revoke all on public.feed_supply_events from public,anon,authenticated;
grant select on public.feed_supply_events to authenticated;

create function private.feed_supply_receipt(p_event public.feed_supply_events,p_duplicate boolean)
returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('format','tamago.feed-supply-receipt','schema_version',1,'event',p_event.event_payload,'recorded_by',p_event.recorded_by,'recorded_at',p_event.recorded_at,'inventory_check','not_evaluated','duplicate',p_duplicate);
$$;
revoke all on function private.feed_supply_receipt(public.feed_supply_events,boolean) from public,anon,authenticated;

create function public.record_feed_supply(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); company_value uuid;site_value uuid;house_value uuid;lot_value uuid;id_value uuid;date_value date;time_value timestamptz;item jsonb;existing public.feed_supply_events%rowtype;inserted public.feed_supply_events%rowtype;
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='feed supply forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid feed supply';end if;
 if octet_length(p_event::text)>8192 or (p_event-array['schema_version','event_id','company_id','site_id','house_id','lot_id','business_date','occurred_at','product_declared','quantity','unit','source_declared','physical_batch_declared','notes'])<>'{}'::jsonb
 or not(p_event ?& array['schema_version','event_id','company_id','site_id','house_id','lot_id','business_date','occurred_at','product_declared','quantity','unit','source_declared','physical_batch_declared','notes'])
 or p_event->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='invalid feed supply';end if;
 for item in select value from jsonb_each(p_event) where key in ('event_id','company_id','site_id','house_id','lot_id') loop
 if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid feed supply';end if;end loop;
 if jsonb_typeof(p_event->'quantity') is distinct from 'string' or length(p_event->>'quantity')>100 or (p_event->>'quantity') !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
 or jsonb_typeof(p_event->'unit') is distinct from 'string' or p_event->>'unit' not in ('BAG_40KG')
 or jsonb_typeof(p_event->'product_declared') is distinct from 'string' or length(trim(p_event->>'product_declared'))<1 or length(p_event->>'product_declared')>200
 or jsonb_typeof(p_event->'business_date') is distinct from 'string' or (p_event->>'business_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 or jsonb_typeof(p_event->'occurred_at') is distinct from 'string' or (p_event->>'occurred_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 then raise exception using errcode='22023',message='invalid feed supply';end if;
 for item in select value from jsonb_each(p_event) where key in ('source_declared','physical_batch_declared') loop
 if jsonb_typeof(item) not in ('string','null') or (jsonb_typeof(item)='string' and (length(trim(item#>>'{}'))<1 or length(item#>>'{}')>200)) then raise exception using errcode='22023',message='invalid feed supply';end if;end loop;
 if jsonb_typeof(p_event->'notes') not in ('string','null') or length(p_event->>'notes')>2000 then raise exception using errcode='22023',message='invalid feed supply';end if;
 begin
 company_value:=(p_event->>'company_id')::uuid;site_value:=(p_event->>'site_id')::uuid;house_value:=(p_event->>'house_id')::uuid;lot_value:=(p_event->>'lot_id')::uuid;id_value:=(p_event->>'event_id')::uuid;date_value:=(p_event->>'business_date')::date;time_value:=(p_event->>'occurred_at')::timestamptz;
 exception when others then raise exception using errcode='22023',message='invalid feed supply';end;
 if date_value::text<>p_event->>'business_date' or to_char(time_value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_event->>'occurred_at' or (time_value at time zone 'America/Bogota')::date<>date_value then raise exception using errcode='22023',message='invalid feed supply';end if;
 if not private.has_lot_role(company_value,site_value,house_value,lot_value,'capture') then raise exception using errcode='42501',message='feed supply forbidden';end if;
 -- Stable identity lock serializes duplicate attempts, including lost replies.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-supply:'||id_value::text,0));
 select * into existing from public.feed_supply_events where event_id=id_value;
 if found then
 if existing.company_id<>company_value or existing.recorded_by<>actor or existing.event_payload<>p_event then raise exception using errcode='23505',message='feed supply id content conflict';end if;
 return private.feed_supply_receipt(existing,true);end if;
 if not exists(select 1 from public.lots where company_id=company_value and site_id=site_value and house_id=house_value and id=lot_value and status='active') then raise exception using errcode='42501',message='feed supply forbidden';end if;
 insert into public.feed_supply_events(event_id,company_id,site_id,house_id,lot_id,business_date,occurred_at,product_declared,quantity,unit,source_declared,physical_batch_declared,notes,recorded_by,event_payload)
 values(id_value,company_value,site_value,house_value,lot_value,date_value,time_value,p_event->>'product_declared',p_event->>'quantity',p_event->>'unit',p_event->>'source_declared',p_event->>'physical_batch_declared',p_event->>'notes',actor,p_event) returning * into inserted;
 return private.feed_supply_receipt(inserted,false);
end;$$;
revoke all on function public.record_feed_supply(jsonb) from public,anon,service_role;
grant execute on function public.record_feed_supply(jsonb) to authenticated;
comment on table public.feed_supply_events is 'Immutable declared supply; BAG_40KG is the explicitly confirmed 40 kg bag. No inventory approval or biological consumption.';
