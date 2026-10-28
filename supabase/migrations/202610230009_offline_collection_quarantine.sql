-- DEV-007D: preserve offline events that must not become canonical collection
-- records. The public gateway verifies device signatures before using the
-- backend-only quarantine writer.

create table public.offline_collection_quarantine (
  event_id uuid primary key,
  company_id uuid not null references public.companies(id) on delete restrict,
  site_id uuid not null,
  house_id uuid not null,
  lot_id uuid not null,
  business_date date not null,
  occurrence smallint not null check (occurrence between 1 and 3),
  event_payload jsonb not null,
  identity_binding jsonb not null,
  device_proof jsonb not null,
  received_by_user_id uuid not null references auth.users(id) on delete restrict,
  proof_status text not null check (proof_status in ('verified', 'invalid', 'unresolved')),
  grant_status text not null check (grant_status in (
    'registry_current_unverified', 'revoked', 'expired', 'not_yet_valid',
    'authorization_no_longer_current', 'not_found', 'scope_mismatch'
  )),
  quarantine_reason text not null check (quarantine_reason in (
    'proof_invalid', 'proof_scope_mismatch', 'grant_missing', 'grant_revoked',
    'grant_expired', 'grant_not_yet_valid', 'authorization_no_longer_current',
    'receiver_capture_forbidden', 'collection_occurrence_conflict',
    'collection_event_conflict'
  )),
  review_status text not null default 'review_required'
    check (review_status = 'review_required'),
  receipt_status text not null default 'received' check (receipt_status = 'received'),
  received_at timestamptz not null default statement_timestamp(),
  foreign key (company_id, site_id, house_id, lot_id)
    references public.lots(company_id, site_id, house_id, id) on delete restrict
);

create index offline_collection_quarantine_company_status_idx
  on public.offline_collection_quarantine(company_id, received_at desc);
create index offline_collection_quarantine_lot_date_idx
  on public.offline_collection_quarantine(company_id, lot_id, business_date desc);

alter table public.offline_collection_quarantine enable row level security;
alter table public.offline_collection_quarantine force row level security;
create policy offline_collection_quarantine_read_scoped_lot
  on public.offline_collection_quarantine for select to authenticated
  using ((select private.can_read_lot(company_id, site_id, house_id, lot_id)));
revoke all on public.offline_collection_quarantine from public, anon, authenticated, service_role;
grant select on public.offline_collection_quarantine to authenticated;

create or replace function public.resolve_offline_capture_grant_v2(
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
  result jsonb;
  grant_row public.offline_capture_grants%rowtype;
begin
  result := public.resolve_offline_capture_grant(
    p_grant_id, p_company_id, p_subject_user_id, p_device_id,
    p_site_id, p_house_id, p_lot_id
  );
  if result->>'registry_status' in ('not_found', 'scope_mismatch') then
    return result;
  end if;
  select * into grant_row
  from public.offline_capture_grants
  where grant_id = p_grant_id and company_id = p_company_id;
  if not found then
    return result;
  end if;
  return result || jsonb_build_object(
    'subject_user_id', grant_row.subject_user_id,
    'company_id', grant_row.company_id,
    'device_id', grant_row.device_id,
    'site_id', grant_row.site_id,
    'house_id', grant_row.house_id,
    'lot_id', grant_row.lot_id,
    'permission', grant_row.permission,
    'device_key_thumbprint', grant_row.device_key_thumbprint,
    'issued_at', grant_row.issued_at,
    'not_before', grant_row.not_before,
    'expires_at', grant_row.expires_at
  );
end;
$$;

revoke all on function public.resolve_offline_capture_grant_v2(uuid, uuid, uuid, uuid, uuid, uuid, uuid)
  from public, anon;
grant execute on function public.resolve_offline_capture_grant_v2(uuid, uuid, uuid, uuid, uuid, uuid, uuid)
  to authenticated;

create or replace function public.quarantine_offline_collection_event(
  p_event jsonb,
  p_identity_binding jsonb,
  p_device_proof jsonb,
  p_received_by_user_id uuid,
  p_proof_status text,
  p_grant_status text,
  p_quarantine_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  event_id_value uuid;
  company_id_value uuid;
  site_id_value uuid;
  house_id_value uuid;
  lot_id_value uuid;
  business_date_value date;
  occurrence_value smallint;
  quarantine_row public.offline_collection_quarantine%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     or p_received_by_user_id is null
     or p_proof_status not in ('verified', 'invalid', 'unresolved')
     or p_grant_status not in (
       'registry_current_unverified', 'revoked', 'expired', 'not_yet_valid',
       'authorization_no_longer_current', 'not_found', 'scope_mismatch'
     )
     or p_quarantine_reason not in (
       'proof_invalid', 'proof_scope_mismatch', 'grant_missing', 'grant_revoked',
       'grant_expired', 'grant_not_yet_valid', 'authorization_no_longer_current',
       'receiver_capture_forbidden', 'collection_occurrence_conflict',
       'collection_event_conflict'
     )
     or jsonb_typeof(p_event) <> 'object'
     or jsonb_typeof(p_identity_binding) <> 'object'
     or jsonb_typeof(p_device_proof) <> 'object' then
    raise exception using errcode = '22023', message = 'offline quarantine request invalid';
  end if;

  begin
    event_id_value := (p_event->>'event_id')::uuid;
    company_id_value := (p_event->>'company_id')::uuid;
    site_id_value := (p_event->>'site_id')::uuid;
    house_id_value := (p_event->>'house_id')::uuid;
    lot_id_value := (p_event->>'lot_id')::uuid;
    business_date_value := (p_event->>'business_date')::date;
    occurrence_value := (p_event->>'occurrence')::smallint;
  exception when others then
    raise exception using errcode = '22023', message = 'offline quarantine request invalid';
  end;

  if p_event->>'schema_version' <> '2'
     or occurrence_value not between 1 and 3
     or p_identity_binding->>'grant_id' is null
     or p_identity_binding->>'subject_user_id' is null
     or p_device_proof->>'format' <> 'tamago.offline-device-event-proof'
     or p_device_proof->>'schema_version' <> '1'
     or not exists (
       select 1
       from public.company_memberships membership
       join public.companies company on company.id = membership.company_id
       join public.role_assignments assignment
         on assignment.company_id = membership.company_id
        and assignment.membership_id = membership.id
       where membership.company_id = company_id_value
         and company.status = 'active'
         and membership.user_id = p_received_by_user_id
         and membership.status = 'active'
         and membership.revoked_at is null
         and membership.valid_from <= statement_timestamp()
         and (membership.valid_until is null or membership.valid_until > statement_timestamp())
         and assignment.role_key in ('capture', 'warehouse', 'director', 'admin')
         and assignment.revoked_at is null
         and (assignment.valid_until is null or assignment.valid_until > statement_timestamp())
         and (assignment.site_id is null or assignment.site_id = site_id_value)
         and (assignment.house_id is null or assignment.house_id = house_id_value)
         and (assignment.lot_id is null or assignment.lot_id = lot_id_value)
     ) then
    raise exception using errcode = '42501', message = 'offline quarantine forbidden';
  end if;

  insert into public.offline_collection_quarantine (
    event_id, company_id, site_id, house_id, lot_id, business_date, occurrence,
    event_payload, identity_binding, device_proof, received_by_user_id,
    proof_status, grant_status, quarantine_reason
  ) values (
    event_id_value, company_id_value, site_id_value, house_id_value, lot_id_value,
    business_date_value, occurrence_value, p_event, p_identity_binding,
    p_device_proof, p_received_by_user_id, p_proof_status, p_grant_status,
    p_quarantine_reason
  ) on conflict (event_id) do nothing returning * into quarantine_row;

  if found then
    return jsonb_build_object(
      'event_id', quarantine_row.event_id,
      'receipt_status', quarantine_row.receipt_status,
      'review_status', quarantine_row.review_status,
      'registry_status', quarantine_row.grant_status,
      'proof_status', quarantine_row.proof_status,
      'quarantine_reason', quarantine_row.quarantine_reason,
      'received_at', quarantine_row.received_at,
      'duplicate', false
    );
  end if;

  select * into quarantine_row
  from public.offline_collection_quarantine
  where event_id = event_id_value;
  if found
     and quarantine_row.event_payload = p_event
     and quarantine_row.identity_binding = p_identity_binding
     and quarantine_row.device_proof = p_device_proof
     and quarantine_row.received_by_user_id = p_received_by_user_id then
    return jsonb_build_object(
      'event_id', quarantine_row.event_id,
      'receipt_status', quarantine_row.receipt_status,
      'review_status', quarantine_row.review_status,
      'registry_status', quarantine_row.grant_status,
      'proof_status', quarantine_row.proof_status,
      'quarantine_reason', quarantine_row.quarantine_reason,
      'received_at', quarantine_row.received_at,
      'duplicate', true
    );
  end if;
  raise exception using errcode = '22023', message = 'offline quarantine event conflict';
end;
$$;

revoke all on function public.quarantine_offline_collection_event(jsonb, jsonb, jsonb, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.quarantine_offline_collection_event(jsonb, jsonb, jsonb, uuid, text, text, text)
  to service_role;

comment on table public.offline_collection_quarantine is
  'Append-only source envelope for offline events that cannot be accepted as canonical collection records. Receipt is technical only; all rows require investigation/review.';
comment on function public.quarantine_offline_collection_event(jsonb, jsonb, jsonb, uuid, text, text, text) is
  'Backend-only idempotent write. Rechecks receiver scope and preserves the original event, identity binding, device proof and reason without accepting or adjusting production.';
