-- DEV-009B. Review can return a case to investigation; it cannot apply a loss,
-- change collection production, or close custody reconciliation.
alter table public.custody_incidents
  add column revision integer not null default 0 check (revision >= 0);

create table public.custody_case_actions (
  command_id uuid primary key,
  company_id uuid not null,
  incident_id uuid not null,
  revision_after integer not null check (revision_after > 0),
  action_type text not null check (action_type in (
    'add_evidence', 'submit', 'request_evidence', 'continue_investigation'
  )),
  command_payload jsonb not null,
  actor_id uuid not null references auth.users(id) on delete restrict,
  recorded_at timestamptz not null default statement_timestamp(),
  before_snapshot jsonb not null,
  after_snapshot jsonb not null,
  unique (incident_id, revision_after),
  foreign key (company_id, incident_id)
    references public.custody_incidents(company_id, incident_id) on delete restrict
);
alter table public.custody_case_actions enable row level security;
alter table public.custody_case_actions force row level security;
create policy custody_case_actions_read_scope
  on public.custody_case_actions for select to authenticated
  using (exists (
    select 1 from public.custody_incidents incident
    where incident.company_id = custody_case_actions.company_id
      and incident.incident_id = custody_case_actions.incident_id
  ));
revoke all on public.custody_case_actions from public, anon, authenticated;
grant select on public.custody_case_actions to authenticated;

create or replace function public.record_custody_case_action(p_command jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := (select auth.uid());
  command_id_value uuid;
  company_id_value uuid;
  incident_id_value uuid;
  expected_revision_value integer;
  action_value text;
  details jsonb;
  incident public.custody_incidents%rowtype;
  transfer public.collection_transfers%rowtype;
  prior public.custody_case_actions%rowtype;
  before_value jsonb;
  recorded_at_value timestamptz := statement_timestamp();
begin
  if actor is null then
    raise exception using errcode = '42501', message = 'custody action forbidden';
  end if;
  if p_command is null or jsonb_typeof(p_command) is distinct from 'object'
     or octet_length(p_command::text) > 8192
     or (p_command - array['schema_version','command_id','company_id','incident_id','expected_revision','action','details']) <> '{}'::jsonb
     or not (p_command ?& array['schema_version','command_id','company_id','incident_id','expected_revision','action','details'])
     or p_command->'schema_version' is distinct from '1'::jsonb
     or jsonb_typeof(p_command->'command_id') is distinct from 'string'
     or jsonb_typeof(p_command->'company_id') is distinct from 'string'
     or jsonb_typeof(p_command->'incident_id') is distinct from 'string'
     or (p_command->>'command_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or (p_command->>'company_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or (p_command->>'incident_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or jsonb_typeof(p_command->'expected_revision') is distinct from 'number'
     or (p_command->>'expected_revision') !~ '^(0|[1-9][0-9]{0,9})$'
     or jsonb_typeof(p_command->'action') is distinct from 'string'
     or jsonb_typeof(p_command->'details') is distinct from 'object' then
    raise exception using errcode = '22023', message = 'invalid custody command';
  end if;
  begin
    command_id_value := (p_command->>'command_id')::uuid;
    company_id_value := (p_command->>'company_id')::uuid;
    incident_id_value := (p_command->>'incident_id')::uuid;
    expected_revision_value := (p_command->>'expected_revision')::integer;
  exception when others then
    raise exception using errcode = '22023', message = 'invalid custody command';
  end;
  action_value := p_command->>'action';
  details := p_command->'details';
  if action_value = 'add_evidence' then
    if (details - array['kind','reference','notes']) <> '{}'::jsonb
       or not (details ?& array['kind','reference','notes'])
       or jsonb_typeof(details->'kind') is distinct from 'string'
       or details->>'kind' not in ('sender_statement','origin_card','count_record','transfer_note','photo_reference','other','missing')
       or jsonb_typeof(details->'reference') not in ('null','string')
       or length(details->>'reference') > 500
       or jsonb_typeof(details->'notes') is distinct from 'string'
       or length(trim(details->>'notes')) not between 1 and 2000 then
      raise exception using errcode = '22023', message = 'invalid custody evidence';
    end if;
  elsif action_value = 'submit' then
    if (details - 'summary') <> '{}'::jsonb or not details ? 'summary'
       or jsonb_typeof(details->'summary') is distinct from 'string'
       or length(trim(details->>'summary')) not between 1 and 4000 then
      raise exception using errcode = '22023', message = 'invalid custody submission';
    end if;
  elsif action_value in ('request_evidence','continue_investigation') then
    if (details - 'reason') <> '{}'::jsonb or not details ? 'reason'
       or jsonb_typeof(details->'reason') is distinct from 'string'
       or length(trim(details->>'reason')) not between 1 and 2000 then
      raise exception using errcode = '22023', message = 'invalid custody review';
    end if;
  else
    raise exception using errcode = '22023', message = 'unsupported custody action';
  end if;

  select * into incident from public.custody_incidents
  where incident_id = incident_id_value and company_id = company_id_value for update;
  if not found then
    raise exception using errcode = '42501', message = 'custody action forbidden';
  end if;
  select * into transfer from public.collection_transfers
  where transfer_id = incident.transfer_id and company_id = incident.company_id;
  if not private.has_lot_role(transfer.company_id, transfer.site_id, transfer.house_id, transfer.lot_id,
    case when action_value in ('add_evidence','submit') then 'warehouse' else 'director' end) then
    raise exception using errcode = '42501', message = 'custody action forbidden';
  end if;

  -- Revalidate current authority before recovering an earlier command result.
  select * into prior from public.custody_case_actions where command_id = command_id_value;
  if found then
    if prior.actor_id <> actor or prior.command_payload <> p_command then
      raise exception using errcode = '22023', message = 'custody command id content conflict';
    end if;
    return jsonb_build_object('command_id', prior.command_id, 'company_id', prior.company_id,
      'incident_id', prior.incident_id, 'revision', prior.revision_after,
      'status', prior.after_snapshot->>'status', 'recorded_at', prior.recorded_at, 'duplicate', true);
  end if;
  if incident.revision <> expected_revision_value or incident.revision = 2147483647 then
    raise exception using errcode = '40001', message = 'custody revision conflict';
  end if;
  before_value := to_jsonb(incident);

  if action_value = 'add_evidence' then
    if incident.status not in ('open','investigating') then
      raise exception using errcode = '55000', message = 'custody action state conflict';
    end if;
    insert into public.custody_incident_evidence(evidence_id, company_id, incident_id,
      evidence_kind, reference, notes, recorded_by, recorded_at)
    values (command_id_value, company_id_value, incident_id_value,
      details->>'kind', details->>'reference', details->>'notes', actor, recorded_at_value);
    update public.custody_incidents set status = 'investigating', revision = revision + 1
    where incident_id = incident_id_value returning * into incident;
  elsif action_value = 'submit' then
    if incident.status not in ('open','investigating')
       or not exists (select 1 from public.custody_incident_evidence evidence
         where evidence.company_id = company_id_value and evidence.incident_id = incident_id_value) then
      raise exception using errcode = '55000', message = 'custody submission incomplete or state conflict';
    end if;
    update public.custody_incidents set status = 'submitted_to_direction', revision = revision + 1,
      investigation_summary = details->>'summary', submitted_at = recorded_at_value, submitted_by = actor
    where incident_id = incident_id_value returning * into incident;
  else
    if incident.status <> 'submitted_to_direction' then
      raise exception using errcode = '55000', message = 'custody action state conflict';
    end if;
    update public.custody_incidents set status = 'investigating', revision = revision + 1,
      submitted_at = null, submitted_by = null
    where incident_id = incident_id_value returning * into incident;
  end if;
  insert into public.custody_case_actions(command_id, company_id, incident_id, revision_after,
    action_type, command_payload, actor_id, recorded_at, before_snapshot, after_snapshot)
  values (command_id_value, company_id_value, incident_id_value, incident.revision,
    action_value, p_command, actor, recorded_at_value, before_value, to_jsonb(incident));
  return jsonb_build_object('command_id', command_id_value, 'company_id', company_id_value,
    'incident_id', incident_id_value, 'revision', incident.revision,
    'status', incident.status, 'recorded_at', recorded_at_value, 'duplicate', false);
end;
$$;
revoke all on function public.record_custody_case_action(jsonb) from public, anon;
grant execute on function public.record_custody_case_action(jsonb) to authenticated;

-- Preserve DEV-009A entry points. Their callers have no stable command ID;
-- new clients must use record_custody_case_action for retry-safe evidence.
create or replace function public.add_custody_incident_evidence(
  p_incident_id uuid, p_evidence_kind text, p_reference text, p_notes text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  incident public.custody_incidents%rowtype;
  evidence_id_value uuid := gen_random_uuid();
begin
  select * into incident from public.custody_incidents where incident_id = p_incident_id for update;
  if not found then
    raise exception using errcode = '42501', message = 'custody action forbidden';
  end if;
  perform public.record_custody_case_action(jsonb_build_object('schema_version', 1,
    'command_id', evidence_id_value, 'company_id', incident.company_id,
    'incident_id', incident.incident_id, 'expected_revision', incident.revision,
    'action', 'add_evidence', 'details', jsonb_build_object('kind', p_evidence_kind,
      'reference', p_reference, 'notes', p_notes)));
  return evidence_id_value;
end;
$$;

create or replace function public.submit_custody_incident_to_direction(
  p_incident_id uuid, p_investigation_summary text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  incident public.custody_incidents%rowtype;
begin
  select * into incident from public.custody_incidents where incident_id = p_incident_id for update;
  if not found then
    raise exception using errcode = '42501', message = 'custody action forbidden';
  end if;
  perform public.record_custody_case_action(jsonb_build_object('schema_version', 1,
    'command_id', gen_random_uuid(), 'company_id', incident.company_id,
    'incident_id', incident.incident_id, 'expected_revision', incident.revision,
    'action', 'submit', 'details', jsonb_build_object('summary', p_investigation_summary)));
end;
$$;

comment on table public.custody_case_actions is
  'Application append-only custody review history. Stable command IDs, authenticated actor, optimistic revision, and before/after snapshots; no authority to apply corrections or losses.';
