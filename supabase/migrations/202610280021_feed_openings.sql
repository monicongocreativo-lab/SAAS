create table public.feed_openings (
 opening_id uuid primary key,company_id uuid not null,site_id uuid not null,house_id uuid not null,lot_id uuid not null,
 product_declared text not null,location_declared text not null,unit text not null check(unit='BAG_40KG'),
 current_revision integer not null default 0 check(current_revision>=0),status text not null default 'pending' check(status in('pending','approved')),
 unique(opening_id,company_id),foreign key(company_id,site_id,house_id,lot_id) references public.lots(company_id,site_id,house_id,id) on delete restrict
);
create table public.feed_opening_counts (
 count_id uuid primary key,opening_id uuid not null,company_id uuid not null,revision integer not null check(revision>0),
 previous_count_id uuid references public.feed_opening_counts(count_id) on delete restrict,
 event_payload jsonb not null,recorded_by uuid not null references auth.users(id) on delete restrict,recorded_at timestamptz not null default statement_timestamp(),
 unique(opening_id,revision),unique(opening_id,company_id,count_id,revision),
 foreign key(opening_id,company_id) references public.feed_openings(opening_id,company_id) on delete restrict
);
create table public.feed_opening_approvals (
 action_id uuid primary key,opening_id uuid not null unique,company_id uuid not null,count_id uuid not null,revision integer not null,
 event_payload jsonb not null,recorded_by uuid not null references auth.users(id) on delete restrict,recorded_at timestamptz not null default statement_timestamp(),
 foreign key(opening_id,company_id,count_id,revision) references public.feed_opening_counts(opening_id,company_id,count_id,revision) on delete restrict
);
alter table public.feed_openings enable row level security;alter table public.feed_openings force row level security;
alter table public.feed_opening_counts enable row level security;alter table public.feed_opening_counts force row level security;
alter table public.feed_opening_approvals enable row level security;alter table public.feed_opening_approvals force row level security;
create policy feed_openings_read on public.feed_openings for select to authenticated using(private.has_lot_role(company_id,site_id,house_id,lot_id,'capture') or private.has_lot_role(company_id,site_id,house_id,lot_id,'director'));
create policy feed_opening_counts_read on public.feed_opening_counts for select to authenticated using(exists(select 1 from public.feed_openings o where o.opening_id=feed_opening_counts.opening_id and o.company_id=feed_opening_counts.company_id));
create policy feed_opening_approvals_read on public.feed_opening_approvals for select to authenticated using(exists(select 1 from public.feed_openings o where o.opening_id=feed_opening_approvals.opening_id and o.company_id=feed_opening_approvals.company_id));
revoke all on public.feed_openings,public.feed_opening_counts,public.feed_opening_approvals from public,anon,authenticated;
grant select on public.feed_openings,public.feed_opening_counts,public.feed_opening_approvals to authenticated;

create function private.feed_opening_ack(p_event jsonb,p_actor uuid,p_at timestamptz,p_revision integer,p_approval boolean,p_duplicate boolean) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('format','tamago.feed-opening-'||case when p_approval then 'approval' else 'count' end||'-receipt','schema_version',1,'event',p_event,'actor_id',p_actor,'recorded_at',p_at,'revision',p_revision,'state_at_recording',case when p_approval then 'approved' else 'pending' end,'inventory_check','not_applied','duplicate',p_duplicate);
$$;
revoke all on function private.feed_opening_ack(jsonb,uuid,timestamptz,integer,boolean,boolean) from public,anon,authenticated;

create function public.record_feed_opening_count(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid()); company_value uuid;site_value uuid;house_value uuid;lot_value uuid;count_value uuid;opening_value uuid;previous_value uuid;expected integer;date_value date;time_value timestamptz;item jsonb;head public.feed_openings%rowtype;existing public.feed_opening_counts%rowtype;inserted public.feed_opening_counts%rowtype;
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='opening forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid opening';end if;
 if octet_length(p_event::text)>8192 or (p_event-array['format','schema_version','opening_id','count_id','company_id','site_id','house_id','lot_id','business_date','cutoff_at','product_declared','location_declared','quantity','unit','evidence_reference','notes','expected_revision','previous_count_id'])<>'{}'::jsonb
 or not(p_event ?& array['format','schema_version','opening_id','count_id','company_id','site_id','house_id','lot_id','business_date','cutoff_at','product_declared','location_declared','quantity','unit','evidence_reference','notes','expected_revision','previous_count_id'])
 or p_event->'schema_version' is distinct from '1'::jsonb or p_event->'format' is distinct from '"tamago.feed-opening-count"'::jsonb then raise exception using errcode='22023',message='invalid opening';end if;
 for item in select value from jsonb_each(p_event) where key in ('opening_id','count_id','company_id','site_id','house_id','lot_id') loop
 if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid opening';end if;end loop;
 if jsonb_typeof(p_event->'quantity') is distinct from 'string' or length(p_event->>'quantity')>100 or (p_event->>'quantity') !~ '^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$'
 or p_event->'unit' is distinct from '"BAG_40KG"'::jsonb
 or jsonb_typeof(p_event->'business_date') is distinct from 'string' or (p_event->>'business_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
 or jsonb_typeof(p_event->'cutoff_at') is distinct from 'string' or (p_event->>'cutoff_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
 or jsonb_typeof(p_event->'expected_revision') is distinct from 'number' or (p_event->>'expected_revision') !~ '^(0|[1-9][0-9]{0,6})$' then raise exception using errcode='22023',message='invalid opening';end if;
 for item in select value from jsonb_each(p_event) where key in ('product_declared','location_declared') loop
 if jsonb_typeof(item) is distinct from 'string' or length(trim(item#>>'{}'))<1 or length(item#>>'{}')>200 then raise exception using errcode='22023',message='invalid opening';end if;end loop;
 if jsonb_typeof(p_event->'evidence_reference') is distinct from 'string' or length(trim(p_event->>'evidence_reference'))<1 or length(p_event->>'evidence_reference')>2000 or jsonb_typeof(p_event->'notes') not in('string','null') or length(p_event->>'notes')>2000 then raise exception using errcode='22023',message='invalid opening';end if;
 begin
 company_value:=(p_event->>'company_id')::uuid;site_value:=(p_event->>'site_id')::uuid;house_value:=(p_event->>'house_id')::uuid;lot_value:=(p_event->>'lot_id')::uuid;count_value:=(p_event->>'count_id')::uuid;opening_value:=(p_event->>'opening_id')::uuid;expected:=(p_event->>'expected_revision')::integer;date_value:=(p_event->>'business_date')::date;time_value:=(p_event->>'cutoff_at')::timestamptz;
 exception when others then raise exception using errcode='22023',message='invalid opening';end;
 if expected>1000000 or (expected=0 and p_event->'previous_count_id' is distinct from 'null'::jsonb) or (expected>0 and (jsonb_typeof(p_event->'previous_count_id') is distinct from 'string' or (p_event->>'previous_count_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')) then raise exception using errcode='22023',message='invalid opening';end if;
 previous_value:=(p_event->>'previous_count_id')::uuid;
 if date_value::text<>p_event->>'business_date' or to_char(time_value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_event->>'cutoff_at' or (time_value at time zone 'America/Bogota')::date<>date_value then raise exception using errcode='22023',message='invalid opening';end if;
 if not private.has_lot_role(company_value,site_value,house_value,lot_value,'capture') then raise exception using errcode='42501',message='opening forbidden';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-opening:'||opening_value::text,0));
 select * into existing from public.feed_opening_counts where count_id=count_value;
 if found then
 if existing.recorded_by<>actor or existing.event_payload<>p_event then raise exception using errcode='23505',message='opening id content conflict';end if;
 return private.feed_opening_ack(existing.event_payload,existing.recorded_by,existing.recorded_at,existing.revision,false,true);end if;
 if not exists(select 1 from public.lots where company_id=company_value and site_id=site_value and house_id=house_value and id=lot_value and status='active') then raise exception using errcode='42501',message='opening forbidden';end if;
 select * into head from public.feed_openings where opening_id=opening_value;
 if found then
 if head.company_id<>company_value or head.site_id<>site_value or head.house_id<>house_value or head.lot_id<>lot_value or head.product_declared<>p_event->>'product_declared' or head.location_declared<>p_event->>'location_declared' or head.unit<>p_event->>'unit' then raise exception using errcode='23514',message='opening scope conflict';end if;
 if head.status<>'pending' then raise exception using errcode='55000',message='opening already approved';end if;
 if head.current_revision<>expected or not exists(select 1 from public.feed_opening_counts where opening_id=opening_value and revision=expected and count_id=previous_value) then raise exception using errcode='40001',message='opening revision conflict';end if;
 else
 if expected<>0 then raise exception using errcode='40001',message='opening revision conflict';end if;
 if not exists(select 1 from public.lots where company_id=company_value and site_id=site_value and house_id=house_value and id=lot_value and status='active') then raise exception using errcode='42501',message='opening forbidden';end if;
 insert into public.feed_openings(opening_id,company_id,site_id,house_id,lot_id,product_declared,location_declared,unit) values(opening_value,company_value,site_value,house_value,lot_value,p_event->>'product_declared',p_event->>'location_declared',p_event->>'unit');end if;
 insert into public.feed_opening_counts(count_id,opening_id,company_id,revision,previous_count_id,event_payload,recorded_by) values(count_value,opening_value,company_value,expected+1,previous_value,p_event,actor) returning * into inserted;
 update public.feed_openings set current_revision=expected+1 where opening_id=opening_value;
 return private.feed_opening_ack(inserted.event_payload,inserted.recorded_by,inserted.recorded_at,inserted.revision,false,false);
end;$$;
revoke all on function public.record_feed_opening_count(jsonb) from public,anon,service_role;
grant execute on function public.record_feed_opening_count(jsonb) to authenticated;

create function public.approve_feed_opening(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());company_value uuid;opening_value uuid;count_value uuid;action_value uuid;expected integer;item jsonb;head public.feed_openings%rowtype;existing public.feed_opening_approvals%rowtype;inserted public.feed_opening_approvals%rowtype;
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='opening forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid opening';end if;
 if octet_length(p_event::text)>8192 or (p_event-array['format','schema_version','action_id','company_id','opening_id','count_id','expected_revision','reason'])<>'{}'::jsonb or not(p_event ?& array['format','schema_version','action_id','company_id','opening_id','count_id','expected_revision','reason']) or p_event->'schema_version' is distinct from '1'::jsonb or p_event->'format' is distinct from '"tamago.feed-opening-approval"'::jsonb then raise exception using errcode='22023',message='invalid opening';end if;
 for item in select value from jsonb_each(p_event) where key in ('action_id','company_id','opening_id','count_id') loop
 if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid opening';end if;end loop;
 if jsonb_typeof(p_event->'expected_revision') is distinct from 'number' or (p_event->>'expected_revision') !~ '^[1-9][0-9]{0,6}$' or jsonb_typeof(p_event->'reason') is distinct from 'string' or length(trim(p_event->>'reason'))<1 or length(p_event->>'reason')>2000 then raise exception using errcode='22023',message='invalid opening';end if;
 company_value:=(p_event->>'company_id')::uuid;opening_value:=(p_event->>'opening_id')::uuid;action_value:=(p_event->>'action_id')::uuid;count_value:=(p_event->>'count_id')::uuid;expected:=(p_event->>'expected_revision')::integer;
 if expected>1000001 then raise exception using errcode='22023',message='invalid opening';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('feed-opening:'||opening_value::text,0));
 select * into head from public.feed_openings where opening_id=opening_value and company_id=company_value;
 if not found then raise exception using errcode='42501',message='opening forbidden';end if;
 if not private.has_lot_role(company_value,head.site_id,head.house_id,head.lot_id,'director') then raise exception using errcode='42501',message='opening forbidden';end if;
 select * into existing from public.feed_opening_approvals where action_id=action_value;
 if found then
 if existing.event_payload<>p_event or existing.recorded_by<>actor then raise exception using errcode='23505',message='opening id content conflict';end if;
 return private.feed_opening_ack(existing.event_payload,existing.recorded_by,existing.recorded_at,existing.revision,true,true);end if;
 if head.status<>'pending' then raise exception using errcode='55000',message='opening already approved';end if;
 if head.current_revision<>expected or not exists(select 1 from public.feed_opening_counts where opening_id=opening_value and revision=expected and count_id=count_value) then raise exception using errcode='40001',message='opening revision conflict';end if;
 insert into public.feed_opening_approvals(action_id,opening_id,company_id,count_id,revision,event_payload,recorded_by) values(action_value,opening_value,company_value,count_value,expected,p_event,actor) returning * into inserted;
 update public.feed_openings set status='approved' where opening_id=opening_value;
 return private.feed_opening_ack(inserted.event_payload,inserted.recorded_by,inserted.recorded_at,inserted.revision,true,false);
end;$$;
revoke all on function public.approve_feed_opening(jsonb) from public,anon,service_role;
grant execute on function public.approve_feed_opening(jsonb) to authenticated;

create function public.get_feed_opening(p_company_id uuid,p_opening_id uuid,p_offset integer default 0) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='invalid opening';end if;
 with head as (select * from public.feed_openings where company_id=p_company_id and opening_id=p_opening_id),
 counts as (select c.event_payload,c.recorded_by,c.recorded_at,c.revision from public.feed_opening_counts c join head h using(opening_id,company_id) order by c.revision desc limit 26 offset p_offset)
 select jsonb_build_object('format','tamago.feed-opening-context','schema_version',1,'inventory_check','not_applied','opening',to_jsonb(h),'counts',coalesce((select jsonb_agg(to_jsonb(c) order by c.revision desc) from (select * from counts order by revision desc limit 25)c),'[]'::jsonb),'approval',(select jsonb_build_object('event_payload',a.event_payload,'recorded_by',a.recorded_by,'recorded_at',a.recorded_at,'revision',a.revision) from public.feed_opening_approvals a where a.company_id=h.company_id and a.opening_id=h.opening_id),'next_offset',case when (select count(*) from counts)>25 then p_offset+25 else null end) into result from head h;
 return result;
end;$$;
revoke all on function public.get_feed_opening(uuid,uuid,integer) from public,anon,service_role;
grant execute on function public.get_feed_opening(uuid,uuid,integer) to authenticated;
