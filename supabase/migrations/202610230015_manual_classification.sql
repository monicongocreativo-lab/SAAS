-- Manual machine-output counts only. No weight thresholds, production
-- correction, commercial stock, custody resolution or daily close is applied.
alter table public.collection_transfers add constraint collection_transfers_classification_origin_key
  unique(company_id,site_id,house_id,lot_id,origin_business_date,transfer_id);

create table public.manual_classification_sessions (
  session_id uuid primary key,
  company_id uuid not null,
  site_id uuid not null,
  house_id uuid not null,
  lot_id uuid not null,
  origin_business_date date not null,
  schema_version smallint not null check(schema_version=1),
  processed_quantity bigint not null check(processed_quantity>0),
  classified_at timestamptz not null,
  machine_configuration_reference text check(machine_configuration_reference is null or length(trim(machine_configuration_reference)) between 1 and 200),
  configuration_status text not null default 'declared_unverified' check(configuration_status='declared_unverified'),
  review_status text not null default 'pending' check(review_status='pending'),
  notes text check(notes is null or length(notes)<=2000),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default statement_timestamp(),
  event_payload jsonb not null check(jsonb_typeof(event_payload)='object'),
  unique(company_id,session_id),
  unique(company_id,site_id,house_id,lot_id,origin_business_date,session_id),
  foreign key(company_id,site_id,house_id,lot_id) references public.lots(company_id,site_id,house_id,id) on delete restrict,
  check((classified_at at time zone 'America/Bogota')::date>=origin_business_date)
);
create index manual_classification_sessions_origin_idx on public.manual_classification_sessions(company_id,origin_business_date,lot_id,recorded_at desc,session_id);

create table public.manual_classification_inputs (
  company_id uuid not null,
  site_id uuid not null,
  house_id uuid not null,
  lot_id uuid not null,
  origin_business_date date not null,
  session_id uuid not null,
  transfer_id uuid not null,
  input_index smallint not null check(input_index between 1 and 50),
  quantity_eggs integer not null check(quantity_eggs>0),
  primary key(session_id,transfer_id),
  unique(session_id,input_index),
  foreign key(company_id,site_id,house_id,lot_id,origin_business_date,session_id)
    references public.manual_classification_sessions(company_id,site_id,house_id,lot_id,origin_business_date,session_id) on delete restrict,
  foreign key(company_id,site_id,house_id,lot_id,origin_business_date,transfer_id)
    references public.collection_transfers(company_id,site_id,house_id,lot_id,origin_business_date,transfer_id) on delete restrict
);
create index manual_classification_inputs_transfer_idx on public.manual_classification_inputs(company_id,transfer_id);

create table public.manual_classification_lines (
  line_id uuid primary key,
  company_id uuid not null,
  session_id uuid not null,
  line_index smallint not null check(line_index between 1 and 100),
  quantity_eggs integer not null check(quantity_eggs>0),
  typology text not null check(typology in ('PIPO','C','B','A','AA','AAA','YUMBO','UNKNOWN')),
  condition text not null check(condition in ('NORMAL','DIRTY','BROKEN','YOLK')),
  destination text not null check(destination in ('PENDING','DISCARD')),
  unique(session_id,line_index),
  foreign key(company_id,session_id) references public.manual_classification_sessions(company_id,session_id) on delete restrict,
  check(typology<>'PIPO' or destination='DISCARD')
);

alter table public.manual_classification_sessions enable row level security;
alter table public.manual_classification_sessions force row level security;
alter table public.manual_classification_inputs enable row level security;
alter table public.manual_classification_inputs force row level security;
alter table public.manual_classification_lines enable row level security;
alter table public.manual_classification_lines force row level security;
create policy manual_classification_sessions_read_scope on public.manual_classification_sessions for select to authenticated
using(private.has_lot_role(company_id,site_id,house_id,lot_id,'capture')
  or private.has_lot_role(company_id,site_id,house_id,lot_id,'transport')
  or private.has_lot_role(company_id,site_id,house_id,lot_id,'warehouse')
  or private.has_lot_role(company_id,site_id,house_id,lot_id,'director'));
create policy manual_classification_inputs_read_scope on public.manual_classification_inputs for select to authenticated
using(exists(select 1 from public.manual_classification_sessions session
  where session.company_id=manual_classification_inputs.company_id and session.session_id=manual_classification_inputs.session_id));
create policy manual_classification_lines_read_scope on public.manual_classification_lines for select to authenticated
using(exists(select 1 from public.manual_classification_sessions session
  where session.company_id=manual_classification_lines.company_id and session.session_id=manual_classification_lines.session_id));
revoke all on public.manual_classification_sessions,public.manual_classification_inputs,public.manual_classification_lines from public,anon,authenticated;
grant select on public.manual_classification_sessions,public.manual_classification_inputs,public.manual_classification_lines to authenticated;

create function private.manual_classification_receipt(p_session public.manual_classification_sessions,p_duplicate boolean)
returns jsonb language sql immutable set search_path='' as $$
  select jsonb_build_object('format','tamago.manual-classification-receipt','schema_version',1,
    'session_id',p_session.session_id,'company_id',p_session.company_id,'origin_business_date',p_session.origin_business_date,
    'processed_quantity',p_session.processed_quantity,'recorded_by',p_session.recorded_by,'recorded_at',p_session.recorded_at,
    'review_status',p_session.review_status,'configuration_status',p_session.configuration_status,'duplicate',p_duplicate);
$$;
revoke all on function private.manual_classification_receipt(public.manual_classification_sessions,boolean) from public,anon,authenticated;

create function public.record_manual_classification(p_record jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid:=(select auth.uid());
  company_value uuid; site_value uuid; house_value uuid; lot_value uuid; session_value uuid;
  origin_date_value date; classified_value timestamptz;
  input_ids uuid[]:='{}'; line_ids uuid[]:='{}';
  item jsonb; item_id uuid; numeric_quantity numeric;
  incoming bigint:=0; outgoing bigint:=0; used_quantity bigint; found_inputs integer:=0;
  transfer public.collection_transfers%rowtype;
  existing public.manual_classification_sessions%rowtype;
  inserted public.manual_classification_sessions%rowtype;
begin
  if actor is null or not private.initial_access_complete() then
    raise exception using errcode='42501',message='manual classification forbidden';
  end if;
  if p_record is null or jsonb_typeof(p_record) is distinct from 'object' then
    raise exception using errcode='22023',message='invalid manual classification';
  end if;
  if octet_length(p_record::text)>65536
    or (p_record-array['schema_version','session_id','company_id','site_id','house_id','lot_id','origin_business_date','classified_at','machine_configuration_reference','notes','inputs','lines'])<>'{}'::jsonb
    or not(p_record ?& array['schema_version','session_id','company_id','site_id','house_id','lot_id','origin_business_date','classified_at','machine_configuration_reference','notes','inputs','lines'])
    or p_record->'schema_version' is distinct from '1'::jsonb
    or jsonb_typeof(p_record->'inputs') is distinct from 'array' or jsonb_typeof(p_record->'lines') is distinct from 'array'
    or jsonb_typeof(p_record->'origin_business_date') is distinct from 'string'
    or jsonb_typeof(p_record->'classified_at') is distinct from 'string'
    or jsonb_typeof(p_record->'notes') not in ('string','null')
    or jsonb_typeof(p_record->'machine_configuration_reference') not in ('string','null') then
    raise exception using errcode='22023',message='invalid manual classification';
  end if;
  if jsonb_array_length(p_record->'inputs') not between 1 and 50 or jsonb_array_length(p_record->'lines') not between 1 and 100
    or length(p_record->>'notes')>2000
    or length(p_record->>'machine_configuration_reference')>200
    or (p_record->>'machine_configuration_reference' is not null and length(trim(p_record->>'machine_configuration_reference')) not between 1 and 200)
    or (p_record->>'origin_business_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    or (p_record->>'classified_at') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    raise exception using errcode='22023',message='invalid manual classification';
  end if;
  -- Validate UUID strings before casting; no client actor/review claims exist.
  for item in select value from jsonb_each(p_record) where key in ('session_id','company_id','site_id','house_id','lot_id') loop
    if jsonb_typeof(item) is distinct from 'string' or (item#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception using errcode='22023',message='invalid manual classification';
    end if;
  end loop;
  begin
    session_value:=(p_record->>'session_id')::uuid;company_value:=(p_record->>'company_id')::uuid;
    site_value:=(p_record->>'site_id')::uuid;house_value:=(p_record->>'house_id')::uuid;lot_value:=(p_record->>'lot_id')::uuid;
    origin_date_value:=(p_record->>'origin_business_date')::date;classified_value:=(p_record->>'classified_at')::timestamptz;
  exception when others then raise exception using errcode='22023',message='invalid manual classification'; end;
  if origin_date_value::text<>p_record->>'origin_business_date'
    or to_char(classified_value at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>p_record->>'classified_at' then
    raise exception using errcode='22023',message='invalid manual classification';
  end if;
  if (classified_value at time zone 'America/Bogota')::date<origin_date_value then
    raise exception using errcode='22023',message='classification predates origin';
  end if;
  if not private.has_lot_role(company_value,site_value,house_value,lot_value,'warehouse') or not exists(
    select 1 from public.lots lot where lot.company_id=company_value and lot.site_id=site_value and lot.house_id=house_value and lot.id=lot_value
  ) then raise exception using errcode='42501',message='manual classification forbidden'; end if;

  for item in select value from jsonb_array_elements(p_record->'inputs') loop
    if jsonb_typeof(item) is distinct from 'object' then raise exception using errcode='22023',message='invalid classification input';end if;
    if (item-array['transfer_id','quantity_eggs'])<>'{}'::jsonb or not(item ?& array['transfer_id','quantity_eggs'])
      or jsonb_typeof(item->'transfer_id') is distinct from 'string'
      or (item->>'transfer_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'quantity_eggs') is distinct from 'number' then
      raise exception using errcode='22023',message='invalid classification input';end if;
    numeric_quantity:=(item->>'quantity_eggs')::numeric;
    if numeric_quantity<1 or numeric_quantity>2147483647 or trunc(numeric_quantity)<>numeric_quantity then
      raise exception using errcode='22023',message='invalid classification input';end if;
    item_id:=(item->>'transfer_id')::uuid;
    if item_id=any(input_ids) then raise exception using errcode='22023',message='duplicate classification input';end if;
    input_ids:=array_append(input_ids,item_id);incoming:=incoming+numeric_quantity::bigint;
  end loop;
  for item in select value from jsonb_array_elements(p_record->'lines') loop
    if jsonb_typeof(item) is distinct from 'object' then raise exception using errcode='22023',message='invalid classification line';end if;
    if (item-array['line_id','quantity_eggs','typology','condition','destination'])<>'{}'::jsonb
      or not(item ?& array['line_id','quantity_eggs','typology','condition','destination'])
      or jsonb_typeof(item->'line_id') is distinct from 'string'
      or (item->>'line_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'quantity_eggs') is distinct from 'number'
      or jsonb_typeof(item->'typology') is distinct from 'string' or item->>'typology' not in ('PIPO','C','B','A','AA','AAA','YUMBO','UNKNOWN')
      or jsonb_typeof(item->'condition') is distinct from 'string' or item->>'condition' not in ('NORMAL','DIRTY','BROKEN','YOLK')
      or jsonb_typeof(item->'destination') is distinct from 'string' or item->>'destination' not in ('PENDING','DISCARD')
      or (item->>'typology'='PIPO' and item->>'destination'<>'DISCARD') then
      raise exception using errcode='22023',message='invalid classification line';end if;
    numeric_quantity:=(item->>'quantity_eggs')::numeric;
    if numeric_quantity<1 or numeric_quantity>2147483647 or trunc(numeric_quantity)<>numeric_quantity then
      raise exception using errcode='22023',message='invalid classification line';end if;
    item_id:=(item->>'line_id')::uuid;
    if item_id=any(line_ids) then raise exception using errcode='22023',message='duplicate classification line';end if;
    line_ids:=array_append(line_ids,item_id);outgoing:=outgoing+numeric_quantity::bigint;
  end loop;
  if incoming<>outgoing then raise exception using errcode='23514',message='classification quantities do not balance';end if;

  perform pg_advisory_xact_lock(hashtextextended('manual-classification:'||session_value::text,0));
  select * into existing from public.manual_classification_sessions where session_id=session_value;
  if found then
    if existing.event_payload<>p_record or existing.recorded_by<>actor then
      raise exception using errcode='23505',message='classification id content conflict';end if;
    return private.manual_classification_receipt(existing,true);
  end if;
  -- Row locks are sorted, so overlapping multi-input sessions use one order.
  for transfer in select * from public.collection_transfers
    where company_id=company_value and site_id=site_value and house_id=house_value and lot_id=lot_value
      and origin_business_date=origin_date_value and transfer_id=any(input_ids)
    order by transfer_id for update loop
    found_inputs:=found_inputs+1;
    if transfer.status<>'received' then raise exception using errcode='55000',message='classification input not received';end if;
    select coalesce(sum(quantity_eggs),0)::bigint into used_quantity from public.manual_classification_inputs
      where company_id=company_value and transfer_id=transfer.transfer_id;
    select (value->>'quantity_eggs')::numeric into numeric_quantity from jsonb_array_elements(p_record->'inputs') where (value->>'transfer_id')::uuid=transfer.transfer_id;
    if numeric_quantity>transfer.received_quantity::bigint-used_quantity then
      raise exception using errcode='23514',message='classification exceeds received quantity';end if;
  end loop;
  if found_inputs<>cardinality(input_ids) then raise exception using errcode='42501',message='classification input origin mismatch';end if;

  insert into public.manual_classification_sessions(session_id,company_id,site_id,house_id,lot_id,origin_business_date,schema_version,
    processed_quantity,classified_at,machine_configuration_reference,notes,recorded_by,event_payload)
  values(session_value,company_value,site_value,house_value,lot_value,origin_date_value,1,incoming,classified_value,
    p_record->>'machine_configuration_reference',p_record->>'notes',actor,p_record) returning * into inserted;
  insert into public.manual_classification_inputs(company_id,site_id,house_id,lot_id,origin_business_date,session_id,transfer_id,input_index,quantity_eggs)
  select company_value,site_value,house_value,lot_value,origin_date_value,session_value,(value->>'transfer_id')::uuid,ordinality::smallint,(value->>'quantity_eggs')::numeric::integer
  from jsonb_array_elements(p_record->'inputs') with ordinality;
  insert into public.manual_classification_lines(line_id,company_id,session_id,line_index,quantity_eggs,typology,condition,destination)
  select (value->>'line_id')::uuid,company_value,session_value,ordinality::smallint,(value->>'quantity_eggs')::numeric::integer,value->>'typology',value->>'condition',value->>'destination'
  from jsonb_array_elements(p_record->'lines') with ordinality;
  return private.manual_classification_receipt(inserted,false);
end;
$$;
revoke all on function public.record_manual_classification(jsonb) from public,anon;
grant execute on function public.record_manual_classification(jsonb) to authenticated;

create function public.list_manual_classification_inputs(p_company_id uuid,p_business_date date,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rows_value jsonb;authorized_value boolean;
begin
  if p_business_date is null or p_offset is null or p_offset<0 or p_offset>100000 then
    raise exception using errcode='22023',message='invalid classification page';end if;
  select exists(select 1 from public.lots lot where lot.company_id=p_company_id and private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'warehouse')) into authorized_value;
  with consumed as (
    select company_id,transfer_id,sum(quantity_eggs)::bigint as quantity_classified from public.manual_classification_inputs
    where company_id=p_company_id group by company_id,transfer_id
  ), page as (
    select transfer.*,lot.code as lot_code,house.name as house_name,coalesce(consumed.quantity_classified,0)::bigint as quantity_classified,
      (transfer.received_quantity::bigint-coalesce(consumed.quantity_classified,0))::bigint as quantity_available,
      incident.incident_id,incident.status as incident_status
    from public.collection_transfers transfer
    join public.lots lot on lot.company_id=transfer.company_id and lot.id=transfer.lot_id
    join public.houses house on house.company_id=transfer.company_id and house.id=transfer.house_id
    left join consumed on consumed.company_id=transfer.company_id and consumed.transfer_id=transfer.transfer_id
    left join public.custody_incidents incident on incident.company_id=transfer.company_id and incident.transfer_id=transfer.transfer_id
    where transfer.company_id=p_company_id and transfer.origin_business_date=p_business_date and transfer.status='received'
      and private.has_lot_role(transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id,'warehouse')
    order by transfer.received_at,transfer.transfer_id limit 26 offset p_offset
  ) select coalesce(jsonb_agg(to_jsonb(page) order by page.received_at,page.transfer_id),'[]'::jsonb) into rows_value from page;
  return jsonb_build_object('authorized',authorized_value,'items',coalesce((select jsonb_agg(value order by ordinality)
    from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),
    'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end);
end;
$$;

create function public.get_manual_classification(p_company_id uuid,p_session_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare session public.manual_classification_sessions%rowtype;
begin
  select * into session from public.manual_classification_sessions where company_id=p_company_id and session_id=p_session_id;
  if not found then return null;end if;
  return jsonb_build_object('session',to_jsonb(session),
    'inputs',coalesce((select jsonb_agg(to_jsonb(input) order by input.input_index) from public.manual_classification_inputs input where input.company_id=p_company_id and input.session_id=p_session_id),'[]'::jsonb),
    'lines',coalesce((select jsonb_agg(to_jsonb(line) order by line.line_index) from public.manual_classification_lines line where line.company_id=p_company_id and line.session_id=p_session_id),'[]'::jsonb));
end;
$$;

create function public.list_manual_classifications(p_company_id uuid,p_business_date date,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rows_value jsonb;
begin
  if p_business_date is null or p_offset is null or p_offset<0 or p_offset>100000 then
    raise exception using errcode='22023',message='invalid classification page';end if;
  select coalesce(jsonb_agg(to_jsonb(page) order by page.recorded_at desc,page.session_id desc),'[]'::jsonb) into rows_value from(
    select session_id,company_id,site_id,house_id,lot_id,origin_business_date,processed_quantity,classified_at,recorded_at,recorded_by,review_status,configuration_status
    from public.manual_classification_sessions where company_id=p_company_id and origin_business_date=p_business_date
    order by recorded_at desc,session_id desc limit 26 offset p_offset
  )page;
  return jsonb_build_object('items',coalesce((select jsonb_agg(value order by ordinality)
    from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),
    'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end);
end;
$$;
revoke all on function public.list_manual_classification_inputs(uuid,date,integer),public.get_manual_classification(uuid,uuid),public.list_manual_classifications(uuid,date,integer) from public,anon;
grant execute on function public.list_manual_classification_inputs(uuid,date,integer),public.get_manual_classification(uuid,uuid),public.list_manual_classifications(uuid,date,integer) to authenticated;

comment on table public.manual_classification_sessions is 'Manual counts of machine output with unverified configuration reference and pending review; never a weight certificate, production correction or final reconciliation.';
comment on table public.manual_classification_inputs is 'Immutable client ledger of consumption from received transfers; scope/date FKs and sorted transfer locks prevent mixed origins or concurrent overconsumption.';
