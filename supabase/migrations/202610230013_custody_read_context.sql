-- Online custody UI projections. SECURITY INVOKER preserves caller RLS.
create or replace function public.list_collection_transfers(p_company_id uuid, p_offset integer default 0)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare rows_value jsonb;
begin
  if p_offset is null or p_offset < 0 or p_offset > 100000 then
    raise exception using errcode='22023', message='invalid custody page';
  end if;
  select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc, page.transfer_id desc),'[]'::jsonb)
  into rows_value from (
    select transfer.*, lot.code as lot_code, house.name as house_name
    from public.collection_transfers transfer
    join public.lots lot on lot.company_id=transfer.company_id and lot.id=transfer.lot_id
    join public.houses house on house.company_id=transfer.company_id and house.id=transfer.house_id
    where transfer.company_id=p_company_id
    order by transfer.created_at desc, transfer.transfer_id desc limit 26 offset p_offset
  ) page;
  return jsonb_build_object('items',coalesce((select jsonb_agg(value order by ordinality)
    from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),
    'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end);
end;
$$;

create or replace function public.get_collection_transfer_context(p_company_id uuid,p_transfer_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  transfer public.collection_transfers%rowtype;
  incident public.custody_incidents%rowtype;
  origin_value jsonb;
  warehouse boolean;
  direction boolean;
begin
  select * into transfer from public.collection_transfers
  where company_id=p_company_id and transfer_id=p_transfer_id;
  if not found then return null; end if;
  select * into incident from public.custody_incidents
  where company_id=p_company_id and transfer_id=p_transfer_id;
  select jsonb_build_object('lot_code',lot.code,'house_name',house.name) into origin_value
  from public.lots lot join public.houses house on house.company_id=lot.company_id and house.id=lot.house_id
  where lot.company_id=p_company_id and lot.id=transfer.lot_id;
  warehouse:=private.has_lot_role(transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id,'warehouse');
  direction:=private.has_lot_role(transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id,'director');
  return jsonb_build_object('transfer',to_jsonb(transfer)||coalesce(origin_value,'{}'::jsonb),
    'incident',case when incident.incident_id is null then null else to_jsonb(incident) end,
    'permissions',jsonb_build_object('receive',warehouse and transfer.status='dispatched',
      'evidence',warehouse and coalesce(incident.status in ('open','investigating'),false),
      'submit',warehouse and coalesce(incident.status in ('open','investigating'),false),
      'review',direction and coalesce(incident.status='submitted_to_direction',false)));
end;
$$;
revoke all on function public.list_collection_transfers(uuid,integer) from public,anon;
revoke all on function public.get_collection_transfer_context(uuid,uuid) from public,anon;
grant execute on function public.list_collection_transfers(uuid,integer) to authenticated;
grant execute on function public.get_collection_transfer_context(uuid,uuid) to authenticated;
