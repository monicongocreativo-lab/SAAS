import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("correction form / real Auth/Postgres: lost receipt, concurrent review, history pagination, revocation and account reset", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase",
  timeout: 180000,
}, async () => {
  let drop = false;
  const f = await startRealCustodyFixture({
    seedTransfers: false,
    gatewayFetch: async (url, o) => {
      const r = await fetch(url, o);
      if (
        drop &&
        new URL(url).pathname.endsWith("/rpc/correct_feed_inventory") &&
        r.ok
      ) {
        drop = false;
        await r.arrayBuffer();
        throw new Error("SYN-Correction committed, reply lost");
      }
      return r;
    },
  });
  let browser;
  try {
    const { ids, users } = f,
      scope = {
        company_id: ids.company,
        site_id: ids.site,
        house_id: ids.house,
        lot_id: ids.lot,
      };
    const item = (kind, code) => ({
      format: "tamago.feed-catalog-item",
      schema_version: 1,
      item_id: randomUUID(),
      ...scope,
      kind,
      code,
      label: `SYN-${code}`,
      unit: kind === "product" ? "BAG_40KG" : null,
      reason: "SYN-Alta",
    });
    const p1 = item("product", "F1"),
      p2 = item("product", "F2"),
      p3 = item("product", "F3"),
      loc = item("location", "L1");
    for (const e of [p1, p2, p3, loc])
      await f.rpc(
        "record_feed_catalog_item",
        { p_event: e },
        users.director.token,
      );
    const count = {
      ...scope,
      format: "tamago.feed-opening-count",
      schema_version: 1,
      opening_id: randomUUID(),
      count_id: randomUUID(),
      business_date: "2026-10-28",
      cutoff_at: "2026-10-28T12:00:00.000Z",
      product_declared: "SYN-Original conteo",
      location_declared: "SYN-Bodega original",
      quantity: "10",
      unit: "BAG_40KG",
      evidence_reference: "SYN-Conteo respaldado",
      notes: null,
      expected_revision: 0,
      previous_count_id: null,
    };
    await f.rpc(
      "record_feed_opening_count",
      { p_event: count },
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
          reason: "SYN-Revisado",
        },
      },
      users.director.token,
    );
    const delivery = {
      ...scope,
      format: "tamago.feed-delivery",
      schema_version: 1,
      event_id: randomUUID(),
      business_date: "2026-10-28",
      occurred_at: count.cutoff_at,
      product_declared: "SYN-Original entrega",
      location_declared: "SYN-Bodega original",
      quantity: "3",
      unit: "BAG_40KG",
      supplier_declared: null,
      physical_batch_declared: null,
      delivery_reference_declared: null,
      notes: null,
    };
    await f.rpc(
      "record_feed_delivery",
      { p_event: delivery },
      users.capture.token,
    );
    const bind = (kind, id) => ({
        format: "tamago.feed-fact-binding",
        schema_version: 1,
        binding_id: randomUUID(),
        company_id: ids.company,
        source_kind: kind,
        source_id: id,
        product_id: p1.item_id,
        location_id: loc.item_id,
        reason: "SYN-Vínculo original",
      }),
      cb = bind("count", count.count_id),
      mb = bind("delivery", delivery.event_id);
    for (const e of [cb, mb])
      await f.rpc("bind_feed_fact", { p_event: e }, users.director.token);
    const decision = {
      format: "tamago.feed-cutoff-decision",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      opening_id: count.opening_id,
      count_id: count.count_id,
      source_kind: "delivery",
      source_id: delivery.event_id,
      classification: "after_count",
      reason: "SYN-Decisión original",
    };
    await f.rpc(
      "record_feed_cutoff_decision",
      { p_event: decision },
      users.director.token,
    );
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const a = await (
        await browser.newContext({ viewport: { width: 1280, height: 900 } })
      ).newPage(),
      b = await (
        await browser.newContext({ viewport: { width: 1280, height: 900 } })
      ).newPage(),
      errors = [];
    for (const page of [a, b])
      page.on("pageerror", (e) => errors.push(e.message));
    const ready = (p) =>
      p.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
    async function login(p, role) {
      await p.goto(`${f.origin}/experimental/feed-inventory/`);
      await p.locator("#loginPanel").waitFor({ state: "visible" });
      await p.locator("#loginForm [name=email]").fill(users[role].email);
      await p.locator("#loginForm [name=password]").fill(users[role].password);
      await p.locator("#loginForm button").click();
      await p.locator("#workspace").waitFor({ state: "visible" });
      await ready(p);
      await p.locator("#lot").selectOption(ids.lot);
      await ready(p);
    }
    async function open(p, kind, id) {
      await p.locator("#correctionLookup [name=kind]").selectOption(kind);
      await p.locator("#correctionLookup [name=id]").fill(id);
      await p.locator("#correctionLookup button").click();
      await ready(p);
      await p.locator("#correctionPanel").waitFor({ state: "visible" });
    }
    async function proposal(p, product, reason) {
      await p.locator("#correctionForm [name=product]").selectOption(product);
      await p.locator("#correctionForm [name=reason]").fill(reason);
      await p.locator("#correctionForm button").click();
      await ready(p);
      await p.locator("#intentPanel").waitFor({ state: "visible" });
      assert.equal(
        await p.evaluate(() => document.activeElement.id),
        "intentTitle",
      );
      await p.keyboard.press("Tab");
      assert.equal(
        await p.evaluate(() => document.activeElement.id),
        "confirm",
      );
    }
    async function confirm(p) {
      await p.locator("#confirm").click();
      await ready(p);
    }
    const countRevisions = async () =>
      (
        await f.provider(
          `/rest/v1/feed_inventory_revisions?company_id=eq.${ids.company}&target_id=eq.${mb.binding_id}`,
        )
      ).length;
    await login(a, "director");
    await login(b, "director");
    await open(a, "binding", mb.binding_id);
    assert.match(
      await a.locator("#correctionOriginal").textContent(),
      /SYN-Vínculo original/,
    );
    assert.match(
      await a.locator("#correctionCurrent").textContent(),
      /SYN-Original entrega/,
    );
    await a.locator("#correctionForm [name=reason]").fill("SYN-Sin cambios");
    await a.locator("#correctionForm button").click();
    await ready(a);
    assert.equal(await a.locator("#intentPanel").isVisible(), false);
    assert.match(await a.locator("#error").textContent(), /no cambia/);
    await proposal(a, p2.item_id, "SYN-Primera corrección");
    const firstSummary = await a.locator("#intentSummary").textContent();
    assert.match(firstSummary, /Original conservado/);
    assert.match(firstSummary, /Versión vigente revisada/);
    const firstId = firstSummary.match(/ID de corrección: ([0-9a-f-]{36})/)[1];
    drop = true;
    await a.locator("#confirm").evaluate((el) => {
      el.click();
      el.click();
    });
    await ready(a);
    assert.match(
      await a.locator("#intentState").textContent(),
      /Sin confirmación válida/,
    );
    assert.equal(await countRevisions(), 1);
    assert.equal(await a.locator("#edit").isDisabled(), true);
    assert.equal(await a.locator("#reconcile").isVisible(), false);
    assert.equal(await a.locator("#receipt").textContent(), "");
    await a.locator("#retry").click();
    await ready(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(
      await a.locator("#receipt").textContent(),
      new RegExp(firstId),
    );
    assert.match(await a.locator("#receipt").textContent(), /sin duplicar/);
    assert.equal(await countRevisions(), 1);
    assert.match(
      await a.locator("#correctionTitle").textContent(),
      /versión 1/,
    );
    await proposal(a, p1.item_id, "SYN-Retorno confirmado");
    await confirm(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.equal(await countRevisions(), 2);
    await a.locator("#openingForm [name=id]").fill(count.opening_id);
    await a.locator("#openingForm button").click();
    await ready(a);
    await a.locator("#previewForm [name=date]").fill("2026-10-28");
    await a.locator("#previewForm [name=time]").fill("12:00");
    await a.locator("#previewForm button").click();
    await ready(a);
    assert.match(
      await a.locator("#preview").textContent(),
      /Empates pendientes: 1/,
    );
    await a
      .getByRole("button", { name: "Ver historial de decisión", exact: true })
      .click();
    await ready(a);
    assert.match(
      await a.locator("#correctionTitle").textContent(),
      /decisión · versión 0/,
    );
    await a
      .locator("#correctionForm [name=classification]")
      .selectOption("after_count");
    await a
      .locator("#correctionForm [name=reason]")
      .fill("SYN-Revisión sobre vínculos vigentes");
    await a.locator("#correctionForm button").click();
    await ready(a);
    await confirm(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(
      await a.locator("#preview").textContent(),
      /Resultado provisional: 13/,
    );
    assert.match(
      await a.locator("#correctionTitle").textContent(),
      /versión 1/,
    );
    await mkdir("evidence", { recursive: true });
    await a
      .locator("#correctionPanel")
      .screenshot({ path: "evidence/dev012j-decision-desktop.png" });
    await a.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await a.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await a
      .locator("#correctionPanel")
      .screenshot({ path: "evidence/dev012j-decision-mobile.png" });
    // Two reviewers keep separate snapshots. A rejected intention is not silently rebased.
    await open(a, "binding", mb.binding_id);
    await open(b, "binding", mb.binding_id);
    await proposal(b, p2.item_id, "SYN-Otro revisor");
    await confirm(b);
    await b.locator("#intentPanel").waitFor({ state: "hidden" });
    await proposal(a, p3.item_id, "SYN-Propuesta conservada");
    const staleSummary = await a.locator("#intentSummary").textContent(),
      staleId = staleSummary.match(/ID de corrección: ([0-9a-f-]{36})/)[1];
    await confirm(a);
    assert.equal(await countRevisions(), 3);
    assert.equal(await a.locator("#reconcile").isVisible(), true);
    await a.locator("#reconcile").click();
    await ready(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.equal(await countRevisions(), 3);
    assert.match(
      await a.locator("#correctionTitle").textContent(),
      /versión 3/,
    );
    assert.match(
      await a.locator("#correctionCurrent").textContent(),
      new RegExp(p2.item_id),
    );
    assert.equal(
      await a.locator("#correctionForm [name=product]").inputValue(),
      p3.item_id,
    );
    assert.equal(
      await a.locator("#correctionForm [name=reason]").inputValue(),
      "SYN-Propuesta conservada",
    );
    assert.match(
      await a.locator("#correctionState").textContent(),
      /intención anterior no se aplicó/,
    );
    await proposal(a, p3.item_id, "SYN-Revisada frente a versión 3");
    const newId = (await a.locator("#intentSummary").textContent()).match(
      /ID de corrección: ([0-9a-f-]{36})/,
    )[1];
    assert.notEqual(newId, staleId);
    await confirm(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.equal(await countRevisions(), 4);
    // Full history and a changing head during pagination.
    let [head] = await f.provider(
      `/rest/v1/feed_inventory_revisions?target_id=eq.${mb.binding_id}&order=version.desc&limit=1`,
    );
    const revise = async (n) => {
      const e = {
        format: "tamago.feed-inventory-correction",
        schema_version: 1,
        revision_id: randomUUID(),
        company_id: ids.company,
        target_kind: "binding",
        target_id: mb.binding_id,
        expected_revision: n,
        previous_revision_id: head.revision_id,
        product_id: n % 2 === 0 ? p1.item_id : p2.item_id,
        location_id: loc.item_id,
        reason: `SYN-Historia ${n}`,
      };
      await f.rpc(
        "correct_feed_inventory",
        { p_event: e },
        users.director.token,
      );
      head = { revision_id: e.revision_id };
    };
    // A decision can also become stale when its bindings advance, while its own head stays unchanged.
    await revise(4);
    await open(a, "cutoff", decision.action_id);
    await a
      .locator("#correctionForm [name=classification]")
      .selectOption("included_in_count");
    await a
      .locator("#correctionForm [name=reason]")
      .fill("SYN-Revisión que quedó obsoleta por vínculos");
    await a.locator("#correctionForm button").click();
    await ready(a);
    await revise(5);
    await revise(6);
    await confirm(a);
    assert.equal(await a.locator("#reconcile").isVisible(), true);
    await a.locator("#reconcile").click();
    await ready(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.equal(
      await a.locator("#correctionForm [name=classification]").inputValue(),
      "included_in_count",
    );
    await a.locator("#correctionForm button").click();
    await ready(a);
    await confirm(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(
      await a.locator("#preview").textContent(),
      /Resultado provisional: 10/,
    );
    await open(a, "binding", mb.binding_id);
    for (let n = 7; n < 27; n++) await revise(n);
    await a.locator("#refreshCorrection").click();
    await ready(a);
    assert.equal(await a.locator("#correctionHistory li").count(), 25);
    await a.locator("#moreCorrections").click();
    await ready(a);
    assert.equal(await a.locator("#correctionHistory li").count(), 27);
    await a.locator("#refreshCorrection").click();
    await ready(a);
    await revise(27);
    await a.locator("#moreCorrections").click();
    await ready(a);
    assert.equal(await a.locator("#correctionHistory li").count(), 25);
    assert.match(
      await a.locator("#correctionState").textContent(),
      /historial cambió/,
    );
    assert.equal(await a.locator("#correctionForm button").isDisabled(), true);
    await a.locator("#refreshCorrection").click();
    await ready(a);
    await a.locator("#moreCorrections").click();
    await ready(a);
    assert.equal(await a.locator("#correctionHistory li").count(), 28);
    await a.route(
      "**/feed-inventory/history/**",
      async (route) => {
        const r = await route.fetch(),
          h = await r.json();
        h.current_revision++;
        await route.fulfill({ response: r, json: h });
      },
      { times: 1 },
    );
    await a.locator("#refreshCorrection").click();
    await ready(a);
    assert.equal(await a.locator("#correctionPanel").isVisible(), false);
    assert.equal(await a.locator("#error").isVisible(), true);
    await open(a, "binding", mb.binding_id);
    await proposal(a, p3.item_id, "SYN-No permitido tras revocación");
    const [membership] = await f.provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.director.id}`,
    );
    await f.provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${membership.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    await confirm(a);
    assert.equal(await countRevisions(), 28);
    assert.equal(await a.locator("#intentPanel").isVisible(), true);
    assert.equal(await a.locator("#retry").isVisible(), true);
    await a.locator("#logout").click();
    await ready(a);
    assert.equal(await a.locator("#correctionPanel").isVisible(), false);
    assert.equal(await a.locator("#correctionOriginal").textContent(), "");
    await login(a, "capture");
    await open(a, "binding", mb.binding_id);
    assert.equal(await a.locator("#correctionForm").isVisible(), false);
    assert.match(
      await a.locator("#correctionState").textContent(),
      /Consulta del historial/,
    );
    const [source] = await f.provider(
        `/rest/v1/feed_delivery_events?event_id=eq.${delivery.event_id}`,
      ),
      [originalBinding] = await f.provider(
        `/rest/v1/feed_fact_bindings?binding_id=eq.${mb.binding_id}`,
      ),
      [originalDecision] = await f.provider(
        `/rest/v1/feed_cutoff_decisions?action_id=eq.${decision.action_id}`,
      );
    assert.deepEqual(source.event_payload, delivery);
    assert.deepEqual(originalBinding.event_payload, mb);
    assert.deepEqual(originalDecision.event_payload, decision);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await f.close();
  }
});
