-- DEV-007B: server-side registry for offline collection capability metadata.
-- This is not a token signer and resolving a row is not event acceptance.

create table public.offline_capture_grants (
  grant_id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  subject_user_id uuid not null,
  membership_id uuid not null,
  issued_by_user_id uuid not null references auth.users(id) on delete restrict,
  role_assignment_id uuid not null references public.role_assignments(id) on delete restrict,
  device_id uuid not null,
  site_id uuid not null,
  house_id uuid not null,
  lot_id uuid not null,
  permission text not null check (permission = 'collection.capture'),
  issued_at timestamptz not null,
  not_before timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  revoked_by_user_id uuid references auth.users(id) on delete restrict,
  revocation_reason text,
  foreign key (company_id, membership_id)
    references public.company_memberships(company_id, id) on delete restrict,
  foreign key (company_id, site_id, house_id, lot_id)
    references public.lots(company_id, site_id, house_id, id) on delete restrict,
  check (issued_by_user_id = subject_user_id),
  check (not_before >= issued_at),
  check (expires_at > not_before),
  check (expires_at <= issued_at + interval '24 hours'),
  check (
    (revoked_at is null and revoked_by_user_id is null and revocation_reason is null)
    or (
      revoked_at is not null
      and revoked_by_user_id is not null
      and revocation_reason is not null
      and length(trim(revocation_reason)) between 5 and 500
    )
  )
);

create index offline_capture_grants_company_subject_idx
  on public.offline_capture_grants(company_id, subject_user_id, issued_at desc);

alter table public.offline_capture_grants enable row level security;
alter table public.offline_capture_grants force row level security;
revoke all on public.offline_capture_grants from public, anon, authenticated, service_role;

create or replace function public.register_offline_capture_grant(
  p_company_id uuid,
  p_device_id uuid,
  p_site_id uuid,
  p_house_id uuid,
  p_lot_id uuid
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
  grant_id_value uuid;
begin
  if actor_id is null
     or not private.initial_access_complete()
     or p_company_id is null
     or p_device_id is null
     or p_site_id is null
     or p_house_id is null
     or p_lot_id is null
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

  expires_at_value := least(
    issued_at_value + interval '24 hours',
    coalesce(membership_valid_until_value, issued_at_value + interval '24 hours'),
    coalesce(assignment_valid_until_value, issued_at_value + interval '24 hours')
  );

  grant_id_value := gen_random_uuid();
  insert into public.offline_capture_grants (
    grant_id, company_id, subject_user_id, membership_id, issued_by_user_id,
    role_assignment_id, device_id, site_id, house_id, lot_id, permission,
    issued_at, not_before, expires_at
  ) values (
    grant_id_value, p_company_id, actor_id, membership_id_value, actor_id,
    role_assignment_id_value, p_device_id, p_site_id, p_house_id, p_lot_id,
    'collection.capture', issued_at_value, issued_at_value,
    expires_at_value
  );

  return jsonb_build_object(
    'grant_id', grant_id_value,
    'subject_user_id', actor_id,
    'company_id', p_company_id,
    'device_id', p_device_id,
    'site_id', p_site_id,
    'house_id', p_house_id,
    'lot_id', p_lot_id,
    'permission', 'collection.capture',
    'issued_at', issued_at_value,
    'not_before', issued_at_value,
    'expires_at', expires_at_value,
    'registry_status', 'registered',
    'signed_capability_issued', false
  );
end;
$$;

create or replace function public.revoke_offline_capture_grant(
  p_grant_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := (select auth.uid());
  grant_row public.offline_capture_grants%rowtype;
begin
  if actor_id is null
     or not private.initial_access_complete()
     or p_grant_id is null
     or p_reason is null
     or length(trim(p_reason)) not between 5 and 500 then
    raise exception using errcode = '22023', message = 'offline grant revocation invalid';
  end if;

  select * into grant_row
  from public.offline_capture_grants
  where grant_id = p_grant_id
  for update;

  if not found or not private.has_company_role(grant_row.company_id, 'director') then
    raise exception using errcode = '42501', message = 'offline grant revocation forbidden';
  end if;

  if grant_row.revoked_at is null then
    update public.offline_capture_grants
    set revoked_at = statement_timestamp(),
        revoked_by_user_id = actor_id,
        revocation_reason = trim(p_reason)
    where grant_id = p_grant_id
    returning * into grant_row;
  end if;

  return jsonb_build_object(
    'grant_id', grant_row.grant_id,
    'registry_status', 'revoked',
    'revoked_at', grant_row.revoked_at,
    'revoked_by_user_id', grant_row.revoked_by_user_id
  );
end;
$$;

create or replace function public.resolve_offline_capture_grant(
  p_grant_id uuid,
  p_company_id uuid,
  p_subject_user_id uuid,
  p_device_id uuid,
  p_site_id uuid,
  p_house_id uuid,
  p_lot_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  grant_row public.offline_capture_grants%rowtype;
  resolution text;
  checked_at timestamptz := statement_timestamp();
begin
  if auth.uid() is null
     or not private.initial_access_complete()
     or p_company_id is null
     or p_site_id is null
     or p_house_id is null
     or p_lot_id is null
     or not private.is_active_company_member(p_company_id) then
    raise exception using errcode = '42501', message = 'offline grant lookup forbidden';
  end if;
  if not private.can_read_lot(p_company_id, p_site_id, p_house_id, p_lot_id) then
    raise exception using errcode = '42501', message = 'offline grant lookup forbidden';
  end if;

  select * into grant_row
  from public.offline_capture_grants
  where grant_id = p_grant_id
    and company_id = p_company_id;

  if not found then
    resolution := 'not_found';
  elsif grant_row.subject_user_id is distinct from p_subject_user_id
     or grant_row.device_id is distinct from p_device_id
     or grant_row.site_id is distinct from p_site_id
     or grant_row.house_id is distinct from p_house_id
     or grant_row.lot_id is distinct from p_lot_id
     or grant_row.permission is distinct from 'collection.capture' then
    resolution := 'scope_mismatch';
  elsif grant_row.revoked_at is not null then
    resolution := 'revoked';
  elsif grant_row.not_before > checked_at then
    resolution := 'not_yet_valid';
  elsif grant_row.expires_at <= checked_at then
    resolution := 'expired';
  elsif not exists (
    select 1
    from public.companies company
    join public.company_memberships membership
      on membership.company_id = company.id
     and membership.user_id = grant_row.subject_user_id
    join public.role_assignments assignment
      on assignment.company_id = membership.company_id
     and assignment.membership_id = membership.id
    join public.sites site
      on site.company_id = company.id
     and site.id = grant_row.site_id
    join public.houses house
      on house.company_id = company.id
     and house.site_id = site.id
     and house.id = grant_row.house_id
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
      and membership.valid_from <= checked_at
      and (membership.valid_until is null or membership.valid_until > checked_at)
      and assignment.id = grant_row.role_assignment_id
      and grant_row.permission = 'collection.capture'
      and assignment.role_key = 'capture'
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > checked_at)
      and (assignment.site_id is null or assignment.site_id = grant_row.site_id)
      and (assignment.house_id is null or assignment.house_id = grant_row.house_id)
      and (assignment.lot_id is null or assignment.lot_id = grant_row.lot_id)
      and site.status = 'active'
      and house.status = 'active'
      and lot.status = 'active'
  ) then
    resolution := 'authorization_no_longer_current';
  else
    resolution := 'registry_current_unverified';
  end if;

  return jsonb_build_object(
    'grant_id', p_grant_id,
    'registry_status', resolution,
    'server_checked_at', checked_at,
    'authorizes_event', false
  );
end;
$$;

revoke all on function public.register_offline_capture_grant(uuid, uuid, uuid, uuid, uuid)
  from public, anon;
revoke all on function public.revoke_offline_capture_grant(uuid, text)
  from public, anon;
revoke all on function public.resolve_offline_capture_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.register_offline_capture_grant(uuid, uuid, uuid, uuid, uuid)
  to authenticated;
grant execute on function public.revoke_offline_capture_grant(uuid, text)
  to authenticated;
grant execute on function public.resolve_offline_capture_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid)
  to authenticated;

comment on table public.offline_capture_grants is
  'Server-side metadata registry for offline collection capabilities. It stores no signed token or secret; a row reference never proves event authorship.';
comment on function public.register_offline_capture_grant(uuid, uuid, uuid, uuid, uuid) is
  'Creates a 24-hour grant registry row for the authenticated user only when current capture scope and active lot are verified. Does not sign a capability.';
comment on function public.revoke_offline_capture_grant(uuid, text) is
  'Allows company Director to revoke a grant with an audit reason. Repeated revocation returns the original audit entry.';
comment on function public.resolve_offline_capture_grant(uuid, uuid, uuid, uuid, uuid, uuid, uuid) is
  'Returns a scoped registry status only. Even registry_current_unverified never accepts or authorizes an event; sync must verify cryptographic proof and preserve review states.';
