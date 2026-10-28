-- UI permission hints do not replace authorization on writes.
create or replace function public.get_feed_opening(p_company_id uuid,p_opening_id uuid,p_offset integer default 0) returns jsonb language plpgsql security invoker set search_path='' as $$
declare result jsonb;
begin
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='invalid opening';end if;
 with head as (select * from public.feed_openings where company_id=p_company_id and opening_id=p_opening_id),
 counts as (select c.event_payload,c.recorded_by,c.recorded_at,c.revision from public.feed_opening_counts c join head h using(opening_id,company_id) order by c.revision desc limit 26 offset p_offset)
 select jsonb_build_object('format','tamago.feed-opening-context','schema_version',1,'inventory_check','not_applied','can_approve',h.status='pending' and private.has_lot_role(h.company_id,h.site_id,h.house_id,h.lot_id,'director'),'can_count',h.status='pending' and private.has_lot_role(h.company_id,h.site_id,h.house_id,h.lot_id,'capture') and exists(select 1 from public.lots lot where lot.company_id=h.company_id and lot.id=h.lot_id and lot.status='active'),'opening',to_jsonb(h),'counts',coalesce((select jsonb_agg(to_jsonb(c) order by c.revision desc) from (select * from counts order by revision desc limit 25)c),'[]'::jsonb),'approval',(select jsonb_build_object('event_payload',a.event_payload,'recorded_by',a.recorded_by,'recorded_at',a.recorded_at,'revision',a.revision) from public.feed_opening_approvals a where a.company_id=h.company_id and a.opening_id=h.opening_id),'next_offset',case when (select count(*) from counts)>25 then p_offset+25 else null end) into result from head h;
 return result;
end;$$;

create function public.list_feed_openings(p_company_id uuid,p_offset integer default 0) returns jsonb language plpgsql security invoker set search_path='' as $$
declare rows_value jsonb;
begin
 if p_offset is null or p_offset<0 or p_offset>100000 then raise exception using errcode='22023',message='invalid opening';end if;
 select coalesce(jsonb_agg(to_jsonb(h) order by h.opening_id),'[]'::jsonb) into rows_value from (select * from public.feed_openings where company_id=p_company_id order by opening_id limit 26 offset p_offset) h;
 return jsonb_build_object('format','tamago.feed-opening-list','schema_version',1,'inventory_check','not_applied','company_id',p_company_id,'items',coalesce((select jsonb_agg(value order by ordinality) from jsonb_array_elements(rows_value) with ordinality where ordinality<=25),'[]'::jsonb),'next_offset',case when jsonb_array_length(rows_value)>25 then p_offset+25 else null end);
end;$$;
revoke all on function public.list_feed_openings(uuid,integer) from public,anon,service_role;
grant execute on function public.list_feed_openings(uuid,integer) to authenticated;
