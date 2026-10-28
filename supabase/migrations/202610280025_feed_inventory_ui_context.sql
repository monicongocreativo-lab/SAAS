-- UI permission hint; every write still revalidates its own exact scope.
create function public.get_feed_inventory_context(p_company_id uuid,p_lot_id uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare l public.lots%rowtype;
begin
 select * into l from public.lots where company_id=p_company_id and id=p_lot_id;
 if not found or not(private.has_lot_role(p_company_id,l.site_id,l.house_id,l.id,'capture') or private.has_lot_role(p_company_id,l.site_id,l.house_id,l.id,'director')) then raise exception using errcode='42501',message='inventory forbidden';end if;
 return jsonb_build_object('company_id',p_company_id,'lot_id',p_lot_id,'can_manage',private.has_lot_role(p_company_id,l.site_id,l.house_id,l.id,'director'));
end;$$;
revoke all on function public.get_feed_inventory_context(uuid,uuid) from public,anon,service_role;
grant execute on function public.get_feed_inventory_context(uuid,uuid) to authenticated;
