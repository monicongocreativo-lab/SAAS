-- DEV-004 / P03 baseline. Review-only until applied to a disposable Supabase
-- project and exercised by cross-company RLS tests. No real company rows.
-- This migration creates identity relationships and read-only directory data;
-- it does not yet authorize operational event writes or connect the mobile queue.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = upper(code) and code ~ '^[A-Z0-9_-]{2,32}$'),
  legal_name text not null check (length(trim(legal_name)) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  unique (id, code)
);

create table public.company_memberships (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  status text not null default 'invited'
    check (status in ('invited', 'active', 'suspended', 'revoked')),
  valid_from timestamptz not null default now(),
  valid_until timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, user_id),
  check (valid_until is null or valid_until > valid_from),
  check ((status = 'revoked') = (revoked_at is not null))
);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete restrict,
  code text not null check (length(trim(code)) between 1 and 80),
  name text not null check (length(trim(name)) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, code)
);

create table public.houses (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  site_id uuid not null,
  code text not null check (length(trim(code)) between 1 and 80),
  name text not null check (length(trim(name)) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, site_id, id),
  unique (company_id, site_id, code),
  foreign key (company_id, site_id)
    references public.sites(company_id, id) on delete restrict
);

create table public.lots (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  site_id uuid not null,
  house_id uuid not null,
  code text not null check (length(trim(code)) between 1 and 80),
  status text not null default 'preparing'
    check (status in ('preparing', 'active', 'closed', 'archived')),
  created_at timestamptz not null default now(),
  unique (company_id, id),
  unique (company_id, site_id, house_id, id),
  unique (company_id, code),
  foreign key (company_id, site_id)
    references public.sites(company_id, id) on delete restrict,
  foreign key (company_id, site_id, house_id)
    references public.houses(company_id, site_id, id) on delete restrict
);

create table public.role_assignments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null,
  membership_id uuid not null,
  role_key text not null check (role_key in (
    'capture', 'warehouse', 'director', 'admin', 'billing', 'transport'
  )),
  site_id uuid,
  house_id uuid,
  lot_id uuid,
  granted_by_user_id uuid references auth.users(id) on delete restrict,
  granted_at timestamptz not null default now(),
  valid_until timestamptz,
  revoked_at timestamptz,
  check (valid_until is null or valid_until > granted_at),
  check (num_nonnulls(site_id, house_id, lot_id) <= 1),
  check (house_id is null or site_id is not null),
  check (lot_id is null or (site_id is not null and house_id is not null)),
  check ((revoked_at is null) or revoked_at >= granted_at),
  foreign key (company_id, membership_id)
    references public.company_memberships(company_id, id) on delete restrict,
  foreign key (company_id, site_id)
    references public.sites(company_id, id) on delete restrict,
  foreign key (company_id, site_id, house_id)
    references public.houses(company_id, site_id, id) on delete restrict,
  foreign key (company_id, site_id, house_id, lot_id)
    references public.lots(company_id, site_id, house_id, id) on delete restrict
);

create index company_memberships_user_status_idx
  on public.company_memberships(user_id, status, company_id);
create index role_assignments_membership_role_idx
  on public.role_assignments(company_id, membership_id, role_key)
  where revoked_at is null;
create index sites_company_idx on public.sites(company_id, status);
create index houses_company_site_idx on public.houses(company_id, site_id, status);
create index lots_company_house_idx on public.lots(company_id, house_id, status);

-- These SECURITY DEFINER helpers only return booleans. Pin search_path and
-- schema-qualify every object to prevent object-shadowing attacks.
create or replace function private.is_active_company_member(target_company_id uuid)
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
    where membership.company_id = target_company_id
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now()
      and (membership.valid_until is null or membership.valid_until > now())
      and company.status = 'active'
  );
$$;

create or replace function private.has_company_role(
  target_company_id uuid,
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
    where membership.company_id = target_company_id
      and company.status = 'active'
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now()
      and (membership.valid_until is null or membership.valid_until > now())
      and assignment.role_key = required_role
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now())
      and assignment.site_id is null
      and assignment.house_id is null
      and assignment.lot_id is null
  );
$$;

create or replace function private.can_read_site(
  target_company_id uuid,
  target_site_id uuid
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
    where membership.company_id = target_company_id
      and company.status = 'active'
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now()
      and (membership.valid_until is null or membership.valid_until > now())
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now())
      and (
        (assignment.site_id is null and assignment.house_id is null and assignment.lot_id is null)
        or assignment.site_id = target_site_id
      )
  );
$$;

create or replace function private.can_read_house(
  target_company_id uuid,
  target_site_id uuid,
  target_house_id uuid
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
    where membership.company_id = target_company_id
      and company.status = 'active'
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now()
      and (membership.valid_until is null or membership.valid_until > now())
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now())
      and (
        (assignment.site_id is null and assignment.house_id is null and assignment.lot_id is null)
        or assignment.site_id = target_site_id
          and (assignment.house_id is null or assignment.house_id = target_house_id)
      )
  );
$$;

create or replace function private.can_read_lot(
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
  select exists (
    select 1
    from public.company_memberships membership
    join public.companies company on company.id = membership.company_id
    join public.role_assignments assignment
      on assignment.company_id = membership.company_id
      and assignment.membership_id = membership.id
    where membership.company_id = target_company_id
      and company.status = 'active'
      and membership.user_id = (select auth.uid())
      and membership.status = 'active'
      and membership.revoked_at is null
      and membership.valid_from <= now()
      and (membership.valid_until is null or membership.valid_until > now())
      and assignment.revoked_at is null
      and (assignment.valid_until is null or assignment.valid_until > now())
      and (
        (assignment.site_id is null and assignment.house_id is null and assignment.lot_id is null)
        or assignment.site_id = target_site_id
          and (assignment.house_id is null or assignment.house_id = target_house_id)
          and (assignment.lot_id is null or assignment.lot_id = target_lot_id)
      )
  );
$$;

revoke all on function private.is_active_company_member(uuid) from public;
revoke all on function private.has_company_role(uuid, text) from public;
revoke all on function private.can_read_site(uuid, uuid) from public;
revoke all on function private.can_read_house(uuid, uuid, uuid) from public;
revoke all on function private.can_read_lot(uuid, uuid, uuid, uuid) from public;
grant execute on function private.is_active_company_member(uuid) to authenticated;
grant execute on function private.has_company_role(uuid, text) to authenticated;
grant execute on function private.can_read_site(uuid, uuid) to authenticated;
grant execute on function private.can_read_house(uuid, uuid, uuid) to authenticated;
grant execute on function private.can_read_lot(uuid, uuid, uuid, uuid) to authenticated;

alter table public.companies enable row level security;
alter table public.companies force row level security;
alter table public.company_memberships enable row level security;
alter table public.company_memberships force row level security;
alter table public.sites enable row level security;
alter table public.sites force row level security;
alter table public.houses enable row level security;
alter table public.houses force row level security;
alter table public.lots enable row level security;
alter table public.lots force row level security;
alter table public.role_assignments enable row level security;
alter table public.role_assignments force row level security;

create policy companies_read_member_company
  on public.companies for select to authenticated
  using ((select private.is_active_company_member(id)));

create policy memberships_read_self
  on public.company_memberships for select to authenticated
  using (user_id = (select auth.uid()));

create policy sites_read_member_company
  on public.sites for select to authenticated
  using ((select private.can_read_site(company_id, id)));

create policy houses_read_member_company
  on public.houses for select to authenticated
  using ((select private.can_read_house(company_id, site_id, id)));

create policy lots_read_member_company
  on public.lots for select to authenticated
  using ((select private.can_read_lot(company_id, site_id, house_id, id)));

create policy role_assignments_read_own_membership
  on public.role_assignments for select to authenticated
  using (exists (
    select 1
    from public.company_memberships membership
    where membership.id = role_assignments.membership_id
      and membership.company_id = role_assignments.company_id
      and membership.user_id = (select auth.uid())
  ));

-- Explicit grants: RLS policies don't revoke default table privileges.
revoke all on public.companies, public.company_memberships, public.sites,
  public.houses, public.lots, public.role_assignments from public, anon, authenticated;
grant select on public.companies, public.company_memberships, public.sites,
  public.houses, public.lots, public.role_assignments to authenticated;
