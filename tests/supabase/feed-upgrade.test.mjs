import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
test("populated025 to026: atomic rollback, preserved facts/session/RLS and complete feed UI journey", {
  skip: enabled ? false : "Requires explicit disposable025 migration opt-in",
  timeout: 180000,
}, async () => {
  const container = process.env.TAMAGO_MIGRATION_TEST_CONTAINER;
  assert.match(
    container ?? "",
    /^supabase-tamago-dev012g-upgrade-[a-z0-9-]+-database-[a-f0-9]+$/,
  );
  function sql(input) {
    return spawnSync(
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
  }
  let result = sql(
    "select (to_regclass('public.feed_inventory_revisions') is null)::text||':'||(to_regprocedure('public.get_feed_inventory_context(uuid,uuid)') is not null)::text;",
  );
  assert.equal(result.status, 0);
  assert.equal(
    result.stdout.trim(),
    "true:true",
    "Must start from025, not an already migrated database",
  );
  const migration = await readFile(
    new URL(
      "../../supabase/migrations/202610280026_feed_inventory_revisions.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const f = await startRealCustodyFixture({ seedTransfers: false });
  let browser, diagnosticPage;
  try {
    const { ids, users } = f,
      scope = {
        company_id: ids.company,
        site_id: ids.site,
        house_id: ids.house,
        lot_id: ids.lot,
      };
    const aligned = sql(
      `select exists(select 1 from public.companies where id='${ids.company}');`,
    );
    assert.equal(aligned.status, 0);
    assert.equal(
      aligned.stdout.trim(),
      "t",
      "API and migration container must be the same disposable database",
    );
    const item = (kind, code) => ({
      format: "tamago.feed-catalog-item",
      schema_version: 1,
      item_id: randomUUID(),
      ...scope,
      kind,
      code,
      label: `SYN-${code}`,
      unit: kind === "product" ? "BAG_40KG" : null,
      reason: "SYN-Alta anterior a026",
    });
    const p1 = item("product", "F1"),
      p2 = item("product", "F2"),
      loc = item("location", "L1");
    for (const e of [p1, p2, loc])
      await f.rpc(
        "record_feed_catalog_item",
        { p_event: e },
        users.director.token,
      );
    const opening = (quantity, product) => ({
      ...scope,
      format: "tamago.feed-opening-count",
      schema_version: 1,
      opening_id: randomUUID(),
      count_id: randomUUID(),
      business_date: "2026-10-28",
      cutoff_at: "2026-10-28T12:00:00.000Z",
      product_declared: product,
      location_declared: "SYN-L1 original",
      quantity,
      unit: "BAG_40KG",
      evidence_reference: "SYN-Acta anterior026",
      notes: null,
      expected_revision: 0,
      previous_count_id: null,
    });
    const count = opening("10", "SYN-F1 original"),
      pending = opening("0", "SYN-F2 original");
    for (const e of [count, pending])
      await f.rpc(
        "record_feed_opening_count",
        { p_event: e },
        users.capture.token,
      );
    await f.rpc(
      "approve_feed_opening",
      {
        p_event: {
          format: "tamago.feed-opening-approval",
          schema_version: 1,
          action_id: randomUUID(),
          company_id: ids.company,
          opening_id: count.opening_id,
          count_id: count.count_id,
          expected_revision: 1,
          reason: "SYN-Aprobado antes026",
        },
      },
      users.director.token,
    );
    async function move(kind, q, time) {
      const e = {
        ...scope,
        schema_version: 1,
        event_id: randomUUID(),
        business_date: "2026-10-28",
        occurred_at: `2026-10-28T${time}.000Z`,
        product_declared: "SYN-F1 original",
        quantity: q,
        unit: "BAG_40KG",
        physical_batch_declared: null,
        notes: null,
        ...(kind === "delivery"
          ? {
              format: "tamago.feed-delivery",
              location_declared: "SYN-L1 original",
              supplier_declared: null,
              delivery_reference_declared: null,
            }
          : { source_declared: "SYN-L1 original" }),
      };
      await f.rpc(
        kind === "delivery" ? "record_feed_delivery" : "record_feed_supply",
        { p_event: e },
        users.capture.token,
      );
      return e;
    }
    const prior = await move("delivery", "10", "10:00:00"),
      post = await move("delivery", "2.5", "13:00:00"),
      tie = await move("delivery", "3", "12:00:00"),
      supply = await move("supply", "1.25", "14:00:00"),
      tieSupply = await move("supply", "0.5", "12:00:00");
    const binding = (kind, id) => ({
      format: "tamago.feed-fact-binding",
      schema_version: 1,
      binding_id: randomUUID(),
      company_id: ids.company,
      source_kind: kind,
      source_id: id,
      product_id: p1.item_id,
      location_id: loc.item_id,
      reason: "SYN-Vínculo anterior026",
    });
    const mappings = [
      binding("count", count.count_id),
      binding("delivery", prior.event_id),
      binding("delivery", post.event_id),
      binding("delivery", tie.event_id),
      binding("supply", supply.event_id),
      binding("supply", tieSupply.event_id),
    ];
    for (const e of mappings)
      await f.rpc("bind_feed_fact", { p_event: e }, users.director.token);
    const legacy = {
      format: "tamago.feed-cutoff-decision",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      opening_id: count.opening_id,
      count_id: count.count_id,
      source_kind: "delivery",
      source_id: tie.event_id,
      classification: "after_count",
      reason: "SYN-Decisiónlegacy anterior026",
    };
    await f.rpc(
      "record_feed_cutoff_decision",
      { p_event: legacy },
      users.director.token,
    );
    const tables = [
      "feed_catalog_items",
      "feed_supply_events",
      "feed_delivery_events",
      "feed_openings",
      "feed_opening_counts",
      "feed_opening_approvals",
      "feed_fact_bindings",
      "feed_cutoff_decisions",
      "company_memberships",
      "role_assignments",
    ];
    async function snapshot() {
      return Object.fromEntries(
        await Promise.all(
          tables.map(async (table) => [
            table,
            ordered(
              await f.provider(
                `/rest/v1/${table}?company_id=eq.${ids.company}`,
              ),
            ),
          ]),
        ),
      );
    }
    const before = await snapshot(),
      previewArgs = {
        p_company_id: ids.company,
        p_opening_id: count.opening_id,
        p_through_at: "2026-10-28T17:00:00.000Z",
      };
    const semantic = (v) => ({
      ...v,
      blockers: v.blockers.map(({ source_kind, source_id, problem }) => ({
        source_kind,
        source_id,
        problem,
      })),
    });
    const previewBefore = await f.rpc(
      "get_feed_balance_preview",
      previewArgs,
      users.capture.token,
    );
    assert.equal(previewBefore.pending_tie_count, 1);
    assert.equal(previewBefore.diagnostic_balance_bags, "14.25");
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const cap = await (
        await browser.newContext({ viewport: { width: 390, height: 844 } })
      ).newPage(),
      dir = await (
        await browser.newContext({ viewport: { width: 1280, height: 900 } })
      ).newPage(),
      errors = [];
    diagnosticPage = dir;
    for (const p of [cap, dir])
      p.on("pageerror", (e) => errors.push(e.message));
    const ready = (p) =>
      p.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
    async function visit(p, path, role) {
      await p.goto(f.origin + path);
      await p.waitForFunction(
        () =>
          !document.querySelector("#loginPanel").hidden ||
          (!document.querySelector("#workspace").hidden &&
            !document.querySelector("#refreshAccount").disabled),
      );
      if (await p.locator("#loginPanel").isVisible()) {
        await p.locator("#loginForm [name=email]").fill(users[role].email);
        await p
          .locator("#loginForm [name=password]")
          .fill(users[role].password);
        await p.locator("#loginForm button").click();
        await p.locator("#workspace").waitFor({ state: "visible" });
      }
      await ready(p);
      await p.locator("#lot").selectOption(ids.lot);
      await ready(p);
    }
    async function reviewIntake(p, form) {
      await p.locator(`#${form} button[type=submit]`).click();
      await ready(p);
      await p.locator("#intentPanel").waitFor({ state: "visible" });
    }
    async function confirmIntake(p) {
      await p.locator("#confirmIntent").click();
      await ready(p);
      await p.locator("#intentPanel").waitFor({ state: "hidden" });
    }
    await visit(cap, "/experimental/feed-intake/", "capture");
    const identityBefore = await cap.locator("#identity").textContent();
    // Failed migration must roll back DDL/functions as well as leave all populated facts untouched.
    result = sql(`begin;\n${migration}\nselect 1/0;\ncommit;`);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /division by zero/);
    assert.equal(
      sql(
        "select to_regclass('public.feed_inventory_revisions') is null;",
      ).stdout.trim(),
      "t",
    );
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(
      semantic(
        await f.rpc(
          "get_feed_balance_preview",
          previewArgs,
          users.capture.token,
        ),
      ),
      semantic(previewBefore),
    );
    result = sql(
      `begin;\n${migration}\nnotify pgrst, 'reload schema';\ncommit;`,
    );
    assert.equal(result.status, 0, result.stderr);
    let schemaReady = false;
    for (let n = 0; n < 50; n++) {
      try {
        await f.provider(
          "/rest/v1/feed_inventory_revisions?select=revision_id&limit=1",
        );
        schemaReady = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.equal(schemaReady, true, "REST schema did not refresh");
    const after = await snapshot(),
      projected = {};
    for (const table of tables) {
      const keys = Object.keys(before[table][0] ?? {});
      projected[table] = ordered(
        after[table].map((row) =>
          Object.fromEntries(keys.map((k) => [k, row[k]])),
        ),
      );
      assert.deepEqual(
        projected[table],
        before[table],
        `${table} changed its preexisting data`,
      );
    }
    for (const row of after.feed_cutoff_decisions) {
      assert.equal(row.opening_binding_revision, 0);
      assert.equal(row.movement_binding_revision, 0);
      assert.deepEqual(
        Object.keys(row)
          .filter(
            (k) => !Object.keys(before.feed_cutoff_decisions[0]).includes(k),
          )
          .sort(),
        ["movement_binding_revision", "opening_binding_revision"],
      );
    }
    const previewAfter = await f.rpc(
      "get_feed_balance_preview",
      previewArgs,
      users.capture.token,
    );
    assert.deepEqual(semantic(previewAfter), semantic(previewBefore));
    assert.equal(hash(projected), hash(before));
    await cap.locator("#refreshAccount").click();
    await ready(cap);
    assert.equal(
      await cap.locator("#identity").textContent(),
      identityBefore,
      "Existing authenticated session changed",
    );
    const history = await f.rpc(
      "get_feed_inventory_history",
      {
        p_company_id: ids.company,
        p_target_kind: "cutoff",
        p_target_id: legacy.action_id,
      },
      users.capture.token,
    );
    assert.equal(history.current_revision, 0);
    assert.deepEqual(history.items, []);
    assert.equal(history.original.event_payload.reason, legacy.reason);
    assert.equal(
      await f.rpc(
        "get_feed_inventory_history",
        {
          p_company_id: ids.company,
          p_target_kind: "cutoff",
          p_target_id: legacy.action_id,
        },
        users.foreign.token,
      ),
      null,
    );
    // Continue on the same migrated records through the operational screens.
    await cap.locator("#businessDate").fill("2026-10-28");
    await cap.locator("#occurredTime").fill("11:00");
    await cap.locator("#deliveryForm [name=product]").fill("SYN-F1 nuevo");
    await cap.locator("#deliveryForm [name=location]").fill("SYN-L1 nuevo");
    await cap.locator("#deliveryForm [name=quantity]").fill("1,5");
    await reviewIntake(cap, "deliveryForm");
    await confirmIntake(cap);
    const [newDelivery] = await f.provider(
      `/rest/v1/feed_delivery_events?company_id=eq.${ids.company}&product_declared=eq.SYN-F1%20nuevo`,
    );
    assert.equal(newDelivery.quantity, "1.5");
    assert.equal(newDelivery.recorded_by, users.capture.id);
    await cap.locator("#openingLookup [name=id]").fill(pending.opening_id);
    await cap.locator("#openingLookup button").click();
    await ready(cap);
    await cap.locator("#recountForm [name=date]").fill("2026-10-28");
    await cap.locator("#recountForm [name=time]").fill("09:00");
    await cap.locator("#recountForm [name=quantity]").fill("2");
    await cap
      .locator("#recountForm [name=evidence]")
      .fill("SYN-Acta nueva tras026");
    await reviewIntake(cap, "recountForm");
    await confirmIntake(cap);
    await visit(dir, "/experimental/feed-intake/", "director");
    await dir.locator("#openingLookup [name=id]").fill(pending.opening_id);
    await dir.locator("#openingLookup button").click();
    await ready(dir);
    await dir
      .locator("#approvalForm [name=reason]")
      .fill("SYN-Recuento contrastado tras actualizar");
    await reviewIntake(dir, "approvalForm");
    await confirmIntake(dir);
    assert.match(
      await dir.locator("#caseSummary").textContent(),
      /APROBADO.*NO APLICADO/,
    );
    await visit(cap, "/experimental/feed-supply/", "capture");
    await cap.locator("#businessDate").fill("2026-10-28");
    await cap.locator("#occurredTime").fill("11:05");
    await cap.locator("#product").fill("SYN-F1 nuevo");
    await cap.locator("#quantity").fill("0,25");
    await cap.locator("#captureFields summary").click();
    await cap.locator("#source").fill("SYN-L1 nuevo");
    await cap.locator("#review").click();
    await cap.locator("#reviewPanel").waitFor({ state: "visible" });
    await cap.locator("#confirm").click();
    await ready(cap);
    assert.match(
      await cap.locator("#receiptStatus").textContent(),
      /Registrado en servidor/,
    );
    const [newSupply] = await f.provider(
      `/rest/v1/feed_supply_events?company_id=eq.${ids.company}&product_declared=eq.SYN-F1%20nuevo`,
    );
    assert.equal(newSupply.quantity, "0.25");
    await visit(dir, "/experimental/feed-inventory/", "director");
    assert.match(
      await dir.locator("#permission").textContent(),
      /Dirección verificada/,
      await dir.locator("#error").textContent(),
    );
    for (const [kind, id] of [
      ["delivery", newDelivery.event_id],
      ["supply", newSupply.event_id],
    ]) {
      await dir.locator("#sourceForm [name=kind]").selectOption(kind);
      await dir.locator("#sourceForm [name=id]").fill(id);
      await dir.locator("#sourceForm button").click();
      await ready(dir);
      assert.equal(
        await dir.locator("#bindingForm").isVisible(),
        true,
        `Source lookup ${kind}: ${await dir.locator("#error").textContent()} | ${await dir.locator("#source").textContent()}`,
      );
      await dir.locator("#bindingForm [name=product]").selectOption(p1.item_id);
      await dir
        .locator("#bindingForm [name=location]")
        .selectOption(loc.item_id);
      await dir
        .locator("#bindingForm [name=reason]")
        .fill("SYN-Identidad explícita tras actualizar");
      await dir.locator("#bindingForm button").click();
      await ready(dir);
      await dir.locator("#confirm").click();
      await ready(dir);
      await dir.locator("#intentPanel").waitFor({ state: "hidden" });
    }
    await dir.locator("#openingForm [name=id]").fill(count.opening_id);
    await dir.locator("#openingForm button").click();
    await ready(dir);
    await dir.locator("#previewForm [name=date]").fill("2026-10-28");
    await dir.locator("#previewForm [name=time]").fill("12:00");
    await dir.locator("#previewForm button").click();
    await ready(dir);
    assert.match(
      await dir.locator("#preview").textContent(),
      /Empates pendientes: 1/,
    );
    await dir
      .locator("#cutoffForm [name=source]")
      .selectOption(`supply/${tieSupply.event_id}`);
    await ready(dir);
    await dir
      .locator("#cutoffForm [name=classification]")
      .selectOption("after_count");
    await dir
      .locator("#cutoffForm [name=reason]")
      .fill("SYN-Suministro posterior al conteo");
    await dir.locator("#cutoffForm button").click();
    await ready(dir);
    await dir.locator("#confirm").click();
    await ready(dir);
    await dir.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(
      await dir.locator("#preview").textContent(),
      /Resultado provisional: 15 bultos/,
    );
    // Correct a migrated legacy decision, retry the old event and prove that it cannot undo the correction.
    await dir.locator("#correctionLookup [name=kind]").selectOption("cutoff");
    await dir.locator("#correctionLookup [name=id]").fill(legacy.action_id);
    await dir.locator("#correctionLookup button").click();
    await ready(dir);
    async function correct(choice, reason) {
      await dir
        .locator("#correctionForm [name=classification]")
        .selectOption(choice);
      await dir.locator("#correctionForm [name=reason]").fill(reason);
      await dir.locator("#correctionForm button").click();
      await ready(dir);
      await dir.locator("#confirm").click();
      await ready(dir);
      await dir.locator("#intentPanel").waitFor({ state: "hidden" });
    }
    await correct("included_in_count", "SYN-Revisión del original migrado");
    assert.match(
      await dir.locator("#preview").textContent(),
      /Resultado provisional: 12 bultos/,
    );
    assert.equal(
      (
        await f.rpc(
          "record_feed_cutoff_decision",
          { p_event: legacy },
          users.director.token,
        )
      ).duplicate,
      true,
    );
    assert.equal(
      (
        await f.rpc(
          "get_feed_balance_preview",
          previewArgs,
          users.capture.token,
        )
      ).balance_bags,
      "12",
    );
    await correct("after_count", "SYN-Contraste final del original migrado");
    assert.match(
      await dir.locator("#preview").textContent(),
      /Resultado provisional: 15 bultos/,
    );
    const audit = await f.rpc(
      "get_feed_inventory_history",
      {
        p_company_id: ids.company,
        p_target_kind: "cutoff",
        p_target_id: legacy.action_id,
      },
      users.capture.token,
    );
    assert.equal(audit.current_revision, 2);
    assert.deepEqual(audit.original.event_payload, legacy);
    const denied = await cap.evaluate(
      async ({ company, id, event }) => {
        const r = await fetch(
          `/v1/companies/${company}/feed-inventory/corrections`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-tamago-user": id,
            },
            body: JSON.stringify(event),
          },
        );
        return r.status;
      },
      {
        company: ids.company,
        id: users.capture.id,
        event: audit.items[0].event_payload,
      },
    );
    assert.equal(denied, 403);
    for (const table of [
      "feed_catalog_items",
      "feed_supply_events",
      "feed_delivery_events",
      "feed_opening_counts",
      "feed_opening_approvals",
      "feed_fact_bindings",
      "feed_cutoff_decisions",
    ]) {
      const current = await f.provider(
        `/rest/v1/${table}?company_id=eq.${ids.company}`,
      );
      for (const old of before[table]) {
        const same = current.find(
          (row) =>
            canonical(
              Object.fromEntries(Object.keys(old).map((k) => [k, row[k]])),
            ) === canonical(old),
        );
        assert.ok(same, `Lost/changed preexisting row in ${table}`);
      }
    }
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_openings?opening_id=eq.${count.opening_id}`,
        )
      )[0].current_revision,
      1,
    );
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_openings?opening_id=eq.${pending.opening_id}`,
        )
      )[0].current_revision,
      2,
    );
    await mkdir("evidence", { recursive: true });
    await dir
      .locator("#preview")
      .screenshot({ path: "evidence/dev012k-recorrido-desktop.png" });
    await dir.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await dir.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await dir
      .locator("#preview")
      .screenshot({ path: "evidence/dev012k-recorrido-mobile.png" });
    assert.deepEqual(errors, []);
    await writeFile(
      "evidence/dev012k-migracion.json",
      `${JSON.stringify({ format: "tamago.feed-upgrade-evidence", schema_version: 1, environment: "local-fictitious", from: 25, to: 26, migration_sha256: createHash("sha256").update(migration).digest("hex"), rollback_verified: true, preexisting_hash: hash(before), postupgrade_projected_hash: hash(projected), preserved_tables: Object.fromEntries(tables.map((t) => [t, before[t].length])), session_preserved: true, rls_verified: true, preview_baseline_unchanged: true, originals_preserved_after_ui: true, final_preview_bags: "15", inventory_check: "not_applied", physical_device_tested: false }, null, 2)}\n`,
    );
  } catch (error) {
    if (diagnosticPage && !diagnosticPage.isClosed()) {
      await mkdir("evidence", { recursive: true });
      await diagnosticPage
        .screenshot({
          path: "evidence/dev012k-diagnostico.png",
          fullPage: true,
        })
        .catch(() => {});
      error.message += ` | UI: ${await diagnosticPage
        .locator("#error")
        .textContent()
        .catch(() => "unavailable")}`;
    }
    throw error;
  } finally {
    await browser?.close();
    await f.close();
  }
});
