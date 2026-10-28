-- DEV-005 local vertical slice: authenticated, company-scoped receipt of
-- collection events. Receipt is technical acceptance only; review remains open.

-- P03 allowed only one non-null scope field even though its own constraints
-- describe hierarchical site/house/lot scopes. It also used an index that
-- prevented a member from receiving the same role in multiple scopes.
do $$
declare constraint_record record;
begin
  for constraint_record in
    select conname
    from pg_constraint
    where conrelid = 'public.role_assignments'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) like '%num_nonnulls%'
  loop
    execute format('alter table public.role_assignments drop constraint %I', constraint_record.conname);
  end loop;
end;
$$;

alter table public.role_assignments
  add constraint role_assignments_scope_hierarchy_check
  check (
    (site_id is null and house_id is null and lot_id is null)
    or (site_id is not null and house_id is null and lot_id is null)
    or (site_id is not null and house_id is not null and lot_id is null)
    or (site_id is not null and house_id is not null and lot_id is not null)
  );

drop index if exists public.role_assignments_one_active_global_role_idx;
create unique index role_assignments_active_scope_idx
  on public.role_assignments(company_id, membership_id, role_key, site_id, house_id, lot_id)
  nulls not distinct
  where revoked_at is null;

create or replace function private.can_capture_lot(
  target_company_id uuid,
  target_site_id uuid,
  target_house_id uuid,
  target_lot_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.initial_access_complete() and exists (
    select 1
    from public.company_memberships membership
    join public.companies company on company.id = membership.company_id
    join public.role_assignments assignment
      on assignment.company_id = membership.company_id
      and assignment.membership_id = membership.id
    where membership.company_id = target_company_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now()
      and (membership.valid_until is null or membership.valid_until > now())
      and company.status = 'active'
      and assignment.role_key = 'capture'
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now())
      and (assignment.site_id is null or assignment.site_id = target_site_id)
      and (assignment.house_id is null or assignment.house_id = target_house_id)
      and (assignment.lot_id is null or assignment.lot_id = target_lot_id)
  );
$$;

revoke all on function private.can_capture_lot(uuid, uuid, uuid, uuid) from public, anon;
grant execute on function private.can_capture_lot(uuid, uuid, uuid, uuid) to authenticated;

create table public.collection_events (
  event_id uuid primary key,
  company_id uuid not null,
  site_id uuid not null,
  house_id uuid not null,
  lot_id uuid not null,
  business_date date not null,
  occurrence smallint not null check (occurrence between 1 and 3),
  quantity_eggs integer not null check (quantity_eggs >= 0),
  occurred_at timestamptz not null,
  captured_at timestamptz not null,
  actor_declared_id text not null check (length(trim(actor_declared_id)) between 1 and 120),
  device_id uuid not null,
  captured_by uuid not null references auth.users(id) on delete restrict,
  receipt_status text not null default 'received' check (receipt_status = 'received'),
  review_status text not null default 'pending' check (review_status = 'pending'),
  received_at timestamptz not null default now(),
  unique (company_id, lot_id, business_date, occurrence),
  foreign key (company_id, site_id, house_id, lot_id)
    references public.lots(company_id, site_id, house_id, id) on delete restrict,
  check ((occurred_at at time zone 'America/Bogota')::date = business_date)
);

create index collection_events_company_date_idx
  on public.collection_events(company_id, business_date desc, lot_id);

alter table public.collection_events enable row level security;
alter table public.collection_events force row level security;
create policy collection_events_read_scoped_lot
  on public.collection_events for select to authenticated
  using ((select private.can_read_lot(company_id, site_id, house_id, lot_id)));

revoke all on public.collection_events from public, anon, authenticated;
grant select on public.collection_events to authenticated;

create or replace function public.receive_collection_event(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  inserted_event public.collection_events%rowtype;
  existing_event public.collection_events%rowtype;
  event_id_value uuid;
  company_id_value uuid;
  site_id_value uuid;
  house_id_value uuid;
  lot_id_value uuid;
  business_date_value date;
  occurrence_value smallint;
  quantity_value integer;
  occurred_at_value timestamptz;
  captured_at_value timestamptz;
  actor_declared_value text;
  device_id_value uuid;
begin
  if actor_id is null or not private.initial_access_complete() then
    raise exception using errcode = '42501', message = 'collection receipt forbidden';
  end if;
  if p_event is null or jsonb_typeof(p_event) <> 'object'
     or (p_event - array[
       'schema_version','event_id','company_id','site_id','house_id','lot_id',
       'business_date','occurrence','quantity_eggs','occurred_at','captured_at',
       'actor_declared_id','device_id'
     ]) <> '{}'::jsonb
     or not (p_event ?& array[
       'schema_version','event_id','company_id','site_id','house_id','lot_id',
       'business_date','occurrence','quantity_eggs','occurred_at','captured_at',
       'actor_declared_id','device_id'
     ])
     or p_event->>'schema_version' <> '2' then
    raise exception using errcode = '22023', message = 'invalid collection event';
  end if;

  begin
    event_id_value := (p_event->>'event_id')::uuid;
    company_id_value := (p_event->>'company_id')::uuid;
    site_id_value := (p_event->>'site_id')::uuid;
    house_id_value := (p_event->>'house_id')::uuid;
    lot_id_value := (p_event->>'lot_id')::uuid;
    business_date_value := (p_event->>'business_date')::date;
    occurrence_value := (p_event->>'occurrence')::smallint;
    quantity_value := (p_event->>'quantity_eggs')::integer;
    occurred_at_value := (p_event->>'occurred_at')::timestamptz;
    captured_at_value := (p_event->>'captured_at')::timestamptz;
    actor_declared_value := p_event->>'actor_declared_id';
    device_id_value := (p_event->>'device_id')::uuid;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid collection event';
  end;

  if jsonb_typeof(p_event->'schema_version') <> 'number'
     or jsonb_typeof(p_event->'occurrence') <> 'number'
     or jsonb_typeof(p_event->'quantity_eggs') <> 'number'
     or jsonb_typeof(p_event->'business_date') <> 'string'
     or jsonb_typeof(p_event->'occurred_at') <> 'string'
     or jsonb_typeof(p_event->'captured_at') <> 'string'
     or jsonb_typeof(p_event->'actor_declared_id') <> 'string'
     or jsonb_typeof(p_event->'device_id') <> 'string'
     or occurrence_value not between 1 and 3
     or quantity_value < 0
     or length(trim(actor_declared_value)) not between 1 and 120
     or (occurred_at_value at time zone 'America/Bogota')::date <> business_date_value then
    raise exception using errcode = '22023', message = 'invalid collection event';
  end if;

  if not exists (
    select 1 from public.lots lot
    where lot.company_id = company_id_value
      and lot.site_id = site_id_value
      and lot.house_id = house_id_value
      and lot.id = lot_id_value
      and lot.status = 'active'
  ) or not private.can_capture_lot(company_id_value, site_id_value, house_id_value, lot_id_value) then
    raise exception using errcode = '42501', message = 'collection receipt forbidden';
  end if;

  insert into public.collection_events (
    event_id, company_id, site_id, house_id, lot_id, business_date, occurrence,
    quantity_eggs, occurred_at, captured_at, actor_declared_id, device_id, captured_by
  ) values (
    event_id_value, company_id_value, site_id_value, house_id_value, lot_id_value,
    business_date_value, occurrence_value, quantity_value, occurred_at_value,
    captured_at_value, actor_declared_value, device_id_value, actor_id
  ) on conflict (event_id) do nothing returning * into inserted_event;

  if found then
    return jsonb_build_object(
      'event_id', inserted_event.event_id,
      'receipt_status', inserted_event.receipt_status,
      'review_status', inserted_event.review_status,
      'received_at', inserted_event.received_at,
      'duplicate', false
    );
  end if;

  select * into existing_event
  from public.collection_events
  where event_id = event_id_value;
  if found then
    if existing_event.company_id = company_id_value
       and existing_event.site_id = site_id_value
       and existing_event.house_id = house_id_value
       and existing_event.lot_id = lot_id_value
       and existing_event.business_date = business_date_value
       and existing_event.occurrence = occurrence_value
       and existing_event.quantity_eggs = quantity_value
       and existing_event.occurred_at = occurred_at_value
       and existing_event.captured_at = captured_at_value
       and existing_event.actor_declared_id = actor_declared_value
       and existing_event.device_id = device_id_value then
      return jsonb_build_object(
        'event_id', existing_event.event_id,
        'receipt_status', existing_event.receipt_status,
        'review_status', existing_event.review_status,
        'received_at', existing_event.received_at,
        'duplicate', true
      );
    end if;
    raise exception using errcode = '22023', message = 'collection event id content conflict';
  end if;

  raise exception using errcode = '23505', message = 'collection occurrence conflict';
end;
$$;

revoke all on function public.receive_collection_event(jsonb) from public, anon;
grant execute on function public.receive_collection_event(jsonb) to authenticated;

comment on table public.collection_events is
  'Authenticated receipt of collection events. A receipt is not operational review or approval.';
comment on function public.receive_collection_event(jsonb) is
  'Receives schema v2 collection events for an active lot within the authenticated capture scope; derives captured_by from auth.uid() and is idempotent by event_id and content.';
