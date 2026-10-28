import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

const enabled =
  process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
  process.env.TAMAGO_ALLOW_LOCAL_MIGRATION_TEST === "1" &&
  process.env.TAMAGO_CUSTODY_TEST_ENV_FILE;
const canonical = (v) => JSON.stringify(normal(v));
function normal(v) {
  if (Array.isArray(v)) return v.map(normal);
  if (v && typeof v === "object")
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, normal(v[k])]),
    );
  return v;
}
const hash = (v) => createHash("sha256").update(canonical(v)).digest("hex");
const ordered = (rows) =>
  rows.toSorted((a, b) => canonical(a).localeCompare(canonical(b)));

test("populated026 to027: rollback restores writers, exact history/session preserved, explicit book activation and compensation", {
  skip: enabled ? false : "Requires disposable026 migration opt-in",
  timeout: 180000,
}, async () => {
  const container = process.env.TAMAGO_MIGRATION_TEST_CONTAINER;
  assert.match(
    container ?? "",
    /^supabase-tamago-dev012l-upgrade-[a-z0-9-]+-database-[a-f0-9]+$/,
  );
  const sql = (input) =>
    spawnSync(
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
      { input, encoding: "utf8", timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    );
  const scalar = (query) => {
    const r = sql(query);
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.equal(
    scalar(
      "select (to_regclass('public.feed_inventory_accounts') is null)::text||':'||(to_regclass('public.feed_inventory_revisions') is not null)::text;",
    ),
    "true:true",
    "Must begin from026",
  );
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/202610280027_feed_inventory_book.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const f = await startRealCustodyFixture({ seedTransfers: false });
  let browser;
  try {
    const { ids, users } = f,
      scope = {
        company_id: ids.company,
        site_id: ids.site,
        house_id: ids.house,
        lot_id: ids.lot,
      };
    assert.equal(
      scalar(
        `select exists(select 1 from public.companies where id='${ids.company}');`,
      ),
      "t",
      "API and migration target must match",
    );
    const rpc = (name, event, role = "director") =>
      f.rpc(name, { p_event: event }, users[role].token);
    const item = (code) => ({
      ...scope,
      format: "tamago.feed-catalog-item",
      schema_version: 1,
      item_id: randomUUID(),
      kind: "product",
      code,
      label: `SYN-${code}`,
      unit: "BAG_40KG",
      reason: "SYN-Antes027",
    });
    const p1 = item("F1"),
      p2 = item("F2"),
      loc = { ...item("L1"), kind: "location", unit: null };
    for (const e of [p1, p2, loc]) await rpc("record_feed_catalog_item", e);
    const opening = (quantity) => ({
      ...scope,
      format: "tamago.feed-opening-count",
      schema_version: 1,
      opening_id: randomUUID(),
      count_id: randomUUID(),
      business_date: "2026-10-27",
      cutoff_at: "2026-10-27T12:00:00.000Z",
      product_declared: "SYN-Original",
      location_declared: "SYN-L1",
      quantity,
      unit: "BAG_40KG",
      evidence_reference: "SYN-Acta previa027",
      notes: null,
      expected_revision: 0,
      previous_count_id: null,
    });
    const count = opening("10"),
      pending = opening("0");
    for (const e of [count, pending])
      await rpc("record_feed_opening_count", e, "capture");
    await rpc("approve_feed_opening", {
      format: "tamago.feed-opening-approval",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      opening_id: count.opening_id,
      count_id: count.count_id,
      expected_revision: 1,
      reason: "SYN-Aprobación previa027",
    });
    const bind = (kind, id, product = p1.item_id) => ({
      format: "tamago.feed-fact-binding",
      schema_version: 1,
      binding_id: randomUUID(),
      company_id: ids.company,
      source_kind: kind,
      source_id: id,
      product_id: product,
      location_id: loc.item_id,
      reason: "SYN-Vínculo previo027",
    });
    await rpc("bind_feed_fact", bind("count", count.count_id));
    async function move(
      kind,
      quantity,
      clock = "13:00:00",
      product = p1.item_id,
    ) {
      const e = {
        ...scope,
        schema_version: 1,
        event_id: randomUUID(),
        business_date: "2026-10-27",
        occurred_at: `2026-10-27T${clock}.000Z`,
        product_declared: "SYN-Original",
        quantity,
        unit: "BAG_40KG",
        physical_batch_declared: null,
        notes: null,
        ...(kind === "delivery"
          ? {
              format: "tamago.feed-delivery",
              location_declared: "SYN-L1",
              supplier_declared: null,
              delivery_reference_declared: null,
            }
          : { source_declared: "SYN-L1" }),
      };
      const name =
        kind === "delivery" ? "record_feed_delivery" : "record_feed_supply";
      const ack = await rpc(name, e, "capture"),
        mapping = bind(kind, e.event_id, product);
      await rpc("bind_feed_fact", mapping);
      return { e, mapping, ack, name };
    }
    const prior = await move("delivery", "10", "10:00:00"),
      post = await move("delivery", "3"),
      supply = await move("supply", "1.25", "14:00:00"),
      tie = await move("delivery", "2", "12:00:00"),
      rebound = await move("delivery", "4", "15:00:00", p2.item_id);
    const correction = {
      format: "tamago.feed-inventory-correction",
      schema_version: 1,
      revision_id: randomUUID(),
      company_id: ids.company,
      target_kind: "binding",
      target_id: rebound.mapping.binding_id,
      expected_revision: 0,
      previous_revision_id: null,
      product_id: p1.item_id,
      location_id: loc.item_id,
      reason: "SYN-Revisión026 vigente",
    };
    await rpc("correct_feed_inventory", correction);
    const decision = {
      format: "tamago.feed-cutoff-decision",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      opening_id: count.opening_id,
      count_id: count.count_id,
      source_kind: "delivery",
      source_id: tie.e.event_id,
      classification: "after_count",
      expected_opening_binding_revision: 0,
      expected_movement_binding_revision: 0,
      reason: "SYN-Empate026",
    };
    await rpc("record_feed_cutoff_decision", decision);
    const tieCorrection = {
      ...correction,
      revision_id: randomUUID(),
      target_kind: "cutoff",
      target_id: decision.action_id,
      product_id: null,
      location_id: null,
      classification: "included_in_count",
      expected_opening_binding_revision: 0,
      expected_movement_binding_revision: 0,
      reason: "SYN-Empate revisado026",
    };
    // Cutoff revisions carry classification only.
    delete tieCorrection.product_id;
    delete tieCorrection.location_id;
    await rpc("correct_feed_inventory", tieCorrection);
    const tables = [
      "feed_catalog_items",
      "feed_supply_events",
      "feed_delivery_events",
      "feed_openings",
      "feed_opening_counts",
      "feed_opening_approvals",
      "feed_fact_bindings",
      "feed_cutoff_decisions",
      "feed_inventory_revisions",
      "company_memberships",
      "role_assignments",
    ];
    const snapshot = async () =>
      Object.fromEntries(
        await Promise.all(
          tables.map(async (t) => [
            t,
            ordered(
              await f.provider(`/rest/v1/${t}?company_id=eq.${ids.company}`),
            ),
          ]),
        ),
      );
    const before = await snapshot();
    const args = {
      p_company_id: ids.company,
      p_opening_id: count.opening_id,
      p_through_at: "2026-10-27T17:00:00.000Z",
    };
    const preview = () =>
      f.rpc("get_feed_balance_preview", args, users.capture.token);
    const previewBefore = await preview();
    assert.equal(previewBefore.balance_bags, "15.75");
    const writers = () =>
      scalar(
        "select jsonb_agg(jsonb_build_object('oid',p.oid,'namespace',n.nspname,'name',p.proname,'body',pg_get_functiondef(p.oid),'acl',p.proacl,'owner',p.proowner) order by p.oid)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') and p.proname in ('record_feed_supply','record_feed_delivery','record_feed_supply_prebook','record_feed_delivery_prebook');",
      );
    const originalWriters = writers();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const page = await (
      await browser.newContext({ viewport: { width: 390, height: 844 } })
    ).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${f.origin}/experimental/feed-inventory/`);
    await page.locator("#loginPanel").waitFor({ state: "visible" });
    await page.locator("#loginForm [name=email]").fill(users.director.email);
    await page
      .locator("#loginForm [name=password]")
      .fill(users.director.password);
    await page.locator("#loginForm button").click();
    const ready = () =>
      page.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
    await page.locator("#workspace").waitFor({ state: "visible" });
    await ready();
    await page.locator("#lot").selectOption(ids.lot);
    await ready();
    const identity = await page.locator("#identity").textContent();
    let r = sql(`begin;\n${migration}\nselect 1/0;\ncommit;`);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /division by zero/);
    assert.equal(
      scalar("select to_regclass('public.feed_inventory_accounts') is null;"),
      "t",
    );
    assert.equal(writers(), originalWriters);
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(await preview(), previewBefore);
    // Exercise original writer after rollback, without modifying existing snapshot rows.
    assert.equal((await rpc(supply.name, supply.e, "capture")).duplicate, true);
    r = sql(`begin;\n${migration}\nnotify pgrst, 'reload schema';\ncommit;`);
    assert.equal(r.status, 0, r.stderr);
    let refreshed = false;
    for (let n = 0; n < 50; n++) {
      try {
        await f.provider(
          "/rest/v1/feed_inventory_accounts?select=account_id&limit=1",
        );
        refreshed = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(refreshed, true);
    assert.deepEqual(await snapshot(), before);
    const after = await snapshot();
    assert.equal(hash(after), hash(before));
    assert.deepEqual(await preview(), previewBefore);
    assert.equal(
      scalar("select count(*) from public.feed_inventory_accounts;"),
      "0",
      "No automatic activation",
    );
    await page.locator("#refreshAccount").click();
    await ready();
    assert.equal(await page.locator("#identity").textContent(), identity);
    for (const source of [prior, post, supply, tie, rebound]) {
      const ack = await rpc(source.name, source.e, "capture");
      assert.equal(ack.duplicate, true);
      assert.equal(ack.event.event_id, source.ack.event.event_id);
      const { duplicate: _duplicate, ...actual } = ack;
      const { duplicate: _originalDuplicate, ...expected } = source.ack;
      assert.deepEqual(actual, expected);
    }
    const review = () =>
      f.rpc("get_feed_ledger_review", args, users.director.token);
    let v = await review();
    assert.equal(v.status, "needs_activation");
    assert.equal(v.proposed_balance_bags, "15.75");
    await page.locator("#bookLookup [name=id]").fill(count.opening_id);
    await page.locator("#bookLookup [name=date]").fill("2026-10-27");
    await page.locator("#bookLookup [name=time]").fill("12:00");
    await page.locator("#bookLookup button").click();
    await ready();
    assert.match(
      await page.locator("#bookProposal").textContent(),
      /15,?\.?75 bultos/,
    );
    await page
      .locator("#bookForm [name=reason]")
      .fill("SYN-Primera activación tras026→027");
    await page.locator("#bookForm button").click();
    await ready();
    await page.locator("#confirm").click();
    await ready();
    await page.locator("#intentPanel").waitFor({ state: "hidden" });
    v = await review();
    assert.equal(v.status, "current");
    assert.equal(v.book_balance_bags, "15.75");
    const [activation] = await f.provider(
      `/rest/v1/feed_ledger_operations?company_id=eq.${ids.company}&revision=eq.1`,
    );
    assert.equal(
      (await rpc("apply_feed_ledger", activation.event_payload)).duplicate,
      true,
    );
    await page
      .locator("#bookContext")
      .screenshot({ path: "evidence/dev012m-libro-migrado-mobile.png" });
    const account = v.account.account_id;
    const posting = (v) => ({
      format: "tamago.feed-inventory-posting",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      account_id: account,
      expected_revision: v.revision,
      through_at: args.p_through_at,
      review_token: v.review_token,
      reason: "SYN-Compensación posterior027",
    });
    await rpc("correct_feed_inventory", {
      ...correction,
      revision_id: randomUUID(),
      expected_revision: 1,
      previous_revision_id: correction.revision_id,
      product_id: p2.item_id,
      reason: "SYN-Devolver pertenencia tras027",
    });
    v = await review();
    assert.equal(v.book_balance_bags, "15.75");
    assert.equal(v.proposed_balance_bags, "11.75");
    const postCommand = posting(v);
    const postAck = await rpc("apply_feed_ledger", postCommand);
    assert.equal(postAck.balance_bags, "11.75");
    assert.equal((await rpc("apply_feed_ledger", postCommand)).duplicate, true);
    const excessive = await move("supply", "100", "16:00:00");
    v = await review();
    assert.equal(v.status, "insufficient");
    assert.equal(v.book_balance_bags, "11.75");
    assert.equal(v.available_bags, null);
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_supply_events?event_id=eq.${excessive.e.event_id}`,
        )
      ).length,
      1,
    );
    for (const t of tables) {
      const current = (await snapshot())[t];
      for (const row of before[t])
        assert.ok(
          current.some((x) => canonical(x) === canonical(row)),
          `Original altered in ${t}`,
        );
    }
    assert.equal(
      await f.rpc("get_feed_ledger_review", args, users.foreign.token),
      null,
    );
    await assert.rejects(
      rpc("apply_feed_ledger", activation.event_payload, "capture"),
      /403/,
    );
    assert.equal(
      scalar(
        "select has_function_privilege('authenticated','private.record_feed_supply_prebook(jsonb)','execute') or has_function_privilege('authenticated','private.record_feed_delivery_prebook(jsonb)','execute');",
      ),
      "f",
    );
    await page.locator("#bookLookup button").click();
    await ready();
    assert.match(
      await page.locator("#bookState").textContent(),
      /saldo|insuficiente/i,
    );
    assert.equal(await page.locator("#bookForm").isVisible(), false);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    await writeFile(
      "evidence/dev012m-migracion.json",
      `${JSON.stringify(
        {
          format: "tamago.feed-book-upgrade-evidence",
          schema_version: 1,
          environment: "local-fictitious",
          from: 26,
          to: 27,
          migration_sha256: createHash("sha256")
            .update(migration)
            .digest("hex"),
          rollback_verified: true,
          writer_definitions_and_privileges_restored: true,
          preexisting_hash: hash(before),
          postupgrade_hash: hash(after),
          preserved_tables: Object.fromEntries(
            tables.map((t) => [t, before[t].length]),
          ),
          session_preserved: true,
          automatic_activation: false,
          first_book_bags: "15.75",
          compensated_book_bags: "11.75",
          insufficient_supply_preserved: true,
          physical_device_tested: false,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await browser?.close();
    // Fixture marker uses026 cleanup. Remove only this fixture's027 descendants if migration committed.
    if (
      scalar(
        "select to_regclass('public.feed_ledger_entries') is not null;",
      ) === "t"
    ) {
      for (const table of [
        "feed_ledger_entries",
        "feed_ledger_operations",
        "feed_inventory_accounts",
      ])
        await f.provider(`/rest/v1/${table}?company_id=eq.${f.ids.company}`, {
          method: "DELETE",
        });
    }
    await f.close();
  }
});
