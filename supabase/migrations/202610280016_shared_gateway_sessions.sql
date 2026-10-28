-- DEV-011A: backend-only encrypted session primitive, not identity verification.
-- No existing sessions are moved and no application gateway switches storage.
create table private.gateway_sessions (
  session_hash text primary key check(session_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  envelope jsonb,
  created_at timestamptz not null default statement_timestamp(),
  expires_at timestamptz not null,
  access_expires_at timestamptz not null,
  revision bigint not null default 1 check(revision>0),
  revoked_at timestamptz,
  lease_id uuid,
  lease_until timestamptz,
  check(expires_at>created_at and expires_at<=created_at+interval '8 hours'),
  check((lease_id is null)=(lease_until is null)),
  check((revoked_at is null and envelope is not null) or (revoked_at is not null and envelope is null))
);
create index gateway_sessions_expiry_idx on private.gateway_sessions(expires_at);
alter table private.gateway_sessions enable row level security;
alter table private.gateway_sessions force row level security;
revoke all on private.gateway_sessions from public,anon,authenticated,service_role;

create function private.valid_gateway_envelope(value jsonb)
returns boolean language sql immutable set search_path='' as $$
 select coalesce(jsonb_typeof(value)='object'
   and (value-array['version','key_id','nonce','tag','ciphertext'])='{}'::jsonb
   and value ?& array['version','key_id','nonce','tag','ciphertext']
   and value->'version'='1'::jsonb
   and jsonb_typeof(value->'key_id')='string' and value->>'key_id' ~ '^[A-Za-z0-9._-]{1,64}$'
   and jsonb_typeof(value->'nonce')='string' and value->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
   and jsonb_typeof(value->'tag')='string' and value->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
   and jsonb_typeof(value->'ciphertext')='string' and length(value->>'ciphertext') between 1 and 22000 and value->>'ciphertext' ~ '^[A-Za-z0-9_-]+$',false);
$$;
revoke all on function private.valid_gateway_envelope(jsonb) from public,anon,authenticated,service_role;

create function public.gateway_session_command(p_command jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
 operation text; hash_value text; row_value private.gateway_sessions%rowtype;
 user_value uuid; expiry_value timestamptz; access_value timestamptz;
 revision_value bigint; lease_value uuid;
 time_value timestamptz:=statement_timestamp();
begin
 if (select auth.role()) is distinct from 'service_role' then
   raise exception using errcode='42501',message='gateway session access denied';end if;
 if p_command is null or jsonb_typeof(p_command) is distinct from 'object' or octet_length(p_command::text)>32768 then
   raise exception using errcode='22023',message='invalid gateway session command';end if;
 operation:=p_command->>'operation'; hash_value:=p_command->>'session_hash';
 if operation is null or operation not in ('create','read','claim','save','revoke','invalidate')
   or jsonb_typeof(p_command->'session_hash') is distinct from 'string' or hash_value !~ '^[0-9a-f]{64}$'
   or (p_command-array['operation','session_hash','user_id','expires_at','access_expires_at','envelope','expected_revision','lease_id'])<>'{}'::jsonb then
   raise exception using errcode='22023',message='invalid gateway session command';end if;
 if operation='create' then
   if (p_command-array['operation','session_hash','user_id','expires_at','access_expires_at','envelope'])<>'{}'::jsonb
     or not(p_command ?& array['user_id','expires_at','access_expires_at','envelope'])
     or not private.valid_gateway_envelope(p_command->'envelope') then
     raise exception using errcode='22023',message='invalid gateway session creation';end if;
   begin
    user_value:=(p_command->>'user_id')::uuid;
    expiry_value:=(p_command->>'expires_at')::timestamptz;
    access_value:=(p_command->>'access_expires_at')::timestamptz;
   exception when others then raise exception using errcode='22023',message='invalid gateway session creation';end;
   if user_value is null or expiry_value is null or access_value is null or not isfinite(expiry_value) or not isfinite(access_value)
     or expiry_value<=time_value or expiry_value>time_value+interval '8 hours' or access_value>time_value+interval '24 hours' then
     raise exception using errcode='22023',message='invalid gateway session lifetime';end if;
   insert into private.gateway_sessions(session_hash,user_id,envelope,expires_at,access_expires_at)
   values(hash_value,user_value,p_command->'envelope',expiry_value,access_value);
   return jsonb_build_object('status','created','revision',1);
 end if;
 if operation in ('read','revoke') and (p_command-array['operation','session_hash'])<>'{}'::jsonb then
   raise exception using errcode='22023',message='invalid gateway session command';end if;
 select * into row_value from private.gateway_sessions where session_hash=hash_value for update;
 time_value:=clock_timestamp();
 if row_value.session_hash is null or row_value.revoked_at is not null or row_value.expires_at<=time_value then
   return jsonb_build_object('status','absent');end if;
 if operation='revoke' then
   update private.gateway_sessions set revoked_at=time_value,envelope=null,revision=revision+1,lease_id=null,lease_until=null where session_hash=hash_value;
   return jsonb_build_object('status','revoked');
 end if;
 if operation='read' then
   return jsonb_build_object('status','present','session',to_jsonb(row_value)-array['revoked_at','lease_id','lease_until']);end if;
 if jsonb_typeof(p_command->'expected_revision') is distinct from 'number'
   or (p_command->>'expected_revision') !~ '^[1-9][0-9]{0,14}$' then
   raise exception using errcode='22023',message='invalid gateway session revision';end if;
 revision_value:=(p_command->>'expected_revision')::bigint;
 if row_value.revision<>revision_value then return jsonb_build_object('status','conflict');end if;
 if operation='claim' then
   if (p_command-array['operation','session_hash','expected_revision','lease_id'])<>'{}'::jsonb
     or jsonb_typeof(p_command->'lease_id') is distinct from 'string' then
     raise exception using errcode='22023',message='invalid gateway session lease';end if;
   begin lease_value:=(p_command->>'lease_id')::uuid;
   exception when others then raise exception using errcode='22023',message='invalid gateway session lease';end;
   if row_value.lease_until>time_value then return jsonb_build_object('status','busy');end if;
   update private.gateway_sessions set revision=revision+1,lease_id=lease_value,lease_until=time_value+interval '30 seconds'
     where session_hash=hash_value returning * into row_value;
   return jsonb_build_object('status','claimed','lease_id',lease_value,'session',to_jsonb(row_value)-array['revoked_at','lease_id','lease_until']);
 end if;
 if operation='invalidate' then
   if (p_command-array['operation','session_hash','expected_revision','lease_id'])<>'{}'::jsonb then
     raise exception using errcode='22023',message='invalid gateway session lease';end if;
   begin lease_value:=(p_command->>'lease_id')::uuid;
   exception when others then raise exception using errcode='22023',message='invalid gateway session lease';end;
   if lease_value is null or row_value.lease_id is distinct from lease_value then
     return jsonb_build_object('status','conflict');end if;
   update private.gateway_sessions set revoked_at=time_value,envelope=null,revision=revision+1,lease_id=null,lease_until=null where session_hash=hash_value;
   return jsonb_build_object('status','revoked');
 end if;
 if operation='save' then
   if (p_command-array['operation','session_hash','expected_revision','lease_id','access_expires_at','envelope'])<>'{}'::jsonb
     or not(p_command ?& array['lease_id','access_expires_at','envelope'])
     or not private.valid_gateway_envelope(p_command->'envelope') then
     raise exception using errcode='22023',message='invalid gateway session replacement';end if;
   begin lease_value:=(p_command->>'lease_id')::uuid;access_value:=(p_command->>'access_expires_at')::timestamptz;
   exception when others then raise exception using errcode='22023',message='invalid gateway session replacement';end;
   if access_value is null or not isfinite(access_value) or access_value<=time_value or access_value>time_value+interval '24 hours' then
     raise exception using errcode='22023',message='invalid gateway session lifetime';end if;
   if lease_value is not null then
     if row_value.lease_id is distinct from lease_value or row_value.lease_until<=time_value then
       return jsonb_build_object('status','conflict');end if;
   elsif row_value.lease_id is not null then return jsonb_build_object('status','busy');end if;
   update private.gateway_sessions set envelope=p_command->'envelope',access_expires_at=access_value,
     revision=revision+1,lease_id=null,lease_until=null where session_hash=hash_value returning * into row_value;
   return jsonb_build_object('status','saved','revision',row_value.revision);
 end if;
 raise exception using errcode='22023',message='invalid gateway session command';
end;
$$;
revoke all on function public.gateway_session_command(jsonb) from public,anon,authenticated;
grant execute on function public.gateway_session_command(jsonb) to service_role;
comment on table private.gateway_sessions is 'Backend-only encrypted tokens. Not an identity provider; additive experimental store, no migration of existing local sessions. Revocation retains tombstones until explicit retention work is designed.';
