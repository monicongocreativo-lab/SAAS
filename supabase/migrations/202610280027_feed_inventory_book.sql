-- First effective opening and append-only inventory book. Physical capture remains independent.
create table public.feed_inventory_accounts(
 account_id uuid primary key,company_id uuid not null,site_id uuid not null,house_id uuid not null,lot_id uuid not null,
 product_id uuid not null,location_id uuid not null,opening_id uuid not null,count_id uuid not null,
 count_binding_id uuid not null,count_binding_revision integer not null check(count_binding_revision>=0),
 cutoff_at timestamptz not null,opening_quantity numeric not null check(opening_quantity>=0),unit text not null check(unit='BAG_40KG'),
 event_payload jsonb not null,recorded_by uuid not null references auth.users(id) on delete restrict,recorded_at timestamptz not null default statement_timestamp(),
 unique(company_id,account_id),unique(company_id,opening_id),unique(company_id,site_id,house_id,lot_id,product_id,location_id),
 foreign key(company_id,site_id,house_id,lot_id) references public.lots(company_id,site_id,house_id,id) on delete restrict,
 foreign key(company_id,product_id) references public.feed_catalog_items(company_id,item_id) on delete restrict,
 foreign key(company_id,location_id) references public.feed_catalog_items(company_id,item_id) on delete restrict,
 foreign key(company_id,count_id) references public.feed_opening_counts(company_id,count_id) on delete restrict,
 foreign key(company_id,count_binding_id) references public.feed_fact_bindings(company_id,binding_id) on delete restrict
);
create table public.feed_ledger_operations(
 action_id uuid primary key,company_id uuid not null,account_id uuid not null,revision integer not null check(revision>0),
 through_at timestamptz not null,review_token text not null check(review_token~'^[0-9a-f]{64}$'),balance_after numeric not null check(balance_after>=0),
 event_payload jsonb not null,recorded_by uuid not null references auth.users(id) on delete restrict,recorded_at timestamptz not null default statement_timestamp(),
 unique(company_id,action_id),unique(company_id,account_id,action_id),unique(account_id,revision),
 foreign key(company_id,account_id) references public.feed_inventory_accounts(company_id,account_id) on delete restrict
);
create table public.feed_ledger_entries(
 entry_id uuid primary key default gen_random_uuid(),company_id uuid not null,account_id uuid not null,action_id uuid not null,
 source_kind text not null check(source_kind in('opening','delivery','supply')),source_id uuid not null,source_binding_id uuid,
 check((source_kind='opening' and source_binding_id is null) or(source_kind<>'opening' and source_binding_id is not null)),
 delta numeric not null,desired_after numeric not null,context_hash text not null check(context_hash~'^[0-9a-f]{64}$'),source_snapshot jsonb not null,
 foreign key(company_id,account_id) references public.feed_inventory_accounts(company_id,account_id) on delete restrict,
 foreign key(company_id,account_id,action_id) references public.feed_ledger_operations(company_id,account_id,action_id) on delete restrict,
 foreign key(company_id,source_binding_id) references public.feed_fact_bindings(company_id,binding_id) on delete restrict,
 unique(action_id,source_kind,source_id)
);
create index feed_ledger_account_source on public.feed_ledger_entries(account_id,source_kind,source_id);
create index feed_ledger_source on public.feed_ledger_entries(company_id,source_kind,source_id,account_id);
alter table public.feed_inventory_accounts enable row level security;alter table public.feed_inventory_accounts force row level security;
alter table public.feed_ledger_operations enable row level security;alter table public.feed_ledger_operations force row level security;
alter table public.feed_ledger_entries enable row level security;alter table public.feed_ledger_entries force row level security;
create policy feed_accounts_read on public.feed_inventory_accounts for select to authenticated using(private.has_lot_role(company_id,site_id,house_id,lot_id,'director') or private.has_lot_role(company_id,site_id,house_id,lot_id,'capture'));
create policy feed_operations_read on public.feed_ledger_operations for select to authenticated using(exists(select 1 from public.feed_inventory_accounts a where a.company_id=feed_ledger_operations.company_id and a.account_id=feed_ledger_operations.account_id));
create policy feed_entries_read on public.feed_ledger_entries for select to authenticated using(exists(select 1 from public.feed_inventory_accounts a where a.company_id=feed_ledger_entries.company_id and a.account_id=feed_ledger_entries.account_id));
revoke all on public.feed_inventory_accounts,public.feed_ledger_operations,public.feed_ledger_entries from public,anon,authenticated;
grant select on public.feed_inventory_accounts,public.feed_ledger_operations,public.feed_ledger_entries to authenticated;

create function private.feed_book_hash(v jsonb) returns text language sql immutable set search_path='' as $$select encode(pg_catalog.sha256(convert_to(v::text,'UTF8')),'hex');$$;
revoke all on function private.feed_book_hash(jsonb) from public,anon,authenticated,service_role;

-- Called only by authorized wrappers under the company's shared/exclusive transaction lock.
create function private.feed_book_state(c uuid,op uuid,t timestamptz) returns jsonb language plpgsql set search_path='' as $$
declare root public.feed_openings%rowtype;mapping public.feed_effective_bindings%rowtype;acct public.feed_inventory_accounts%rowtype;
 preview jsonb;result jsonb;rows_value jsonb;rev integer:=0;book numeric;proposed numeric;cut timestamptz;p uuid;loc uuid;changes integer:=0;external_count integer:=0;state text;last_time timestamptz;quantity numeric;
begin
 select * into root from public.feed_openings where company_id=c and opening_id=op;
 if not found then return null;end if;
 preview:=public.get_feed_balance_preview(c,op,t);
 select * into acct from public.feed_inventory_accounts where company_id=c and opening_id=op;
 if acct.account_id is not null then
 select coalesce(max(revision),0),max(through_at) into rev,last_time from public.feed_ledger_operations where account_id=acct.account_id;
 select coalesce(sum(delta),0) into book from public.feed_ledger_entries where account_id=acct.account_id;
 end if;
 result:=jsonb_build_object('format','tamago.feed-ledger-review','schema_version',1,'company_id',c,'opening_id',op,'through_at',t,'account',case when acct.account_id is null then null else to_jsonb(acct)||jsonb_build_object('opening_quantity',trim_scale(acct.opening_quantity)::text) end,'revision',rev,'book_through_at',last_time,'anchor',null,'book_balance_bags',case when book is null then null else trim_scale(book)::text end,'proposed_balance_bags',null,'available_bags',null,'status','blocked','can_activate',false,'can_post',false,'coverage','server_records_only','inventory_check',case when acct.account_id is null then 'not_activated' else 'book_recorded' end,'preview',preview,'source_count',0,'pending_sources',0,'other_applied_sources',0,'rows','[]'::jsonb);
 if preview->>'reason' is not null then return result||jsonb_build_object('review_token',private.feed_book_hash(result));end if;
 select * into mapping from public.feed_effective_bindings where company_id=c and source_kind='count' and source_id=(preview->>'count_id')::uuid;
 cut:=(preview->>'cutoff_at')::timestamptz;quantity:=(preview->>'opening_bags')::numeric;
 if acct.account_id is null then
 select * into acct from public.feed_inventory_accounts where company_id=c and site_id=root.site_id and house_id=root.house_id and lot_id=root.lot_id and product_id=mapping.product_id and location_id=mapping.location_id;
 if acct.account_id is not null then
 select coalesce(max(revision),0),max(through_at) into rev,last_time from public.feed_ledger_operations where account_id=acct.account_id;
 select coalesce(sum(delta),0) into book from public.feed_ledger_entries where account_id=acct.account_id;
 result:=result||jsonb_build_object('account',to_jsonb(acct)||jsonb_build_object('opening_quantity',trim_scale(acct.opening_quantity)::text),'revision',rev,'book_through_at',last_time,'book_balance_bags',trim_scale(book)::text,'inventory_check','book_recorded');
 end if;
 end if;
 p:=coalesce(acct.product_id,mapping.product_id);loc:=coalesce(acct.location_id,mapping.location_id);
 with facts as(
 select 'delivery'::text as kind,d.event_id as id,d.occurred_at,d.quantity::numeric as q,d.event_payload,d.recorded_by,d.recorded_at from public.feed_delivery_events d where d.company_id=c and d.site_id=root.site_id and d.house_id=root.house_id and d.lot_id=root.lot_id and d.occurred_at>=cut and d.occurred_at<=t
 union all
 select 'supply'::text,s.event_id,s.occurred_at,s.quantity::numeric,s.event_payload,s.recorded_by,s.recorded_at from public.feed_supply_events s where s.company_id=c and s.site_id=root.site_id and s.house_id=root.house_id and s.lot_id=root.lot_id and s.occurred_at>=cut and s.occurred_at<=t
 ),annotated as(
 select f.*,
 case when b.product_id=p and b.location_id=loc and (f.occurred_at>cut or(f.occurred_at=cut and d.classification='after_count' and d.opening_binding_revision=mapping.correction_revision and d.movement_binding_revision=b.correction_revision)) then case when f.kind='delivery' then f.q else -f.q end else 0 end as desired,
 coalesce((select sum(e.delta) from public.feed_ledger_entries e where e.account_id=acct.account_id and e.source_kind=f.kind and e.source_id=f.id),0) as applied,
 (select e.context_hash from public.feed_ledger_entries e join public.feed_ledger_operations o using(company_id,action_id) where e.account_id=acct.account_id and e.source_kind=f.kind and e.source_id=f.id order by o.revision desc limit 1) as applied_hash,
 exists(select 1 from public.feed_ledger_entries e where e.company_id=c and e.source_kind=f.kind and e.source_id=f.id and (acct.account_id is null or e.account_id<>acct.account_id) group by e.account_id having sum(e.delta)<>0) as used_elsewhere,
 jsonb_build_object('source',f.event_payload,'author',f.recorded_by,'recorded_at',f.recorded_at,'binding_id',b.binding_id,'binding_revision',b.correction_revision,'product_id',b.product_id,'location_id',b.location_id,'decision_id',d.action_id,'decision_revision',d.correction_revision,'classification',d.classification,'opening_binding_revision',mapping.correction_revision,'decision_opening_revision',d.opening_binding_revision,'decision_movement_revision',d.movement_binding_revision) as snapshot
 from facts f left join public.feed_effective_bindings b on b.company_id=c and b.source_kind=f.kind and b.source_id=f.id
 left join public.feed_effective_cutoffs d on d.company_id=c and d.opening_id=op and d.source_kind=f.kind and d.source_id=f.id
 ),evaluated as(select *,private.feed_book_hash(snapshot) as context_hash from annotated)
 select coalesce(jsonb_agg(jsonb_build_object('source_kind',kind,'source_id',id,'quantity_bags',trim_scale(q)::text,'occurred_at',occurred_at,'desired_bags',trim_scale(desired)::text,'applied_bags',trim_scale(applied)::text,'delta_bags',trim_scale(desired-applied)::text,'pending',desired<>applied or(desired<>0 and applied_hash is distinct from context_hash),'other_applied',desired<>0 and used_elsewhere,'context_hash',context_hash,'snapshot',snapshot) order by kind,id),'[]'::jsonb),
 quantity+coalesce(sum(desired),0),count(*) filter(where desired<>applied or(desired<>0 and applied_hash is distinct from context_hash)),count(*) filter(where desired<>0 and used_elsewhere)
 into rows_value,proposed,changes,external_count from evaluated;
 state:=case
 when acct.account_id is not null and acct.opening_id<>op then 'already_active'
 when acct.account_id is not null and (acct.count_id<>mapping.source_id or acct.count_binding_id<>mapping.binding_id or acct.count_binding_revision<>mapping.correction_revision or acct.product_id<>mapping.product_id or acct.location_id<>mapping.location_id) then 'opening_changed'
 when t>statement_timestamp() then 'future_window'
 when last_time is not null and t<last_time then 'earlier_window'
 when preview->>'status'='blocked' then 'blocked'
 when external_count>0 then 'other_account_pending'
 when proposed<0 then 'insufficient'
 when acct.account_id is null then 'needs_activation'
 when changes>0 then 'pending'
 else 'current' end;
 result:=result||jsonb_build_object('status',state,'can_activate',state='needs_activation','can_post',state='pending','proposed_balance_bags',trim_scale(proposed)::text,'available_bags',case when state='current' then trim_scale(book)::text else null end,'source_count',jsonb_array_length(rows_value),'pending_sources',changes,'other_applied_sources',external_count,'rows',rows_value,'anchor',jsonb_build_object('count_id',mapping.source_id,'binding_id',mapping.binding_id,'binding_revision',mapping.correction_revision,'product_id',mapping.product_id,'location_id',mapping.location_id,'cutoff_at',cut,'opening_bags',trim_scale(quantity)::text));
 return result||jsonb_build_object('review_token',private.feed_book_hash(result));
end;$$;
revoke all on function private.feed_book_state(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create function public.get_feed_ledger_review(p_company_id uuid,p_opening_id uuid,p_through_at timestamptz,p_offset integer default 0) returns jsonb language plpgsql security definer set search_path='' as $$
declare root public.feed_openings%rowtype;v jsonb;items jsonb;actor uuid:=(select auth.uid());
begin
 if p_through_at is null or not isfinite(p_through_at) or p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='invalid ledger window';end if;
 if actor is null or not private.initial_access_complete() then return null;end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('feed-inventory-version:'||p_company_id::text,0));
 select * into root from public.feed_openings where company_id=p_company_id and opening_id=p_opening_id;
 if not found or not(private.has_lot_role(p_company_id,root.site_id,root.house_id,root.lot_id,'capture') or private.has_lot_role(p_company_id,root.site_id,root.house_id,root.lot_id,'director')) then return null;end if;
 v:=private.feed_book_state(p_company_id,p_opening_id,p_through_at);
 select coalesce(jsonb_agg(value-'snapshot' order by ordinality),'[]'::jsonb) into items from jsonb_array_elements(v->'rows') with ordinality where ordinality>p_offset and ordinality<=p_offset+25;
 return (v-'rows')||jsonb_build_object('can_manage',private.has_lot_role(p_company_id,root.site_id,root.house_id,root.lot_id,'director'),'can_activate',(v->>'can_activate')::boolean and private.has_lot_role(p_company_id,root.site_id,root.house_id,root.lot_id,'director'),'can_post',(v->>'can_post')::boolean and private.has_lot_role(p_company_id,root.site_id,root.house_id,root.lot_id,'director'),'items',items,'next_offset',case when (v->>'source_count')::integer>p_offset+25 then p_offset+25 else null end);
end;$$;
revoke all on function public.get_feed_ledger_review(uuid,uuid,timestamptz,integer) from public,anon,service_role;
grant execute on function public.get_feed_ledger_review(uuid,uuid,timestamptz,integer) to authenticated;

create function private.feed_book_ack(o public.feed_ledger_operations,d boolean) returns jsonb language sql set search_path='' as $$select jsonb_build_object('format','tamago.feed-ledger-receipt','schema_version',1,'event',o.event_payload,'actor_id',o.recorded_by,'recorded_at',o.recorded_at,'account_id',o.account_id,'revision',o.revision,'balance_bags',trim_scale(o.balance_after)::text,'duplicate',d,'inventory_check','applied_to_book','coverage','server_records_only');$$;
revoke all on function private.feed_book_ack(public.feed_ledger_operations,boolean) from public,anon,authenticated,service_role;

create function public.apply_feed_ledger(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor uuid:=(select auth.uid());c uuid;i uuid;op uuid;acct public.feed_inventory_accounts%rowtype;root public.feed_openings%rowtype;existing public.feed_ledger_operations%rowtype;
 mode text;keys text[];x jsonb;v jsonb;anchor jsonb;t timestamptz;rev integer;account_id_value uuid;
begin
 if actor is null or not private.initial_access_complete() then raise exception using errcode='42501',message='ledger forbidden';end if;
 if p_event is null or jsonb_typeof(p_event) is distinct from 'object' then raise exception using errcode='22023',message='invalid ledger command';end if;
 mode:=p_event->>'format';keys:=array['format','schema_version','action_id','company_id','through_at','review_token','reason'];
 if mode='tamago.feed-inventory-activation' then keys:=keys||array['opening_id'];elsif mode='tamago.feed-inventory-posting' then keys:=keys||array['account_id','expected_revision'];else raise exception using errcode='22023',message='invalid ledger command';end if;
 if octet_length(p_event::text)>8192 or (p_event-keys)<>'{}'::jsonb or not(p_event ?& keys) or p_event->'schema_version' is distinct from '1'::jsonb then raise exception using errcode='22023',message='invalid ledger command';end if;
 for x in select value from jsonb_each(p_event) where key in('action_id','company_id','opening_id','account_id') loop
 if jsonb_typeof(x) is distinct from 'string' or (x#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then raise exception using errcode='22023',message='invalid ledger command';end if;end loop;
 if jsonb_typeof(p_event->'review_token') is distinct from 'string' or (p_event->>'review_token') !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_event->'reason') is distinct from 'string' or length(trim(p_event->>'reason')) not between 1 and 2000 or jsonb_typeof(p_event->'through_at') is distinct from 'string' or (p_event->>'through_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then raise exception using errcode='22023',message='invalid ledger command';end if;
 t:=(p_event->>'through_at')::timestamptz;c:=(p_event->>'company_id')::uuid;i:=(p_event->>'action_id')::uuid;
 perform pg_advisory_xact_lock(hashtextextended('feed-inventory-version:'||c::text,0));
 if mode='tamago.feed-inventory-activation' then
 op:=(p_event->>'opening_id')::uuid;select * into root from public.feed_openings where company_id=c and opening_id=op;
 if not found or not private.has_lot_role(c,root.site_id,root.house_id,root.lot_id,'director') then raise exception using errcode='42501',message='ledger forbidden';end if;
 else
 if jsonb_typeof(p_event->'expected_revision') is distinct from 'number' or (p_event->>'expected_revision') !~ '^[1-9][0-9]{0,8}$' then raise exception using errcode='22023',message='invalid ledger command';end if;
 select * into acct from public.feed_inventory_accounts where company_id=c and account_id=(p_event->>'account_id')::uuid;
 if not found or not private.has_lot_role(c,acct.site_id,acct.house_id,acct.lot_id,'director') then raise exception using errcode='42501',message='ledger forbidden';end if;
 op:=acct.opening_id;select * into root from public.feed_openings where company_id=c and opening_id=op;
 end if;
 select * into existing from public.feed_ledger_operations where action_id=i;
 if found then
 if existing.event_payload<>p_event or existing.recorded_by<>actor then raise exception using errcode='23505',message='ledger id content conflict';end if;
 return private.feed_book_ack(existing,true);end if;
 v:=private.feed_book_state(c,op,t);
 if v->>'review_token'<>p_event->>'review_token' then raise exception using errcode='40001',message='ledger reviewed set changed';end if;
 if mode='tamago.feed-inventory-activation' then
 if not (v->>'can_activate')::boolean then raise exception using errcode='23514',message='ledger activation pending review';end if;
 anchor:=v->'anchor';account_id_value:=i;rev:=1;
 insert into public.feed_inventory_accounts(account_id,company_id,site_id,house_id,lot_id,product_id,location_id,opening_id,count_id,count_binding_id,count_binding_revision,cutoff_at,opening_quantity,unit,event_payload,recorded_by)
 values(i,c,root.site_id,root.house_id,root.lot_id,(anchor->>'product_id')::uuid,(anchor->>'location_id')::uuid,op,(anchor->>'count_id')::uuid,(anchor->>'binding_id')::uuid,(anchor->>'binding_revision')::integer,(anchor->>'cutoff_at')::timestamptz,(anchor->>'opening_bags')::numeric,'BAG_40KG',p_event,actor);
 else
 if (v->>'revision')::integer<>(p_event->>'expected_revision')::integer then raise exception using errcode='40001',message='ledger stale revision';end if;
 if not (v->>'can_post')::boolean then raise exception using errcode='23514',message='ledger application pending review';end if;
 account_id_value:=acct.account_id;rev:=(v->>'revision')::integer+1;
 end if;
 insert into public.feed_ledger_operations(action_id,company_id,account_id,revision,through_at,review_token,balance_after,event_payload,recorded_by) values(i,c,account_id_value,rev,t,p_event->>'review_token',(v->>'proposed_balance_bags')::numeric,p_event,actor) returning * into existing;
 if mode='tamago.feed-inventory-activation' then
 insert into public.feed_ledger_entries(company_id,account_id,action_id,source_kind,source_id,delta,desired_after,context_hash,source_snapshot)
 values(c,account_id_value,i,'opening',(anchor->>'count_id')::uuid,(anchor->>'opening_bags')::numeric,(anchor->>'opening_bags')::numeric,private.feed_book_hash(anchor),anchor);
 end if;
 for x in select value from jsonb_array_elements(v->'rows') where (value->>'pending')::boolean loop
 insert into public.feed_ledger_entries(company_id,account_id,action_id,source_kind,source_id,source_binding_id,delta,desired_after,context_hash,source_snapshot)
 values(c,account_id_value,i,x->>'source_kind',(x->>'source_id')::uuid,(x->'snapshot'->>'binding_id')::uuid,(x->>'delta_bags')::numeric,(x->>'desired_bags')::numeric,x->>'context_hash',x->'snapshot');end loop;
 if (select sum(delta) from public.feed_ledger_entries where account_id=account_id_value) is distinct from existing.balance_after then raise exception using errcode='23514',message='ledger conservation failed';end if;
 return private.feed_book_ack(existing,false);
end;$$;
revoke all on function public.apply_feed_ledger(jsonb) from public,anon,service_role;
grant execute on function public.apply_feed_ledger(jsonb) to authenticated;

create function public.get_feed_ledger_entries(p_company_id uuid,p_account_id uuid,p_offset integer default 0) returns jsonb language plpgsql security invoker set search_path='' as $$
declare acct public.feed_inventory_accounts%rowtype;rows_value jsonb;rev integer;balance numeric;
begin
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='invalid ledger page';end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('feed-inventory-version:'||p_company_id::text,0));
 select * into acct from public.feed_inventory_accounts where company_id=p_company_id and account_id=p_account_id;
 if not found then return null;end if;
 select coalesce(max(revision),0) into rev from public.feed_ledger_operations where account_id=p_account_id;
 select coalesce(sum(delta),0) into balance from public.feed_ledger_entries where account_id=p_account_id;
 select coalesce(jsonb_agg(to_jsonb(x)||jsonb_build_object('delta',trim_scale(x.delta)::text,'desired_after',trim_scale(x.desired_after)::text) order by x.operation_revision desc,x.entry_id),'[]'::jsonb) into rows_value from(select e.*,o.revision as operation_revision,o.recorded_by,o.recorded_at,o.event_payload as operation_payload from public.feed_ledger_entries e join public.feed_ledger_operations o using(company_id,account_id,action_id) where e.company_id=p_company_id and e.account_id=p_account_id order by o.revision desc,e.entry_id limit 26 offset p_offset)x;
 return jsonb_build_object('format','tamago.feed-ledger-entries','schema_version',1,'company_id',p_company_id,'account_id',p_account_id,'revision',rev,'book_balance_bags',trim_scale(balance)::text,'items',coalesce((select jsonb_agg(value order by ordinality) from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end);
end;$$;
revoke all on function public.get_feed_ledger_entries(uuid,uuid,integer) from public,anon,service_role;
grant execute on function public.get_feed_ledger_entries(uuid,uuid,integer) to authenticated;

-- Serialize new physical facts with book review/application without changing their business validation.
create function private.feed_source_book_lock(p_event jsonb) returns void language plpgsql set search_path='' as $$
begin
 if auth.uid() is not null and private.initial_access_complete() and jsonb_typeof(p_event->'company_id')='string' and (p_event->>'company_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
 perform pg_advisory_xact_lock(hashtextextended('feed-inventory-version:'||(p_event->>'company_id'),0));end if;
end;$$;
revoke all on function private.feed_source_book_lock(jsonb) from public,anon,authenticated,service_role;
alter function public.record_feed_supply(jsonb) set schema private;
alter function private.record_feed_supply(jsonb) rename to record_feed_supply_prebook;
revoke all on function private.record_feed_supply_prebook(jsonb) from public,anon,authenticated,service_role;
create function public.record_feed_supply(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin perform private.feed_source_book_lock(p_event);return private.record_feed_supply_prebook(p_event);end;$$;
revoke all on function public.record_feed_supply(jsonb) from public,anon,service_role;
grant execute on function public.record_feed_supply(jsonb) to authenticated;
alter function public.record_feed_delivery(jsonb) set schema private;
alter function private.record_feed_delivery(jsonb) rename to record_feed_delivery_prebook;
revoke all on function private.record_feed_delivery_prebook(jsonb) from public,anon,authenticated,service_role;
create function public.record_feed_delivery(p_event jsonb) returns jsonb language plpgsql security definer set search_path='' as $$begin perform private.feed_source_book_lock(p_event);return private.record_feed_delivery_prebook(p_event);end;$$;
revoke all on function public.record_feed_delivery(jsonb) from public,anon,service_role;
grant execute on function public.record_feed_delivery(jsonb) to authenticated;

create function public.get_feed_ledger_action(p_company_id uuid,p_action_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o public.feed_ledger_operations%rowtype;a public.feed_inventory_accounts%rowtype;
begin
 if auth.uid() is null or not private.initial_access_complete() then return null;end if;
 perform pg_advisory_xact_lock_shared(hashtextextended('feed-inventory-version:'||p_company_id::text,0));
 select * into o from public.feed_ledger_operations where company_id=p_company_id and action_id=p_action_id;
 if not found then return null;end if;
 select * into a from public.feed_inventory_accounts where company_id=p_company_id and account_id=o.account_id;
 if not(private.has_lot_role(p_company_id,a.site_id,a.house_id,a.lot_id,'director') or private.has_lot_role(p_company_id,a.site_id,a.house_id,a.lot_id,'capture')) then return null;end if;
 return private.feed_book_ack(o,true);
end;$$;
revoke all on function public.get_feed_ledger_action(uuid,uuid) from public,anon,service_role;
grant execute on function public.get_feed_ledger_action(uuid,uuid) to authenticated;
