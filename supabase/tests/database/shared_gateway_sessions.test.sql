begin;
select no_plan();
insert into auth.users(id,aud,role,email,created_at,updated_at)
values('d1000000-0000-4000-8000-000000000001','authenticated','authenticated','gateway-session@example.invalid',now(),now());
create function pg_temp.session_command(op text,rev integer default null,lease uuid default null)
returns jsonb language sql as $$
select jsonb_build_object('operation',op,'session_hash',repeat('a',64)) ||
case when rev is not null then jsonb_build_object('expected_revision',rev) else '{}'::jsonb end ||
case when op in ('claim','invalidate','save') then jsonb_build_object('lease_id',lease) else '{}'::jsonb end ||
case when op in ('create','save') then jsonb_build_object('envelope',jsonb_build_object('version',1,'key_id','v1','nonce',repeat('A',16),'tag',repeat('B',22),'ciphertext',repeat('C',64)),'access_expires_at',clock_timestamp()+interval '1 hour') else '{}'::jsonb end ||
case when op='create' then jsonb_build_object('user_id','d1000000-0000-4000-8000-000000000001','expires_at',clock_timestamp()+interval '2 hours') else '{}'::jsonb end;
$$;
set local role anon;
select throws_ok($$select public.gateway_session_command(pg_temp.session_command('read'))$$,'42501',null,'anon cannot read gateway sessions');
set local role authenticated;
select set_config('request.jwt.claims','{"role":"authenticated","sub":"d1000000-0000-4000-8000-000000000001"}',true);
select throws_ok($$select public.gateway_session_command(pg_temp.session_command('create'))$$,'42501',null,'authenticated user cannot create backend sessions');
select throws_ok($$select * from private.gateway_sessions$$,'42501',null,'authenticated direct table access denied');
set local role service_role;
select set_config('request.jwt.claims','{"role":"authenticated"}',true);
select throws_ok($$select public.gateway_session_command(pg_temp.session_command('read'))$$,'42501','gateway session access denied','function also checks privileged role claim');
select set_config('request.jwt.claims','{"role":"service_role"}',true);
select throws_ok($$select * from private.gateway_sessions$$,'42501',null,'service direct table access denied; narrow RPC only');
select is(public.gateway_session_command(pg_temp.session_command('create'))->>'status','created','backend creates encrypted session');
select is(public.gateway_session_command(pg_temp.session_command('read'))->>'status','present','session available from shared store');
select is(public.gateway_session_command(pg_temp.session_command('read'))->'session'->>'revision','1','initial version one');
select throws_ok($$select public.gateway_session_command(pg_temp.session_command('create'))$$,'23505',null,'hash cannot be reused or overwritten');
select throws_ok($$select public.gateway_session_command(pg_temp.session_command('create')||jsonb_build_object('session_hash',repeat('b',64),'expires_at',clock_timestamp()+interval '9 hours'))$$,'22023','invalid gateway session lifetime','lifetime cannot exceed existing eight hour bound');
select throws_ok($$select public.gateway_session_command(pg_temp.session_command('create')||jsonb_build_object('session_hash',repeat('b',64),'envelope','{"accessToken":"plaintext"}'::jsonb))$$,'22023','invalid gateway session creation','plaintext token payload rejected');
select throws_ok($$select public.gateway_session_command(pg_temp.session_command('read')||'{"extra":true}')$$,'22023','invalid gateway session command','unknown command fields rejected');
select is(public.gateway_session_command(pg_temp.session_command('claim',1,'d2000000-0000-4000-8000-000000000001'))->>'status','claimed','first refresh claims lease');
select is(public.gateway_session_command(pg_temp.session_command('read'))->'session'->>'revision','2','claim advances fencing version');
select is(public.gateway_session_command(pg_temp.session_command('claim',1,'d2000000-0000-4000-8000-000000000002'))->>'status','conflict','stale contender blocked');
select is(public.gateway_session_command(pg_temp.session_command('claim',2,'d2000000-0000-4000-8000-000000000002'))->>'status','busy','second owner cannot overlap lease');
select is(public.gateway_session_command(pg_temp.session_command('save',2))->>'status','busy','nonrefresh update cannot race active refresh');
select is(public.gateway_session_command(pg_temp.session_command('save',1,'d2000000-0000-4000-8000-000000000001'))->>'status','conflict','prelease tokens cannot overwrite');
select is(public.gateway_session_command(pg_temp.session_command('save',2,'d2000000-0000-4000-8000-000000000002'))->>'status','conflict','wrong lease owner cannot commit');
select is(public.gateway_session_command(pg_temp.session_command('save',2,'d2000000-0000-4000-8000-000000000001'))->>'status','saved','current owner saves tokens atomically');
select is(public.gateway_session_command(pg_temp.session_command('save',2,'d2000000-0000-4000-8000-000000000001'))->>'status','conflict','duplicate completion never writes twice');
select is(public.gateway_session_command(pg_temp.session_command('claim',3,'d2000000-0000-4000-8000-000000000001'))->>'status','claimed','next renewal obtains newer revision');
reset role;
-- Controlled elapsed-time fixture: do not wait or modify any real session.
update private.gateway_sessions set lease_until=clock_timestamp()-interval '1 second' where session_hash=repeat('a',64);
set local role service_role;
select is(public.gateway_session_command(pg_temp.session_command('save',4,'d2000000-0000-4000-8000-000000000001'))->>'status','conflict','expired owner cannot commit');
select is(public.gateway_session_command(pg_temp.session_command('claim',4,'d2000000-0000-4000-8000-000000000002'))->>'status','claimed','new owner recovers expired lease');
select is(public.gateway_session_command(pg_temp.session_command('invalidate',4,'d2000000-0000-4000-8000-000000000001'))->>'status','conflict','late failure cannot invalidate newer owner');
select is(public.gateway_session_command(pg_temp.session_command('save',5,'d2000000-0000-4000-8000-000000000002'))->>'status','saved','replacement owner commits');
select is(public.gateway_session_command(pg_temp.session_command('revoke'))->>'status','revoked','logout records revocation');
select is(public.gateway_session_command(pg_temp.session_command('read'))->>'status','absent','revoked session never read');
select is(public.gateway_session_command(pg_temp.session_command('save',6))->>'status','absent','late update cannot resurrect logout');
select throws_ok($$select public.gateway_session_command(pg_temp.session_command('create'))$$,'23505',null,'revocation tombstone prevents hash recreation');
reset role;
select is((select envelope is null from private.gateway_sessions where session_hash=repeat('a',64)),true,'revocation removes ciphertext');
-- Expiry fixture retains a valid created/expires interval; no fake wall clock.
update private.gateway_sessions set revoked_at=null,envelope=pg_temp.session_command('create')->'envelope',created_at=clock_timestamp()-interval '2 hours',expires_at=clock_timestamp()-interval '1 hour' where session_hash=repeat('a',64);
set local role service_role;
select is(public.gateway_session_command(pg_temp.session_command('read'))->>'status','absent','database clock rejects expired session');
select is(public.gateway_session_command(pg_temp.session_command('claim',7,'d2000000-0000-4000-8000-000000000002'))->>'status','absent','expired session cannot renew');
select * from finish();
rollback;
