-- PostgreSQL does not expose jsonb_object_length on all supported versions.
-- Keep the strict exact-key contract with the portable jsonb ?& operator.
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
