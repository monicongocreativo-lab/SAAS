-- Read-only operational projection. Never a close, loss adjustment or stock.
create function public.list_origin_flow_summary(p_company_id uuid,p_business_date date,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare rows_value jsonb;
begin
 if p_business_date is null or p_offset is null or p_offset<0 or p_offset>100000 then
  raise exception using errcode='22023',message='invalid origin flow page';end if;
 with scoped as (
  select lot.company_id,lot.site_id,lot.house_id,lot.id as lot_id,lot.code as lot_code,lot.status as lot_status,house.name as house_name,site.name as site_name
  from public.lots lot join public.houses house on house.company_id=lot.company_id and house.id=lot.house_id
  join public.sites site on site.company_id=lot.company_id and site.id=lot.site_id
  where lot.company_id=p_company_id and (
   private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'capture') or
   private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'transport') or
   private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'warehouse') or
   private.has_lot_role(lot.company_id,lot.site_id,lot.house_id,lot.id,'director'))
  order by lot.site_id,lot.house_id,lot.id limit 26 offset p_offset
 ), collected as (
  select event.company_id,event.site_id,event.house_id,event.lot_id,count(*)::integer as collection_count,sum(event.quantity_eggs)::bigint as quantity_collected
  from public.collection_events event join scoped scope on scope.company_id=event.company_id and scope.site_id=event.site_id and scope.house_id=event.house_id and scope.lot_id=event.lot_id
  where event.business_date=p_business_date group by event.company_id,event.site_id,event.house_id,event.lot_id
 ), movements as (
  select transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id,count(*)::integer as transfer_count,count(*) filter(where transfer.status='received')::integer as receipt_count,
   sum(transfer.quantity_sent)::bigint as quantity_sent,
   coalesce(sum(transfer.quantity_sent) filter(where transfer.status='dispatched'),0)::bigint as quantity_in_transit,
   coalesce(sum(transfer.received_quantity) filter(where transfer.status='received'),0)::bigint as quantity_received,
   coalesce(sum(transfer.quantity_sent::bigint-transfer.received_quantity::bigint) filter(where transfer.status='received'),0)::bigint as custody_difference,
   coalesce(sum(greatest(transfer.quantity_sent::bigint-transfer.received_quantity::bigint,0)) filter(where transfer.status='received'),0)::bigint as custody_shortage,
   coalesce(sum(greatest(transfer.received_quantity::bigint-transfer.quantity_sent::bigint,0)) filter(where transfer.status='received'),0)::bigint as custody_surplus
  from public.collection_transfers transfer join scoped scope on scope.company_id=transfer.company_id and scope.site_id=transfer.site_id and scope.house_id=transfer.house_id and scope.lot_id=transfer.lot_id
  where transfer.origin_business_date=p_business_date group by transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id
 ), consumed as (
  select input.company_id,input.site_id,input.house_id,input.lot_id,sum(input.quantity_eggs)::bigint as quantity_classified
  from public.manual_classification_inputs input join scoped scope on scope.company_id=input.company_id and scope.site_id=input.site_id and scope.house_id=input.house_id and scope.lot_id=input.lot_id
  where input.origin_business_date=p_business_date group by input.company_id,input.site_id,input.house_id,input.lot_id
 ), results as (
  select session.company_id,session.site_id,session.house_id,session.lot_id,
   coalesce(sum(line.quantity_eggs) filter(where line.destination='PENDING'),0)::bigint as quantity_destination_undefined,
   coalesce(sum(line.quantity_eggs) filter(where line.destination='DISCARD'),0)::bigint as quantity_discard_declared
  from public.manual_classification_sessions session join scoped scope on scope.company_id=session.company_id and scope.site_id=session.site_id and scope.house_id=session.house_id and scope.lot_id=session.lot_id
  join public.manual_classification_lines line on line.company_id=session.company_id and line.session_id=session.session_id
  where session.origin_business_date=p_business_date group by session.company_id,session.site_id,session.house_id,session.lot_id
 ), incidents as (
  select transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id,count(*)::integer as open_incidents
  from public.custody_incidents incident join public.collection_transfers transfer on transfer.company_id=incident.company_id and transfer.transfer_id=incident.transfer_id
  join scoped scope on scope.company_id=transfer.company_id and scope.site_id=transfer.site_id and scope.house_id=transfer.house_id and scope.lot_id=transfer.lot_id
  where transfer.origin_business_date=p_business_date and incident.status in('open','investigating','submitted_to_direction')
  group by transfer.company_id,transfer.site_id,transfer.house_id,transfer.lot_id
 ), page as (
  select scope.*,p_business_date as origin_business_date,
   coalesce(collected.collection_count,0) as collection_count,collected.quantity_collected,
   coalesce(movements.transfer_count,0) as transfer_count,coalesce(movements.receipt_count,0) as receipt_count,coalesce(movements.quantity_sent,0)::bigint as quantity_sent,
   (collected.quantity_collected-coalesce(movements.quantity_sent,0))::bigint as quantity_at_house,
   coalesce(movements.quantity_in_transit,0)::bigint as quantity_in_transit,
   coalesce(movements.quantity_received,0)::bigint as quantity_received,
   coalesce(consumed.quantity_classified,0)::bigint as quantity_classified,
   (coalesce(movements.quantity_received,0)-coalesce(consumed.quantity_classified,0))::bigint as quantity_pending_classification,
   coalesce(movements.custody_difference,0)::bigint as custody_difference,
   coalesce(movements.custody_shortage,0)::bigint as custody_shortage,coalesce(movements.custody_surplus,0)::bigint as custody_surplus,
   coalesce(incidents.open_incidents,0) as open_incidents,
   coalesce(results.quantity_destination_undefined,0)::bigint as quantity_destination_undefined,
   coalesce(results.quantity_discard_declared,0)::bigint as quantity_discard_declared
  from scoped scope
  left join collected using(company_id,site_id,house_id,lot_id)
  left join movements using(company_id,site_id,house_id,lot_id)
  left join consumed using(company_id,site_id,house_id,lot_id)
  left join results using(company_id,site_id,house_id,lot_id)
  left join incidents using(company_id,site_id,house_id,lot_id)
  order by scope.site_id,scope.house_id,scope.lot_id
 ) select coalesce(jsonb_agg(to_jsonb(page) order by page.site_id,page.house_id,page.lot_id),'[]'::jsonb) into rows_value from page;
 return jsonb_build_object('format','tamago.origin-flow-summary','schema_version',1,'company_id',p_company_id,'origin_business_date',p_business_date,
  'as_of',statement_timestamp(),'purpose','consultation_only','items',coalesce((select jsonb_agg(value order by ordinality) from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),
  'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end);
end;
$$;
revoke all on function public.list_origin_flow_summary(uuid,date,integer) from public,anon,service_role;
grant execute on function public.list_origin_flow_summary(uuid,date,integer) to authenticated;
comment on function public.list_origin_flow_summary(uuid,date,integer) is 'RLS-scoped read-only origin-stage summary; missing collection is null, explicit zero preserved, signed custody net never hides separate shortages/surpluses. No approval, close, loss or stock effect.';
