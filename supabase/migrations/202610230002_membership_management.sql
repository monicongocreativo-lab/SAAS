-- P03 local iteration: durable membership administration through authenticated
-- user JWTs. No service-role writes are exposed to the app.

create or replace function private.can_manage_company_members(target_company_id uuid)
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

create or replace function private.can_assign_company_role(
  target_company_id uuid,
  target_role_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select target_role_key is not null
    and target_role_key in ('capture', 'warehouse', 'director', 'admin', 'billing', 'transport')
    and (
      private.has_company_role(target_company_id, 'director')
    or (
      target_role_key not in ('admin', 'director')
      and private.has_company_role(target_company_id, 'admin')
    ));
$$;

revoke all on function private.can_manage_company_members(uuid) from public, anon;
revoke all on function private.can_assign_company_role(uuid, text) from public, anon;
grant execute on function private.can_manage_company_members(uuid) to authenticated;
grant execute on function private.can_assign_company_role(uuid, text) to authenticated;

alter table public.company_memberships
  drop constraint company_memberships_company_id_user_id_key;
create unique index company_memberships_one_unrevoked_user_idx
  on public.company_memberships(company_id, user_id)
  where status <> 'revoked';

create policy memberships_read_company_managers
  on public.company_memberships for select to authenticated
  using (
    user_id = (select auth.uid())
    or (select private.can_manage_company_members(company_id))
  );

create policy role_assignments_read_company_managers
  on public.role_assignments for select to authenticated
  using (
    exists (
      select 1
      from public.company_memberships membership
      where membership.id = role_assignments.membership_id
        and membership.company_id = role_assignments.company_id
        and membership.user_id = (select auth.uid())
    )
    or (select private.can_manage_company_members(company_id))
  );

create unique index role_assignments_one_active_global_role_idx
  on public.role_assignments(company_id, membership_id, role_key)
  where site_id is null
    and house_id is null
    and lot_id is null
    and revoked_at is null;

create or replace function public.manage_company_membership(
  p_company_id uuid,
  p_user_id uuid,
  p_membership_id uuid,
  p_action text,
  p_role_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller_id uuid := (select auth.uid());
  target public.company_memberships%rowtype;
  assignment_id uuid;
  resulting_status text;
begin
  if caller_id is null then
    raise exception using errcode = '42501', message = 'authentication required';
  end if;

  if p_action = 'accept' then
    select * into target
    from public.company_memberships
    where id = p_membership_id and company_id = p_company_id
    for update;
    if not found or target.user_id <> caller_id or target.status <> 'invited' then
      raise exception using errcode = '42501', message = 'invitation unavailable';
    end if;
    update public.company_memberships
    set status = 'active'
    where id = target.id;
    return jsonb_build_object(
      'membership_id', target.id,
      'user_id', caller_id,
      'status', 'active',
      'action', p_action
    );
  end if;

  if not private.can_manage_company_members(p_company_id) then
    raise exception using errcode = '42501', message = 'membership management forbidden';
  end if;

  if p_action = 'invite' then
    if p_user_id is null or p_membership_id is not null or p_user_id = caller_id then
      raise exception using errcode = '22023', message = 'invalid invitation';
    end if;
    if p_role_key is null
      or p_role_key not in ('capture', 'warehouse', 'director', 'admin', 'billing', 'transport')
      or not private.can_assign_company_role(p_company_id, p_role_key) then
      raise exception using errcode = '42501', message = 'role assignment forbidden';
    end if;
    insert into public.company_memberships(company_id, user_id, status)
    values (p_company_id, p_user_id, 'invited')
    returning * into target;
    insert into public.role_assignments(
      company_id, membership_id, role_key, granted_by_user_id
    ) values (p_company_id, target.id, p_role_key, caller_id)
    returning id into assignment_id;
    return jsonb_build_object(
      'membership_id', target.id,
      'user_id', target.user_id,
      'status', target.status,
      'role_assignment_id', assignment_id,
      'role_key', p_role_key,
      'action', p_action
    );
  end if;

  select * into target
  from public.company_memberships
  where id = p_membership_id and company_id = p_company_id
  for update;
  if not found then
    raise exception using errcode = '22023', message = 'membership unavailable';
  end if;
  if target.user_id = caller_id then
    raise exception using errcode = '42501', message = 'self management forbidden';
  end if;
  if target.status not in ('active', 'invited', 'suspended') then
    raise exception using errcode = '22023', message = 'membership is not mutable';
  end if;

  if p_action in ('suspend', 'reactivate', 'revoke') then
    if exists (
      select 1 from public.role_assignments assignment
      where assignment.company_id = p_company_id
        and assignment.membership_id = target.id
        and assignment.role_key in ('admin', 'director')
        and assignment.revoked_at is null
        and (assignment.valid_until is null or assignment.valid_until > now())
    ) and not private.has_company_role(p_company_id, 'director') then
      raise exception using errcode = '42501', message = 'director must manage privileged member';
    end if;
    if p_action = 'reactivate' and target.status <> 'suspended' then
      raise exception using errcode = '22023', message = 'membership is not suspended';
    end if;
    resulting_status := case
      when p_action = 'revoke' then 'revoked'
      when p_action = 'reactivate' then 'active'
      else 'suspended'
    end;
    update public.company_memberships
    set status = resulting_status,
        revoked_at = case when resulting_status = 'revoked' then now() else null end
    where id = target.id;
    return jsonb_build_object(
      'membership_id', target.id,
      'user_id', target.user_id,
      'status', resulting_status,
      'action', p_action
    );
  end if;

  if p_action = 'assign_role' then
    if p_role_key is null
      or p_role_key not in ('capture', 'warehouse', 'director', 'admin', 'billing', 'transport')
      or not private.can_assign_company_role(p_company_id, p_role_key) then
      raise exception using errcode = '42501', message = 'role assignment forbidden';
    end if;
    if target.status not in ('active', 'invited') then
      raise exception using errcode = '22023', message = 'membership unavailable';
    end if;
    insert into public.role_assignments(
      company_id, membership_id, role_key, granted_by_user_id
    ) values (p_company_id, target.id, p_role_key, caller_id)
    returning id into assignment_id;
    return jsonb_build_object(
      'membership_id', target.id,
      'role_assignment_id', assignment_id,
      'role_key', p_role_key,
      'action', p_action
    );
  end if;

  if p_action = 'revoke_role' then
    if p_role_key is null
      or p_role_key not in ('capture', 'warehouse', 'director', 'admin', 'billing', 'transport') then
      raise exception using errcode = '22023', message = 'invalid role';
    end if;
    if p_role_key in ('admin', 'director')
      and not private.has_company_role(p_company_id, 'director') then
      raise exception using errcode = '42501', message = 'director must revoke privileged role';
    end if;
    update public.role_assignments
    set revoked_at = now()
    where company_id = p_company_id
      and membership_id = target.id
      and role_key = p_role_key
      and site_id is null
      and house_id is null
      and lot_id is null
      and revoked_at is null;
    if not found then
      raise exception using errcode = '22023', message = 'active role unavailable';
    end if;
    return jsonb_build_object(
      'membership_id', target.id,
      'role_key', p_role_key,
      'action', p_action
    );
  end if;

  raise exception using errcode = '22023', message = 'unsupported action';
end;
$$;

revoke all on function public.manage_company_membership(uuid, uuid, uuid, text, text)
  from public, anon;
grant execute on function public.manage_company_membership(uuid, uuid, uuid, text, text)
  to authenticated;
