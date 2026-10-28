-- An initial temporary credential must not grant company data access through
-- direct Supabase API calls. Read current Auth metadata from the database so
-- clearing the marker takes effect without waiting for a JWT refresh.
create or replace function private.initial_access_complete()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null
    and coalesce(
      (
        select user_record.raw_app_meta_data ->> 'tamago_initial_access_state'
        from auth.users user_record
        where user_record.id = (select auth.uid())
      ),
      ''
    ) <> 'pending';
$$;

revoke all on function private.initial_access_complete() from public, anon;
grant execute on function private.initial_access_complete() to authenticated;

create policy initial_access_gate_companies
  on public.companies as restrictive for all to authenticated
  using ((select private.initial_access_complete()))
  with check ((select private.initial_access_complete()));

create policy initial_access_gate_memberships
  on public.company_memberships as restrictive for all to authenticated
  using ((select private.initial_access_complete()))
  with check ((select private.initial_access_complete()));

create policy initial_access_gate_roles
  on public.role_assignments as restrictive for all to authenticated
  using ((select private.initial_access_complete()))
  with check ((select private.initial_access_complete()));

create policy initial_access_gate_sites
  on public.sites as restrictive for all to authenticated
  using ((select private.initial_access_complete()))
  with check ((select private.initial_access_complete()));

create policy initial_access_gate_houses
  on public.houses as restrictive for all to authenticated
  using ((select private.initial_access_complete()))
  with check ((select private.initial_access_complete()));

create policy initial_access_gate_lots
  on public.lots as restrictive for all to authenticated
  using ((select private.initial_access_complete()))
  with check ((select private.initial_access_complete()));

create or replace function private.can_manage_company_members(target_company_id uuid)
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
      and assignment.role_key in ('admin', 'director')
      and assignment.site_id is null
      and assignment.house_id is null
      and assignment.lot_id is null
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now())
  );
$$;

create or replace function private.enforce_initial_access_before_membership_activation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.status = 'invited'
    and new.status = 'active'
    and new.user_id = (select auth.uid())
    and not private.initial_access_complete() then
    raise exception using
      errcode = '42501',
      message = 'initial password change required';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_initial_access_before_membership_activation()
  from public, anon, authenticated;

create trigger company_membership_initial_access_gate
  before update of status on public.company_memberships
  for each row
  execute function private.enforce_initial_access_before_membership_activation();

comment on function private.initial_access_complete()
  is 'Checks current Auth metadata to gate company database access until the user changes an initial temporary password.';
