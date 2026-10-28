-- DEV-007C: bind grant issuance to a verified device-key registration request.
-- The API verifies the signed proof before calling this RPC; PostgreSQL still
-- rechecks session identity, current membership, role, and operational scope.

alter table public.offline_capture_grants
  add column device_key_thumbprint text,
  add column issuance_request_id uuid;

alter table public.offline_capture_grants
  add constraint offline_capture_grants_thumbprint_format
    check (device_key_thumbprint is null or device_key_thumbprint ~ '^[A-Za-z0-9_-]{43}$'),
  add constraint offline_capture_grants_request_id_unique
    unique (issuance_request_id);

create or replace function public.register_offline_capture_grant_v2(
  p_company_id uuid,
  p_device_id uuid,
  p_site_id uuid,
  p_house_id uuid,
  p_lot_id uuid,
  p_request_id uuid,
  p_device_key_thumbprint text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  membership_id_value uuid;
  role_assignment_id_value uuid;
  membership_valid_until_value timestamptz;
  assignment_valid_until_value timestamptz;
  issued_at_value timestamptz := statement_timestamp();
  expires_at_value timestamptz;
  grant_row public.offline_capture_grants%rowtype;
begin
  if actor_id is null
     or not private.initial_access_complete()
     or p_company_id is null
     or p_device_id is null
     or p_site_id is null
     or p_house_id is null
     or p_lot_id is null
     or p_request_id is null
     or p_device_key_thumbprint is null
     or p_device_key_thumbprint !~ '^[A-Za-z0-9_-]{43}$'
     or not private.can_capture_lot(p_company_id, p_site_id, p_house_id, p_lot_id)
     or not exists (
       select 1
       from public.lots lot
       join public.sites site
         on site.company_id = lot.company_id and site.id = lot.site_id
       join public.houses house
         on house.company_id = lot.company_id
        and house.site_id = lot.site_id
        and house.id = lot.house_id
       where lot.company_id = p_company_id
         and lot.site_id = p_site_id
         and lot.house_id = p_house_id
         and lot.id = p_lot_id
         and lot.status = 'active'
         and site.status = 'active'
         and house.status = 'active'
     ) then
    raise exception using errcode = '42501', message = 'offline grant registration forbidden';
  end if;

  select membership.id, assignment.id, membership.valid_until, assignment.valid_until
    into membership_id_value, role_assignment_id_value,
      membership_valid_until_value, assignment_valid_until_value
  from public.company_memberships membership
  join public.role_assignments assignment
    on assignment.company_id = membership.company_id
   and assignment.membership_id = membership.id
  where membership.company_id = p_company_id
    and membership.user_id = actor_id
    and membership.status = 'active'
    and membership.revoked_at is null
    and membership.valid_from <= issued_at_value
    and (membership.valid_until is null or membership.valid_until > issued_at_value)
    and assignment.role_key = 'capture'
    and assignment.revoked_at is null
    and (assignment.valid_until is null or assignment.valid_until > issued_at_value)
    and (assignment.site_id is null or assignment.site_id = p_site_id)
    and (assignment.house_id is null or assignment.house_id = p_house_id)
    and (assignment.lot_id is null or assignment.lot_id = p_lot_id)
  order by
    case
      when assignment.lot_id is not null then 3
      when assignment.house_id is not null then 2
      when assignment.site_id is not null then 1
      else 0
    end desc,
    assignment.granted_at desc,
    assignment.id
  limit 1;

  if membership_id_value is null or role_assignment_id_value is null then
    raise exception using errcode = '42501', message = 'offline grant registration forbidden';
  end if;

  -- A retry may return its original row only for the same authenticated actor,
  -- device, scope and key. Authorization above is deliberately rechecked first.
  select * into grant_row
  from public.offline_capture_grants
  where issuance_request_id = p_request_id
  for update;
  if found then
    if grant_row.subject_user_id is distinct from actor_id
       or grant_row.company_id is distinct from p_company_id
       or grant_row.device_id is distinct from p_device_id
       or grant_row.site_id is distinct from p_site_id
       or grant_row.house_id is distinct from p_house_id
       or grant_row.lot_id is distinct from p_lot_id
       or grant_row.device_key_thumbprint is distinct from p_device_key_thumbprint then
      raise exception using errcode = '22023', message = 'offline grant request conflict';
    end if;
    if grant_row.revoked_at is not null or grant_row.expires_at <= issued_at_value then
      raise exception using errcode = '42501', message = 'offline grant no longer issuable';
    end if;
    return private.grant_response(grant_row);
  end if;

  expires_at_value := least(
    issued_at_value + interval '24 hours',
    coalesce(membership_valid_until_value, issued_at_value + interval '24 hours'),
    coalesce(assignment_valid_until_value, issued_at_value + interval '24 hours')
  );

  insert into public.offline_capture_grants (
    company_id, subject_user_id, membership_id, issued_by_user_id,
    role_assignment_id, device_id, site_id, house_id, lot_id, permission,
    issued_at, not_before, expires_at, device_key_thumbprint, issuance_request_id
  ) values (
    p_company_id, actor_id, membership_id_value, actor_id,
    role_assignment_id_value, p_device_id, p_site_id, p_house_id, p_lot_id,
    'collection.capture', issued_at_value, issued_at_value, expires_at_value,
    p_device_key_thumbprint, p_request_id
  ) returning * into grant_row;

  return private.grant_response(grant_row);
exception
  when unique_violation then
    -- Concurrent idempotent retries race on the unique request ID. Re-read the
    -- winner and apply the identical conflict checks before returning it.
    select * into grant_row
    from public.offline_capture_grants
    where issuance_request_id = p_request_id;
    if not found
       or grant_row.subject_user_id is distinct from actor_id
       or grant_row.company_id is distinct from p_company_id
       or grant_row.device_id is distinct from p_device_id
       or grant_row.site_id is distinct from p_site_id
       or grant_row.house_id is distinct from p_house_id
       or grant_row.lot_id is distinct from p_lot_id
       or grant_row.device_key_thumbprint is distinct from p_device_key_thumbprint then
      raise exception using errcode = '22023', message = 'offline grant request conflict';
    end if;
    if grant_row.revoked_at is not null or grant_row.expires_at <= issued_at_value then
      raise exception using errcode = '42501', message = 'offline grant no longer issuable';
    end if;
    return private.grant_response(grant_row);
end;
$$;

revoke all on function public.register_offline_capture_grant_v2(uuid, uuid, uuid, uuid, uuid, uuid, text)
  from public, anon;
grant execute on function public.register_offline_capture_grant_v2(uuid, uuid, uuid, uuid, uuid, uuid, text)
  to authenticated;

create or replace function private.grant_response(grant_row public.offline_capture_grants)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'grant_id', grant_row.grant_id,
    'subject_user_id', grant_row.subject_user_id,
    'company_id', grant_row.company_id,
    'device_id', grant_row.device_id,
    'site_id', grant_row.site_id,
    'house_id', grant_row.house_id,
    'lot_id', grant_row.lot_id,
    'permission', grant_row.permission,
    'issued_at', grant_row.issued_at,
    'not_before', grant_row.not_before,
    'expires_at', grant_row.expires_at,
    'device_key_thumbprint', grant_row.device_key_thumbprint,
    'registry_status', case
      when grant_row.revoked_at is not null then 'revoked'
      else 'registered'
    end,
    'signed_capability_issued', false
  );
$$;

revoke all on function private.grant_response(public.offline_capture_grants)
  from public, anon, authenticated, service_role;

comment on function public.register_offline_capture_grant_v2(uuid, uuid, uuid, uuid, uuid, uuid, text) is
  'Registers an idempotent key-bound grant after current capture scope is checked. Caller must verify an ES256 device registration proof before calling; this RPC does not verify signatures or accept events.';
