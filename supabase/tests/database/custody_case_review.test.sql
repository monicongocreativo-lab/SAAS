begin;
select plan(32);

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('c1000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'custody-sender@example.invalid', now(), now()),
  ('c1000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'custody-warehouse@example.invalid', now(), now()),
  ('c1000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'custody-director@example.invalid', now(), now()),
  ('c1000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'custody-outsider@example.invalid', now(), now());
insert into public.companies (id, code, legal_name)
values
  ('c2000000-0000-4000-8000-000000000001', 'TEST-CUSTODY', 'Empresa ficticia de custodia'),
  ('c2000000-0000-4000-8000-000000000002', 'TEST-OTHER', 'Otra empresa ficticia');
insert into public.company_memberships (id, company_id, user_id, status)
values
  ('c3000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'active'),
  ('c3000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000002', 'active'),
  ('c3000000-0000-4000-8000-000000000003', 'c2000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003', 'active'),
  ('c3000000-0000-4000-8000-000000000004', 'c2000000-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000004', 'active');
insert into public.sites (id, company_id, code, name)
values
  ('c4000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'SITE-C', 'Sede ficticia'),
  ('c4000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'SITE-O', 'Otra sede ficticia');
insert into public.houses (id, company_id, site_id, code, name)
values
  ('c5000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'HOUSE-C', 'Galpón ficticio'),
  ('c5000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', 'HOUSE-O', 'Otro galpón ficticio');
insert into public.lots (id, company_id, site_id, house_id, code, status)
values
  ('c6000000-0000-4000-8000-000000000001', 'c2000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'LOT-C', 'active'),
  ('c6000000-0000-4000-8000-000000000002', 'c2000000-0000-4000-8000-000000000002', 'c4000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', 'LOT-O', 'active');
insert into public.role_assignments (company_id, membership_id, role_key, site_id, house_id, lot_id)
values
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000001', 'capture', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000002', 'warehouse', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000001', 'c3000000-0000-4000-8000-000000000003', 'director', 'c4000000-0000-4000-8000-000000000001', 'c5000000-0000-4000-8000-000000000001', 'c6000000-0000-4000-8000-000000000001'),
  ('c2000000-0000-4000-8000-000000000002', 'c3000000-0000-4000-8000-000000000004', 'warehouse', 'c4000000-0000-4000-8000-000000000002', 'c5000000-0000-4000-8000-000000000002', 'c6000000-0000-4000-8000-000000000002');


insert into public.collection_transfers(transfer_id,company_id,site_id,house_id,lot_id,origin_business_date,quantity_sent,sent_from,sent_to,sent_by,sent_at,received_quantity,received_at_location,received_by,received_at,status)
select id::uuid,'c2000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001','2026-10-27',100,'Galpón','Bodega','c1000000-0000-4000-8000-000000000001','2026-10-27T12:00Z',98,'Bodega','c1000000-0000-4000-8000-000000000002','2026-10-27T13:00Z','received'
from (values ('d0000000-0000-4000-8000-000000000001'),('d0000000-0000-4000-8000-000000000002')) v(id);
insert into public.custody_incidents(incident_id,company_id,transfer_id,quantity_difference,opened_by)
values ('d1000000-0000-4000-8000-000000000001','c2000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000001',2,'c1000000-0000-4000-8000-000000000002');
-- A pre-v12 submission has revision 0 and no action history. Its first new
-- review must preserve the old summary, author and timestamp in before_snapshot.
insert into public.custody_incidents(incident_id,company_id,transfer_id,quantity_difference,opened_by,status,investigation_summary,submitted_by,submitted_at)
values ('d1000000-0000-4000-8000-000000000002','c2000000-0000-4000-8000-000000000001','d0000000-0000-4000-8000-000000000002',2,'c1000000-0000-4000-8000-000000000002','submitted_to_direction','Antecedente v11','c1000000-0000-4000-8000-000000000002','2026-10-27T14:00Z');

create function pg_temp.case_command(p_action text,p_revision integer,p_details jsonb,p_id uuid default gen_random_uuid())
returns jsonb language sql as $$
  select jsonb_build_object('schema_version',1,'command_id',p_id,'company_id','c2000000-0000-4000-8000-000000000001',
    'incident_id','d1000000-0000-4000-8000-000000000001','expected_revision',p_revision,'action',p_action,'details',p_details);
$$;
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select set_config('test.evidence',pg_temp.case_command('add_evidence',0,'{"kind":"count_record","reference":"acta-ficticia","notes":"Recuento inicial"}','d2000000-0000-4000-8000-000000000001')::text,true);
select is(public.record_custody_case_action(current_setting('test.evidence')::jsonb)->>'revision','1','evidencia nueva incrementa revisión');
select is(public.record_custody_case_action(current_setting('test.evidence')::jsonb)->>'duplicate','true','reintento no duplica evidencia');
select is((select count(*)::integer from public.custody_incident_evidence),1,'hay una sola evidencia tras reintentar');
select throws_ok($$ select public.record_custody_case_action(jsonb_set(current_setting('test.evidence')::jsonb,'{details,notes}','"Contenido alterado"')) $$,'22023','custody command id content conflict','mismo ID con otro contenido no reemplaza historia');
select is(public.record_custody_case_action(pg_temp.case_command('submit',1,'{"summary":"Primera investigación"}','d2000000-0000-4000-8000-000000000002'))->>'status','submitted_to_direction','Bodega presenta primera investigación');
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('request_evidence',2,'{"reason":"Revisar"}')) $$,'42501','custody action forbidden','Bodega no ejerce revisión de Dirección');

select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select set_config('test.review',pg_temp.case_command('request_evidence',2,'{"reason":"Falta antecedente de quien entrega"}','d2000000-0000-4000-8000-000000000003')::text,true);
select is(public.record_custody_case_action(current_setting('test.review')::jsonb)->>'status','investigating','Dirección devuelve para ampliar evidencia');
select is((select before_snapshot->>'investigation_summary' from public.custody_case_actions where command_id='d2000000-0000-4000-8000-000000000003'),'Primera investigación','revisión conserva la presentación anterior');
select is(public.record_custody_case_action(current_setting('test.review')::jsonb)->>'duplicate','true','revisión repetida no añade otro efecto');
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('add_evidence',3,'{"kind":"other","reference":null,"notes":"No tengo rol Bodega"}')) $$,'42501','custody action forbidden','Dirección sin Bodega no añade evidencia');

select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('add_evidence',1,'{"kind":"sender_statement","reference":null,"notes":"Fuera de revisión"}')) $$,'40001','custody revision conflict','revisión obsoleta falla sin sobreescribir');
select is(public.record_custody_case_action(pg_temp.case_command('add_evidence',3,'{"kind":"sender_statement","reference":null,"notes":"Quien entrega confirmó el conteo inicial"}','d2000000-0000-4000-8000-000000000004'))->>'revision','4','Bodega amplía tras devolver Dirección');
select is(public.record_custody_case_action(pg_temp.case_command('submit',4,'{"summary":"Segunda investigación ampliada"}','d2000000-0000-4000-8000-000000000005'))->>'revision','5','segunda presentación crea otra revisión');
select is((select after_snapshot->>'investigation_summary' from public.custody_case_actions where command_id='d2000000-0000-4000-8000-000000000002'),'Primera investigación','segunda presentación conserva primera versión');
select is((select investigation_summary from public.custody_incidents where incident_id='d1000000-0000-4000-8000-000000000001'),'Segunda investigación ampliada','vista actual muestra segunda versión');
select throws_ok($$ update public.custody_case_actions set action_type='submit' $$,'42501',null,'cliente no puede reescribir bitácora');
select throws_ok($$ delete from public.custody_case_actions $$,'42501',null,'cliente no puede borrar bitácora');
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('add_evidence',5,'{"kind":"other","reference":null,"notes":"nota","actor_id":"inventado"}')) $$,'22023','invalid custody evidence','no se aceptan identidades o campos extra en detalle');

select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('request_evidence',2,'{"reason":"Revisión obsoleta"}')) $$,'40001','custody revision conflict','Dirección tampoco puede sobreescribir revisión obsoleta');
select is(public.record_custody_case_action(pg_temp.case_command('continue_investigation',5,'{"reason":"La causa aún no es concluyente"}','d2000000-0000-4000-8000-000000000006'))->>'revision','6','Dirección registra continuación con motivo');
select is(public.record_custody_case_action(current_setting('test.review')::jsonb)->>'revision','3','reintento devuelve revisión original aunque existan acciones posteriores');
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('authorize_loss',6,'{"reason":"No implementado"}')) $$,'22023','unsupported custody action','no se anuncia pérdida o corrección aplicada por revisar');
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('request_evidence',6,'{"reason":"   "}')) $$,'22023','invalid custody review','revisión requiere motivo real');
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('request_evidence',6,'{"reason":"Aún no se presentó de nuevo"}')) $$,'55000','custody action state conflict','solo se revisa una investigación presentada');
select is((select count(*)::integer from public.custody_case_actions),6,'solo seis comandos válidos tienen efecto');
select set_config('test.legacy_review',jsonb_set(pg_temp.case_command('request_evidence',0,'{"reason":"Ampliar antecedente anterior"}'),'{incident_id}','"d1000000-0000-4000-8000-000000000002"')::text,true);
select is(public.record_custody_case_action(current_setting('test.legacy_review')::jsonb)->>'revision','1','un expediente de v11 se puede revisar sin reset');
select is((select before_snapshot->>'investigation_summary' from public.custody_case_actions where incident_id='d1000000-0000-4000-8000-000000000002'),'Antecedente v11','se conserva la presentación previa a la migración');

select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000004',true);
select is((select count(*)::integer from public.custody_case_actions),0,'otra empresa no consulta la bitácora');
select throws_ok($$ select public.record_custody_case_action(pg_temp.case_command('add_evidence',6,'{"kind":"other","reference":null,"notes":"Intento ajeno"}')) $$,'42501','custody action forbidden','otra empresa no actúa sobre el expediente');
reset role;
update public.role_assignments set revoked_at=now() where membership_id='c3000000-0000-4000-8000-000000000003';
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000003',true);
select throws_ok($$ select public.record_custody_case_action(current_setting('test.review')::jsonb) $$,'42501','custody action forbidden','revocar rol impide recuperar un resultado anterior por RPC');
reset role;
insert into public.collection_transfers(transfer_id,company_id,site_id,house_id,lot_id,origin_business_date,quantity_sent,sent_from,sent_to,sent_by,sent_at)
values('d0000000-0000-4000-8000-000000000003','c2000000-0000-4000-8000-000000000001','c4000000-0000-4000-8000-000000000001','c5000000-0000-4000-8000-000000000001','c6000000-0000-4000-8000-000000000001','2026-10-27',2,'Galpón ficticio','Bodega ficticia','c1000000-0000-4000-8000-000000000001','2026-10-27T12:00Z');
set local role authenticated;
select set_config('request.jwt.claim.sub','c1000000-0000-4000-8000-000000000002',true);
select is(public.confirm_collection_transfer_receipt('d0000000-0000-4000-8000-000000000003',3,'Bodega ficticia','2026-10-27T13:00Z')->>'status','received','sobrante se registra como cantidad recibida real');
select is((select quantity_difference from public.custody_incidents where transfer_id='d0000000-0000-4000-8000-000000000003'),-1,'sobrante abre incidencia negativa y no crea producción');
reset role;
select * from finish();
rollback;
