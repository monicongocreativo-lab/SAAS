-- Permission hints for the connected UI; every write still rechecks scope.
create function public.get_feed_supply_scope(p_company_id uuid) returns jsonb
language sql security invoker set search_path='' as $$
 select jsonb_build_object('company_id',p_company_id,'lots',coalesce(jsonb_agg(jsonb_build_object(
  'lot_id',lot.id,'can_record',lot.status='active' and private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'capture')) order by lot.id),'[]'::jsonb))
 from public.lots lot where lot.company_id=p_company_id and (
 private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'capture') or
 private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'director'));
$$;
revoke all on function public.get_feed_supply_scope(uuid) from public,anon,service_role;
grant execute on function public.get_feed_supply_scope(uuid) to authenticated;
