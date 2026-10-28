import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

// Opt-in, disposable DEV-009B/010A Docker containers only. No shell, network service,
// external credentials or dependency installation is needed by this check.
const container = process.env.TAMAGO_CUSTODY_TEST_CONTAINER ?? "";
if (
  process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST !== "1" ||
  !/^supabase-tamago-(?:dev009b|dev010a)-[a-z0-9-]+-database-[a-f0-9]+$/.test(
    container,
  )
) {
  throw new Error(
    "Use an explicitly authorized disposable tamago-dev009b/dev010a database container.",
  );
}
const ids = Object.fromEntries(
  ["company", "user", "membership", "site", "house", "lot", "device"].map(
    (k) => [k, randomUUID()],
  ),
);

function connection() {
  const child = spawn(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "-X",
      "-qAt",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "",
    errors = "",
    ended = false;
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    errors += b;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      ended = true;
      clearTimeout(timer);
      resolve({ code, output, errors });
    });
  });
  return {
    child,
    done,
    async marker(marker) {
      const deadline = Date.now() + 10000;
      while (!output.includes(marker)) {
        if (ended || Date.now() > deadline)
          throw new Error(`Missing session marker: ${errors}`);
        await delay(20);
      }
    },
    async rollback() {
      if (!ended && !child.stdin.destroyed) child.stdin.end("\nrollback;\n");
      await done;
    },
  };
}
async function query(sql) {
  const session = connection();
  session.child.stdin.end(sql);
  const result = await session.done;
  assert.equal(result.code, 0, result.errors);
  return result.output.trim();
}
function transfer(date, id) {
  return {
    transfer_id: id,
    company_id: ids.company,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    origin_business_date: date,
    quantity_sent: 100,
    sent_from: "Galpon ficticio",
    sent_to: "Bodega ficticia",
    sent_at: `${date}T13:00:00Z`,
  };
}
function begin(name) {
  return `begin isolation level read committed; set application_name='${name}'; set local role authenticated; select set_config('request.jwt.claim.sub','${ids.user}',true);\n`;
}
async function race(date, retry) {
  const id = randomUUID();
  const a = connection(),
    b = connection();
  const application = `tamago_custody_${randomUUID().replaceAll("-", "")}`;
  try {
    a.child.stdin.write(
      `${begin(`${application}_a`)}select public.dispatch_collection_transfer('${JSON.stringify(transfer(date, id))}'::jsonb);\n\\echo FIRST_READY\n`,
    );
    await a.marker("FIRST_READY");
    const command = transfer(date, retry ? id : randomUUID());
    b.child.stdin.end(
      `${begin(application)}select public.dispatch_collection_transfer('${JSON.stringify(command)}'::jsonb)->>'duplicate'; commit;\n`,
    );
    let blocked = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      blocked =
        (await query(
          `select exists(select 1 from pg_stat_activity where application_name='${application}' and wait_event_type='Lock' and wait_event='advisory');`,
        )) === "t";
      if (blocked) break;
      await delay(50);
    }
    assert.equal(
      blocked,
      true,
      "Second real SQL session must wait on the origin advisory lock.",
    );
    a.child.stdin.end("commit;\n");
    assert.equal((await a.done).code, 0);
    const second = await b.done;
    if (retry) {
      assert.equal(second.code, 0, second.errors);
      assert.equal(second.output.trim().split("\n").at(-1), "true");
    } else {
      assert.notEqual(second.code, 0);
      assert.match(second.errors, /transfer exceeds confirmed daily origin/);
    }
    assert.equal(
      await query(
        `select count(*)::text || ':' || sum(quantity_sent)::text from public.collection_transfers where company_id='${ids.company}' and origin_business_date='${date}';`,
      ),
      "1:100",
    );
    console.log(
      retry
        ? "PASS: concurrent retry yields one transfer and duplicate=true."
        : "PASS: concurrent distinct transfers cannot oversend the daily origin.",
    );
  } finally {
    await Promise.allSettled([a.rollback(), b.rollback()]);
  }
}

try {
  await query(`begin;
insert into auth.users(id,aud,role,email,created_at,updated_at) values('${ids.user}','authenticated','authenticated','${ids.user}@example.invalid',now(),now());
insert into public.companies(id,code,legal_name) values('${ids.company}','TEST-RACE-${ids.company.slice(0, 8).toUpperCase()}','Empresa ficticia de concurrencia');
insert into public.company_memberships(id,company_id,user_id,status) values('${ids.membership}','${ids.company}','${ids.user}','active');
insert into public.sites(id,company_id,code,name) values('${ids.site}','${ids.company}','SITE-RACE','Sede ficticia');
insert into public.houses(id,company_id,site_id,code,name) values('${ids.house}','${ids.company}','${ids.site}','HOUSE-RACE','Galpon ficticio');
insert into public.lots(id,company_id,site_id,house_id,code,status) values('${ids.lot}','${ids.company}','${ids.site}','${ids.house}','LOT-RACE','active');
insert into public.role_assignments(company_id,membership_id,role_key,site_id,house_id,lot_id) values('${ids.company}','${ids.membership}','capture','${ids.site}','${ids.house}','${ids.lot}');
insert into public.collection_events(event_id,company_id,site_id,house_id,lot_id,business_date,occurrence,quantity_eggs,occurred_at,captured_at,actor_declared_id,device_id,captured_by)
select gen_random_uuid(),'${ids.company}','${ids.site}','${ids.house}','${ids.lot}',date,1,100,date::timestamptz+interval '12 hours',date::timestamptz+interval '12 hours','ficticio','${ids.device}','${ids.user}' from (values('2026-10-26'::date),('2026-10-27'::date)) dates(date);
commit;`);
  await race("2026-10-26", false);
  await race("2026-10-27", true);
} finally {
  await query(`begin;
delete from public.collection_transfers where company_id='${ids.company}';
delete from public.collection_events where company_id='${ids.company}';
delete from public.role_assignments where company_id='${ids.company}';
delete from public.company_memberships where company_id='${ids.company}';
delete from public.lots where company_id='${ids.company}';
delete from public.houses where company_id='${ids.company}';
delete from public.sites where company_id='${ids.company}';
delete from public.companies where id='${ids.company}';
delete from auth.users where id='${ids.user}';
commit;`);
}
