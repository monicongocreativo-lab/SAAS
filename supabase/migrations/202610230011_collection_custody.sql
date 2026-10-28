-- DEV-009A: physical movement and investigation of daily egg-origin custody.
-- This records custody only; it never mutates collection totals or inventory.

create or replace function private.has_lot_role(
  target_company_id uuid,
  target_site_id uuid,
  target_house_id uuid,
  target_lot_id uuid,
  required_role text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.company_memberships membership
    join public.companies company on company.id = membership.company_id
    join public.role_assignments assignment
      on assignment.company_id = membership.company_id
      and assignment.membership_id = membership.id
    where private.initial_access_complete()
      and membership.company_id = target_company_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now()
      and (membership.valid_until is null or membership.valid_until > now())
      and company.status = 'active'
      and assignment.role_key = required_role
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now())
      and (assignment.site_id is null or assignment.site_id = target_site_id)
      and (assignment.house_id is null or assignment.house_id = target_house_id)
      and (assignment.lot_id is null or assignment.lot_id = target_lot_id)
  );
$$;

revoke all on function private.has_lot_role(uuid, uuid, uuid, uuid, text) from public, anon;
grant execute on function private.has_lot_role(uuid, uuid, uuid, uuid, text) to authenticated;

create table public.collection_transfers (
  transfer_id uuid primary key,
  company_id uuid not null,
  site_id uuid not null,
  house_id uuid not null,
  lot_id uuid not null,
  origin_business_date date not null,
  quantity_sent integer not null check (quantity_sent > 0),
  sent_from text not null check (length(trim(sent_from)) between 1 and 160),
  sent_to text not null check (length(trim(sent_to)) between 1 and 160),
  sent_by uuid not null references auth.users(id) on delete restrict,
  sent_at timestamptz not null,
  received_quantity integer check (received_quantity >= 0),
  received_at_location text check (received_at_location is null or length(trim(received_at_location)) between 1 and 160),
  received_by uuid references auth.users(id) on delete restrict,
  received_at timestamptz,
  receiver_note text check (receiver_note is null or length(receiver_note) <= 2000),
  status text not null default 'dispatched' check (status in ('dispatched', 'received')),
  created_at timestamptz not null default now(),
  unique (company_id, transfer_id),
  foreign key (company_id, site_id, house_id, lot_id)
    references public.lots(company_id, site_id, house_id, id) on delete restrict,
  check (
    (status = 'dispatched' and received_quantity is null and received_at_location is null and received_by is null and received_at is null)
    or (status = 'received' and received_quantity is not null and received_at_location is not null and received_by is not null and received_at is not null)
  )
);

create index collection_transfers_origin_idx
  on public.collection_transfers(company_id, lot_id, origin_business_date, sent_at);

create table public.custody_incidents (
  incident_id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  transfer_id uuid not null,
  quantity_difference integer not null check (quantity_difference <> 0),
  status text not null default 'open'
    check (status in ('open', 'investigating', 'submitted_to_direction')),
  opened_at timestamptz not null default now(),
  opened_by uuid not null references auth.users(id) on delete restrict,
  investigation_summary text check (investigation_summary is null or length(investigation_summary) <= 4000),
  submitted_at timestamptz,
  submitted_by uuid references auth.users(id) on delete restrict,
  unique (transfer_id),
  unique (company_id, incident_id),
  foreign key (company_id, transfer_id)
    references public.collection_transfers(company_id, transfer_id) on delete restrict,
  check (
    (status = 'submitted_to_direction' and submitted_at is not null and submitted_by is not null and investigation_summary is not null)
    or (status <> 'submitted_to_direction' and submitted_at is null and submitted_by is null)
  )
);

create table public.custody_incident_evidence (
  evidence_id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  incident_id uuid not null,
  evidence_kind text not null check (evidence_kind in (
    'sender_statement', 'origin_card', 'count_record', 'transfer_note', 'photo_reference', 'other', 'missing'
  )),
  reference text check (reference is null or length(reference) <= 500),
  notes text not null check (length(trim(notes)) between 1 and 2000),
  recorded_by uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default now(),
  foreign key (company_id, incident_id)
    references public.custody_incidents(company_id, incident_id) on delete restrict
);

create index custody_incident_evidence_timeline_idx
  on public.custody_incident_evidence(company_id, incident_id, recorded_at, evidence_id);

alter table public.collection_transfers enable row level security;
alter table public.collection_transfers force row level security;
alter table public.custody_incidents enable row level security;
alter table public.custody_incidents force row level security;
alter table public.custody_incident_evidence enable row level security;
alter table public.custody_incident_evidence force row level security;

create policy collection_transfers_read_scope
  on public.collection_transfers for select to authenticated
  using (
    private.has_lot_role(company_id, site_id, house_id, lot_id, 'capture')
    or private.has_lot_role(company_id, site_id, house_id, lot_id, 'transport')
    or private.has_lot_role(company_id, site_id, house_id, lot_id, 'warehouse')
    or private.has_lot_role(company_id, site_id, house_id, lot_id, 'director')
  );
create policy custody_incidents_read_scope
  on public.custody_incidents for select to authenticated
  using (exists (
    select 1 from public.collection_transfers transfer
    where transfer.company_id = custody_incidents.company_id
      and transfer.transfer_id = custody_incidents.transfer_id
  ));
create policy custody_evidence_read_scope
  on public.custody_incident_evidence for select to authenticated
  using (exists (
    select 1 from public.custody_incidents incident
    where incident.company_id = custody_incident_evidence.company_id
      and incident.incident_id = custody_incident_evidence.incident_id
  ));

revoke all on public.collection_transfers, public.custody_incidents, public.custody_incident_evidence from public, anon, authenticated;
grant select on public.collection_transfers, public.custody_incidents, public.custody_incident_evidence to authenticated;

create or replace function public.dispatch_collection_transfer(p_transfer jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  transfer_id_value uuid;
  company_id_value uuid;
  site_id_value uuid;
  house_id_value uuid;
  lot_id_value uuid;
  origin_date_value date;
  quantity_value integer;
  sent_from_value text;
  sent_to_value text;
  inserted public.collection_transfers%rowtype;
  existing public.collection_transfers%rowtype;
  collected integer;
  previously_sent integer;
begin
  if actor is null or jsonb_typeof(p_transfer) <> 'object'
     or (p_transfer - array['transfer_id','company_id','site_id','house_id','lot_id','origin_business_date','quantity_sent','sent_from','sent_to','sent_at']) <> '{}'::jsonb
     or not (p_transfer ?& array['transfer_id','company_id','site_id','house_id','lot_id','origin_business_date','quantity_sent','sent_from','sent_to','sent_at']) then
    raise exception using errcode = '22023', message = 'invalid custody transfer';
  end if;
  begin
    transfer_id_value := (p_transfer->>'transfer_id')::uuid;
    company_id_value := (p_transfer->>'company_id')::uuid;
    site_id_value := (p_transfer->>'site_id')::uuid;
    house_id_value := (p_transfer->>'house_id')::uuid;
    lot_id_value := (p_transfer->>'lot_id')::uuid;
    origin_date_value := (p_transfer->>'origin_business_date')::date;
    quantity_value := (p_transfer->>'quantity_sent')::integer;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid custody transfer';
  end;
  sent_from_value := p_transfer->>'sent_from';
  sent_to_value := p_transfer->>'sent_to';
  if quantity_value <= 0 or length(trim(sent_from_value)) not between 1 and 160
     or length(trim(sent_to_value)) not between 1 and 160
     or not private.has_lot_role(company_id_value, site_id_value, house_id_value, lot_id_value, 'capture')
        and not private.has_lot_role(company_id_value, site_id_value, house_id_value, lot_id_value, 'transport') then
    raise exception using errcode = '42501', message = 'custody dispatch forbidden';
  end if;

  select * into existing from public.collection_transfers where transfer_id = transfer_id_value;
  if found then
    if existing.company_id = company_id_value and existing.site_id = site_id_value
       and existing.house_id = house_id_value and existing.lot_id = lot_id_value
       and existing.origin_business_date = origin_date_value and existing.quantity_sent = quantity_value
       and existing.sent_from = sent_from_value and existing.sent_to = sent_to_value
       and existing.sent_by = actor and existing.sent_at = (p_transfer->>'sent_at')::timestamptz then
      return to_jsonb(existing) || jsonb_build_object('duplicate', true);
    end if;
    raise exception using errcode = '22023', message = 'transfer id content conflict';
  end if;

  -- Serialize movements of the same daily origin before checking its remaining quantity.
  perform pg_advisory_xact_lock(hashtextextended(
    company_id_value::text || ':' || lot_id_value::text || ':' || origin_date_value::text, 0
  ));
  -- A concurrent retry with the same transfer ID may have committed while this
  -- transaction waited for the origin lock; resolve it before counting sent eggs.
  select * into existing from public.collection_transfers where transfer_id = transfer_id_value;
  if found then
    if existing.company_id = company_id_value and existing.site_id = site_id_value
       and existing.house_id = house_id_value and existing.lot_id = lot_id_value
       and existing.origin_business_date = origin_date_value and existing.quantity_sent = quantity_value
       and existing.sent_from = sent_from_value and existing.sent_to = sent_to_value
       and existing.sent_by = actor and existing.sent_at = (p_transfer->>'sent_at')::timestamptz then
      return to_jsonb(existing) || jsonb_build_object('duplicate', true);
    end if;
    raise exception using errcode = '22023', message = 'transfer id content conflict';
  end if;
  select coalesce(sum(quantity_eggs), 0)::integer into collected
  from public.collection_events
  where company_id = company_id_value and site_id = site_id_value and house_id = house_id_value
    and lot_id = lot_id_value and business_date = origin_date_value;
  select coalesce(sum(quantity_sent), 0)::integer into previously_sent
  from public.collection_transfers
  where company_id = company_id_value and lot_id = lot_id_value and origin_business_date = origin_date_value;
  if quantity_value > collected - previously_sent then
    raise exception using errcode = '23514', message = 'transfer exceeds confirmed daily origin';
  end if;

  insert into public.collection_transfers (
    transfer_id, company_id, site_id, house_id, lot_id, origin_business_date,
    quantity_sent, sent_from, sent_to, sent_by, sent_at
  ) values (
    transfer_id_value, company_id_value, site_id_value, house_id_value, lot_id_value,
    origin_date_value, quantity_value, sent_from_value, sent_to_value, actor,
    (p_transfer->>'sent_at')::timestamptz
  ) on conflict (transfer_id) do nothing returning * into inserted;
  if found then return to_jsonb(inserted) || jsonb_build_object('duplicate', false); end if;

  select * into existing from public.collection_transfers where transfer_id = transfer_id_value;
  if found and existing.company_id = company_id_value and existing.site_id = site_id_value
     and existing.house_id = house_id_value and existing.lot_id = lot_id_value
     and existing.origin_business_date = origin_date_value and existing.quantity_sent = quantity_value
     and existing.sent_from = sent_from_value and existing.sent_to = sent_to_value
     and existing.sent_by = actor and existing.sent_at = (p_transfer->>'sent_at')::timestamptz then
    return to_jsonb(existing) || jsonb_build_object('duplicate', true);
  end if;
  raise exception using errcode = '22023', message = 'transfer id content conflict';
end;
$$;

create or replace function public.confirm_collection_transfer_receipt(
  p_transfer_id uuid,
  p_received_quantity integer,
  p_received_at_location text,
  p_received_at timestamptz,
  p_receiver_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  transfer public.collection_transfers%rowtype;
  incident public.custody_incidents%rowtype;
begin
  if actor is null or p_received_quantity < 0
     or length(trim(p_received_at_location)) not between 1 and 160
     or p_receiver_note is not null and length(p_receiver_note) > 2000 then
    raise exception using errcode = '22023', message = 'invalid transfer receipt';
  end if;
  select * into transfer from public.collection_transfers where transfer_id = p_transfer_id for update;
  if not found or not private.has_lot_role(transfer.company_id, transfer.site_id, transfer.house_id, transfer.lot_id, 'warehouse') then
    raise exception using errcode = '42501', message = 'custody receipt forbidden';
  end if;
  if transfer.status = 'received' then
    if transfer.received_quantity = p_received_quantity and transfer.received_at_location = p_received_at_location
       and transfer.received_by = actor and transfer.received_at = p_received_at
       and transfer.receiver_note is not distinct from p_receiver_note then
      select * into incident from public.custody_incidents where transfer_id = p_transfer_id;
      return jsonb_build_object('transfer_id', transfer.transfer_id, 'status', transfer.status,
        'incident_id', incident.incident_id, 'duplicate', true);
    end if;
    raise exception using errcode = '22023', message = 'transfer already received with different content';
  end if;
  update public.collection_transfers set
    received_quantity = p_received_quantity,
    received_at_location = p_received_at_location,
    received_by = actor,
    received_at = p_received_at,
    receiver_note = p_receiver_note,
    status = 'received'
  where transfer_id = p_transfer_id returning * into transfer;
  if p_received_quantity <> transfer.quantity_sent then
    insert into public.custody_incidents(company_id, transfer_id, quantity_difference, opened_by)
    values (transfer.company_id, transfer.transfer_id, transfer.quantity_sent - p_received_quantity, actor)
    returning * into incident;
  end if;
  return jsonb_build_object('transfer_id', transfer.transfer_id, 'status', transfer.status,
    'received_quantity', transfer.received_quantity, 'incident_id', incident.incident_id, 'duplicate', false);
end;
$$;

create or replace function public.add_custody_incident_evidence(
  p_incident_id uuid,
  p_evidence_kind text,
  p_reference text,
  p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  incident public.custody_incidents%rowtype;
  transfer public.collection_transfers%rowtype;
  evidence_id_value uuid;
begin
  select * into incident from public.custody_incidents where incident_id = p_incident_id for update;
  select * into transfer from public.collection_transfers where transfer_id = incident.transfer_id;
  if actor is null or not found or incident.status not in ('open', 'investigating')
     or not private.has_lot_role(transfer.company_id, transfer.site_id, transfer.house_id, transfer.lot_id, 'warehouse')
     or p_evidence_kind not in ('sender_statement','origin_card','count_record','transfer_note','photo_reference','other','missing')
     or length(trim(p_notes)) not between 1 and 2000 then
    raise exception using errcode = '42501', message = 'custody evidence forbidden or invalid';
  end if;
  insert into public.custody_incident_evidence(company_id, incident_id, evidence_kind, reference, notes, recorded_by)
  values (incident.company_id, incident.incident_id, p_evidence_kind, p_reference, p_notes, actor)
  returning evidence_id into evidence_id_value;
  update public.custody_incidents set status = 'investigating' where incident_id = p_incident_id and status = 'open';
  return evidence_id_value;
end;
$$;

create or replace function public.submit_custody_incident_to_direction(
  p_incident_id uuid,
  p_investigation_summary text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  incident public.custody_incidents%rowtype;
  transfer public.collection_transfers%rowtype;
begin
  select * into incident from public.custody_incidents where incident_id = p_incident_id for update;
  select * into transfer from public.collection_transfers where transfer_id = incident.transfer_id;
  if auth.uid() is null or not found or incident.status not in ('investigating','open')
     or length(trim(p_investigation_summary)) not between 1 and 4000
     or not private.has_lot_role(transfer.company_id, transfer.site_id, transfer.house_id, transfer.lot_id, 'warehouse')
     or not exists (select 1 from public.custody_incident_evidence evidence
       where evidence.company_id = incident.company_id and evidence.incident_id = incident.incident_id) then
    raise exception using errcode = '42501', message = 'custody incident submission forbidden or incomplete';
  end if;
  update public.custody_incidents set status = 'submitted_to_direction',
    investigation_summary = p_investigation_summary, submitted_at = now(), submitted_by = auth.uid()
  where incident_id = p_incident_id;
end;
$$;

revoke all on function public.dispatch_collection_transfer(jsonb) from public, anon;
revoke all on function public.confirm_collection_transfer_receipt(uuid, integer, text, timestamptz, text) from public, anon;
revoke all on function public.add_custody_incident_evidence(uuid, text, text, text) from public, anon;
revoke all on function public.submit_custody_incident_to_direction(uuid, text) from public, anon;
grant execute on function public.dispatch_collection_transfer(jsonb) to authenticated;
grant execute on function public.confirm_collection_transfer_receipt(uuid, integer, text, timestamptz, text) to authenticated;
grant execute on function public.add_custody_incident_evidence(uuid, text, text, text) to authenticated;
grant execute on function public.submit_custody_incident_to_direction(uuid, text) to authenticated;

comment on table public.collection_transfers is
  'Physical egg custody transfer for one company/lot/house/daily origin; receipt is separate from collection production and classification inventory.';
comment on table public.custody_incidents is
  'Open custody discrepancies derived from sent versus received quantity; no automatic production or stock adjustment.';
comment on table public.custody_incident_evidence is
  'Append-only investigator evidence and explicit missing-support declarations for custody incidents.';
