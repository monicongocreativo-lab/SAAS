-- Admin-authorized identity provisioning preflight. Auth user creation remains
-- a server-only operation; this function only evaluates the caller's scope.
create or replace function public.authorize_company_identity_creation(
  p_company_id uuid,
  p_role_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select private.can_manage_company_members(p_company_id)
    and private.can_assign_company_role(p_company_id, p_role_key)
    and p_role_key <> 'director';
$$;

revoke all on function public.authorize_company_identity_creation(uuid, text)
  from public, anon;
grant execute on function public.authorize_company_identity_creation(uuid, text)
  to authenticated;

comment on function public.authorize_company_identity_creation(uuid, text)
  is 'Preflights whether the authenticated actor may provision an identity with a non-director company role. It does not create users or memberships.';
