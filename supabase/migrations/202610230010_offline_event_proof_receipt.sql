-- DEV-007D: preserve the capture identity and cryptographic proof atomically
-- with the canonical collection row. Only the trusted local gateway calls this.

alter table public.collection_events
  add column offline_grant_id uuid references public.offline_capture_grants(grant_id) on delete restrict,
  add column capture_subject_id uuid references auth.users(id) on delete restrict,
  add column device_proof jsonb,
  add constraint collection_events_offline_binding_complete check (
    (offline_grant_id is null and capture_subject_id is null and device_proof is null)
    or (
      offline_grant_id is not null
      and capture_subject_id is not null
      and jsonb_typeof(device_proof) = 'object'
    )
  );

create or replace function public.receive_offline_collection_event(
  p_event jsonb,
  p_grant_id uuid,
  p_subject_user_id uuid,
  p_device_proof jsonb,
  p_received_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  grant_row public.offline_capture_grants%rowtype;
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
  now_value timestamptz := statement_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_grant_id is null
     or p_subject_user_id is null
     or p_received_by_user_id is null
     or jsonb_typeof(p_event) <> 'object'
     or jsonb_typeof(p_device_proof) <> 'object'
     or p_device_proof->>'format' <> 'tamago.offline-device-event-proof'
     or p_device_proof->>'schema_version' <> '1'
     or length(coalesce(p_device_proof->>'jws', '')) not between 1 and 8192 then
    raise exception using errcode = '22023', message = 'offline collection receipt invalid';
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
    raise exception using errcode = '22023', message = 'offline collection receipt invalid';
  end;

  if p_event->>'schema_version' <> '2'
     or p_event - array[
       'schema_version','event_id','company_id','site_id','house_id','lot_id',
       'business_date','occurrence','quantity_eggs','occurred_at','captured_at',
       'actor_declared_id','device_id'
     ] <> '{}'::jsonb
     or not (p_event ?& array[
       'schema_version','event_id','company_id','site_id','house_id','lot_id',
       'business_date','occurrence','quantity_eggs','occurred_at','captured_at',
       'actor_declared_id','device_id'
     ])
     or occurrence_value not between 1 and 3
     or quantity_value < 0 then
    raise exception using errcode = '22023', message = 'offline collection receipt invalid';
  end if;

  -- The device ID is bound inside the signed JWS, so SQL cannot parse it from
  -- the compact token. The gateway verifies it cryptographically; the database
  -- repeats the trusted registry binding below.
  if actor_declared_value is distinct from p_subject_user_id::text
     or occurrence_value not between 1 and 3
     or quantity_value < 0
     or length(trim(actor_declared_value)) not between 1 and 120
     or (occurred_at_value at time zone 'America/Bogota')::date <> business_date_value then
    raise exception using errcode = '22023', message = 'offline collection receipt invalid';
  end if;

  select * into grant_row
  from public.offline_capture_grants
  where grant_id = p_grant_id
  for share;
  if not found
     or grant_row.company_id is distinct from company_id_value
     or grant_row.subject_user_id is distinct from p_subject_user_id
     or grant_row.device_id is distinct from device_id_value
     or grant_row.site_id is distinct from site_id_value
     or grant_row.house_id is distinct from house_id_value
     or grant_row.lot_id is distinct from lot_id_value
     or grant_row.permission is distinct from 'collection.capture'
     or grant_row.device_key_thumbprint is null
     or grant_row.revoked_at is not null
     or grant_row.not_before > now_value
     or grant_row.expires_at <= now_value then
    raise exception using errcode = '42501', message = 'offline collection authorization not current';
  end if;

  if not exists (
    select 1
    from public.companies company
    join public.company_memberships membership
      on membership.company_id = company.id
     and membership.user_id = grant_row.subject_user_id
    join public.role_assignments assignment
      on assignment.company_id = membership.company_id
     and assignment.membership_id = membership.id
    join public.lots lot
      on lot.company_id = company.id
     and lot.site_id = grant_row.site_id
     and lot.house_id = grant_row.house_id
     and lot.id = grant_row.lot_id
    where company.id = grant_row.company_id
      and company.status = 'active'
      and membership.id = grant_row.membership_id
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now_value
      and (membership.valid_until is null or membership.valid_until > now_value)
      and assignment.id = grant_row.role_assignment_id
      and assignment.role_key = 'capture'
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now_value)
      and (assignment.site_id is null or assignment.site_id = grant_row.site_id)
      and (assignment.house_id is null or assignment.house_id = grant_row.house_id)
      and (assignment.lot_id is null or assignment.lot_id = grant_row.lot_id)
      and lot.status = 'active'
  ) or not exists (
    select 1
    from public.company_memberships membership
    join public.role_assignments assignment
      on assignment.company_id = membership.company_id
     and assignment.membership_id = membership.id
    where membership.company_id = company_id_value
      and membership.user_id = p_received_by_user_id
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now_value
      and (membership.valid_until is null or membership.valid_until > now_value)
      and assignment.role_key in ('capture', 'warehouse', 'director', 'admin')
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now_value)
      and (assignment.site_id is null or assignment.site_id = site_id_value)
      and (assignment.house_id is null or assignment.house_id = house_id_value)
      and (assignment.lot_id is null or assignment.lot_id = lot_id_value)
  ) then
    raise exception using errcode = '42501', message = 'offline collection authorization not current';
  end if;

  insert into public.collection_events (
    event_id, company_id, site_id, house_id, lot_id, business_date, occurrence,
    quantity_eggs, occurred_at, captured_at, actor_declared_id, device_id,
    captured_by, offline_grant_id, capture_subject_id, device_proof
  ) values (
    event_id_value, company_id_value, site_id_value, house_id_value, lot_id_value,
    business_date_value, occurrence_value, quantity_value, occurred_at_value,
    captured_at_value, actor_declared_value, device_id_value, p_received_by_user_id,
    p_grant_id, p_subject_user_id, p_device_proof
  ) on conflict (event_id) do nothing returning * into inserted_event;

  if found then
    return jsonb_build_object(
      'event_id', inserted_event.event_id,
      'receipt_status', inserted_event.receipt_status,
      'review_status', inserted_event.review_status,
      'received_at', inserted_event.received_at,
      'identity_status', 'verified',
      'synchronization_user_id', inserted_event.captured_by,
      'capture_subject_id', inserted_event.capture_subject_id,
      'grant_id', inserted_event.offline_grant_id,
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
       and existing_event.device_id = device_id_value
       and existing_event.captured_by = p_received_by_user_id
       and existing_event.offline_grant_id = p_grant_id
       and existing_event.capture_subject_id = p_subject_user_id
       and existing_event.device_proof = p_device_proof then
      return jsonb_build_object(
        'event_id', existing_event.event_id,
        'receipt_status', existing_event.receipt_status,
        'review_status', existing_event.review_status,
        'received_at', existing_event.received_at,
        'identity_status', 'verified',
        'synchronization_user_id', existing_event.captured_by,
        'capture_subject_id', existing_event.capture_subject_id,
        'grant_id', existing_event.offline_grant_id,
        'duplicate', true
      );
    end if;
    raise exception using errcode = '22023', message = 'offline collection event content conflict';
  end if;
  raise exception using errcode = '23505', message = 'offline collection occurrence conflict';
end;
$$;

revoke all on function public.receive_offline_collection_event(jsonb, uuid, uuid, jsonb, uuid)
  from public, anon, authenticated;
grant execute on function public.receive_offline_collection_event(jsonb, uuid, uuid, jsonb, uuid)
  to service_role;

comment on function public.receive_offline_collection_event(jsonb, uuid, uuid, jsonb, uuid) is
  'Backend-only atomic receipt of a gateway-verified offline event. It rechecks grant/current scope, derives sender from the session validated by the gateway, preserves capture subject and signed proof, and leaves operational review pending.';
