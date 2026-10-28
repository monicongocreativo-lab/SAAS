-- DEV-010A: sender projection. RLS and active role are applied before aggregation.
create or replace function public.list_collection_origins(p_company_id uuid,p_business_date date,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rows_value jsonb; authorized_value boolean;
begin
  if p_business_date is null or p_offset is null or p_offset<0 or p_offset>100000 then
    raise exception using errcode='22023', message='invalid collection origin page';
  end if;
  select exists(select 1 from public.lots lot where lot.company_id=p_company_id and (
    private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'capture') or
    private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'transport')
  )) into authorized_value;
  with collected as (
    select event.company_id,event.site_id,event.house_id,event.lot_id,event.business_date,
      sum(event.quantity_eggs)::bigint as quantity_collected,count(*)::integer as occurrences
    from public.collection_events event
    where event.company_id=p_company_id and event.business_date=p_business_date and (
      private.has_lot_role(event.company_id,event.site_id,event.house_id,event.lot_id,'capture') or
      private.has_lot_role(event.company_id,event.site_id,event.house_id,event.lot_id,'transport')
    ) group by event.company_id,event.site_id,event.house_id,event.lot_id,event.business_date
  ), sent as (
    select transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id,transfer.origin_business_date,
      sum(transfer.quantity_sent)::bigint as quantity_sent
    from public.collection_transfers transfer
    where transfer.company_id=p_company_id and transfer.origin_business_date=p_business_date
    group by transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id,transfer.origin_business_date
  ), page as (
    select origin.*,coalesce(sent.quantity_sent,0)::bigint as quantity_sent,
      (origin.quantity_collected-coalesce(sent.quantity_sent,0))::bigint as quantity_available,
      lot.code as lot_code,house.name as house_name
    from collected origin
    join public.lots lot on lot.company_id=origin.company_id and lot.id=origin.lot_id
    join public.houses house on house.company_id=origin.company_id and house.id=origin.house_id
    left join sent on sent.company_id=origin.company_id and sent.site_id=origin.site_id and sent.house_id=origin.house_id
      and sent.lot_id=origin.lot_id and sent.origin_business_date=origin.business_date
    order by origin.house_id,origin.lot_id limit 26 offset p_offset
  ) select coalesce(jsonb_agg(to_jsonb(page) order by page.house_id,page.lot_id),'[]'::jsonb) into rows_value from page;
  return jsonb_build_object('authorized',authorized_value,'items',coalesce((select jsonb_agg(value order by ordinality)
    from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),
    'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end);
end;
$$;
revoke all on function public.list_collection_origins(uuid,date,integer) from public,anon;
grant execute on function public.list_collection_origins(uuid,date,integer) to authenticated;

-- Preserve the existing dispatch contract and origin lock, widening only the
-- accumulators: three legal integer collection events may sum above int32.
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
  collected bigint;
  previously_sent bigint;
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
  select coalesce(sum(quantity_eggs), 0)::bigint into collected
  from public.collection_events
  where company_id = company_id_value and site_id = site_id_value and house_id = house_id_value
    and lot_id = lot_id_value and business_date = origin_date_value;
  select coalesce(sum(quantity_sent), 0)::bigint into previously_sent
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
