import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("book UI / real Auth: explicit activation, lost reply, insufficient facts, compensation, concurrent review and capture-only read", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase027",
  timeout: 180000,
}, async () => {
  let drop = false;
  const f = await startRealCustodyFixture({
    seedTransfers: false,
    gatewayFetch: async (url, o) => {
      const r = await fetch(url, o);
      if (
        drop &&
        new URL(url).pathname.endsWith("/rpc/apply_feed_ledger") &&
        r.ok
      ) {
        drop = false;
        await r.arrayBuffer();
        throw new Error("SYN-Committed book reply lost");
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
    const item = (code) => ({
        format: "tamago.feed-catalog-item",
        schema_version: 1,
        item_id: randomUUID(),
        ...scope,
        kind: "product",
        code,
        label: `SYN-${code}`,
        unit: "BAG_40KG",
        reason: "SYN-Alta",
      }),
      p1 = item("F1"),
      p2 = item("F2"),
      loc = { ...item("L1"), kind: "location", unit: null };
    for (const e of [p1, p2, loc])
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
      business_date: "2026-10-27",
      cutoff_at: "2026-10-27T12:00:00.000Z",
      product_declared: "SYN-F1",
      location_declared: "SYN-L1",
      quantity: "10",
      unit: "BAG_40KG",
      evidence_reference: "SYN-Acta",
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
          reason: "SYN-Validado",
        },
      },
      users.director.token,
    );
    const binding = (kind, id) => ({
        format: "tamago.feed-fact-binding",
        schema_version: 1,
        binding_id: randomUUID(),
        company_id: ids.company,
        source_kind: kind,
        source_id: id,
        product_id: p1.item_id,
        location_id: loc.item_id,
        reason: "SYN-Identificado",
      }),
      cm = binding("count", count.count_id);
    await f.rpc("bind_feed_fact", { p_event: cm }, users.director.token);
    async function move(kind, q, clock = "13:00:00") {
      const e = {
        ...scope,
        schema_version: 1,
        event_id: randomUUID(),
        business_date: "2026-10-27",
        occurred_at: `2026-10-27T${clock}.000Z`,
        product_declared: "SYN-F1",
        quantity: q,
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
          : { source_declared: null }),
      };
      await f.rpc(
        kind === "delivery" ? "record_feed_delivery" : "record_feed_supply",
        { p_event: e },
        users.capture.token,
      );
      const map = binding(kind, e.event_id);
      await f.rpc("bind_feed_fact", { p_event: map }, users.director.token);
      return { e, map };
    }
    const initial = await move("delivery", "3");
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
      cap = await (
        await browser.newContext({ viewport: { width: 390, height: 844 } })
      ).newPage(),
      errors = [];
    for (const p of [a, b, cap])
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
    async function book(p) {
      await p.locator("#bookLookup [name=id]").fill(count.opening_id);
      await p.locator("#bookLookup [name=date]").fill("2026-10-27");
      await p.locator("#bookLookup [name=time]").fill("12:00");
      await p.locator("#bookLookup button").click();
      await ready(p);
      await p.locator("#bookContext").waitFor({ state: "visible" });
    }
    async function review(p, reason) {
      await p.locator("#bookForm [name=reason]").fill(reason);
      await p.locator("#reviewBook").click();
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
    const operations = async () =>
      await f.provider(
        `/rest/v1/feed_ledger_operations?company_id=eq.${ids.company}`,
      );
    await visit(a, "/experimental/feed-inventory/", "director");
    await visit(b, "/experimental/feed-inventory/", "director");
    await book(a);
    assert.match(
      await a.locator("#bookState").textContent(),
      /Falta activar explícitamente/,
    );
    assert.match(
      await a.locator("#bookBalance").textContent(),
      /Sin apertura efectiva/,
    );
    await review(a, "SYN-Primera apertura");
    const activationId = (
      await a.locator("#intentSummary").textContent()
    ).match(/ID de operación: ([0-9a-f-]{36})/)[1];
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
    assert.equal((await operations()).length, 1);
    assert.equal(await a.locator("#edit").isDisabled(), true);
    assert.equal(await a.locator("#receipt").textContent(), "");
    await a.locator("#retry").click();
    await ready(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(
      await a.locator("#receipt").textContent(),
      new RegExp(activationId),
    );
    assert.match(await a.locator("#receipt").textContent(), /sin duplicar/);
    assert.match(await a.locator("#bookBalance").textContent(), /13 bultos/);
    assert.equal(await a.locator("#bookHistory li").count(), 2);
    // Real capture remains possible even though its application will exceed the book.
    await visit(cap, "/experimental/feed-supply/", "capture");
    await cap.locator("#businessDate").fill("2026-10-27");
    await cap.locator("#occurredTime").fill("11:00");
    await cap.locator("#product").fill("SYN-Exceso");
    await cap.locator("#quantity").fill("100");
    await cap.locator("#review").click();
    await cap.locator("#reviewPanel").waitFor({ state: "visible" });
    await cap.locator("#confirm").click();
    await ready(cap);
    assert.match(
      await cap.locator("#receiptStatus").textContent(),
      /Registrado en servidor/,
    );
    const [excess] = await f.provider(
      `/rest/v1/feed_supply_events?company_id=eq.${ids.company}&product_declared=eq.SYN-Exceso`,
    );
    await f.rpc(
      "bind_feed_fact",
      { p_event: binding("supply", excess.event_id) },
      users.director.token,
    );
    await book(a);
    assert.match(
      await a.locator("#bookState").textContent(),
      /Saldo insuficiente/,
    );
    assert.match(await a.locator("#bookBalance").textContent(), /13 bultos/);
    assert.equal(await a.locator("#bookForm").isVisible(), false);
    assert.equal((await operations()).length, 1);
    await move("delivery", "100", "16:30:00");
    await book(a);
    await review(a, "SYN-Recepción física contrastada");
    await confirm(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(await a.locator("#bookBalance").textContent(), /13 bultos/);
    assert.equal((await operations()).length, 2);
    // Correcting a source preserves old entries; application creates the compensating delta.
    await a.locator("#correctionLookup [name=kind]").selectOption("binding");
    await a.locator("#correctionLookup [name=id]").fill(initial.map.binding_id);
    await a.locator("#correctionLookup button").click();
    await ready(a);
    await a.locator("#correctionForm [name=product]").selectOption(p2.item_id);
    await a
      .locator("#correctionForm [name=reason]")
      .fill("SYN-Reclasificación revisada");
    await a.locator("#correctionForm button").click();
    await ready(a);
    await confirm(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.equal(await a.locator("#bookContext").isVisible(), false);
    await book(a);
    assert.match(await a.locator("#bookBalance").textContent(), /13 bultos/);
    assert.match(await a.locator("#bookProposal").textContent(), /10 bultos/);
    await review(a, "SYN-Compensación de recepción");
    await confirm(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(await a.locator("#bookBalance").textContent(), /10 bultos/);
    assert.match(await a.locator("#bookHistory").textContent(), /variación -3/);
    await mkdir("evidence", { recursive: true });
    await a
      .locator("#bookContext")
      .screenshot({ path: "evidence/dev012l-libro-desktop.png" });
    await a.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await a.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await a
      .locator("#bookContext")
      .screenshot({ path: "evidence/dev012l-libro-mobile.png" });
    // An application won by another reviewer must not be replayed under a new ID.
    await move("supply", "1", "14:00:00");
    await book(a);
    await book(b);
    await review(a, "SYN-Revisor A");
    await review(b, "SYN-Revisor B");
    await confirm(b);
    await b.locator("#intentPanel").waitFor({ state: "hidden" });
    await confirm(a);
    assert.equal(await a.locator("#reconcile").isVisible(), true);
    await a.locator("#reconcile").click();
    await ready(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(await a.locator("#bookBalance").textContent(), /9 bultos/);
    assert.equal((await operations()).length, 4);
    // New source changes the token while the book revision is unchanged.
    await move("delivery", "1", "15:00:00");
    await book(a);
    await review(a, "SYN-Conjunto que quedará obsoleto");
    await move("supply", "0.5", "15:30:00");
    await confirm(a);
    await a.locator("#reconcile").click();
    await ready(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.equal((await operations()).length, 4);
    assert.match(await a.locator("#bookProposal").textContent(), /9.5 bultos/);
    await review(a, "SYN-Nuevo conjunto revisado");
    await confirm(a);
    await a.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.equal((await operations()).length, 5);
    assert.match(await a.locator("#bookBalance").textContent(), /9.5 bultos/);
    await a.route(
      "**/feed-inventory/ledger-review/**",
      async (route) => {
        const r = await route.fetch(),
          v = await r.json();
        v.available_bags = "999";
        await route.fulfill({ response: r, json: v });
      },
      { times: 1 },
    );
    await a.locator("#bookLookup button").click();
    await ready(a);
    assert.equal(await a.locator("#bookContext").isVisible(), false);
    assert.equal(await a.locator("#error").isVisible(), true);
    await book(a);
    assert.doesNotMatch(await a.locator("#bookProposal").textContent(), /999/);
    const correction = {
      format: "tamago.feed-inventory-correction",
      schema_version: 1,
      revision_id: randomUUID(),
      company_id: ids.company,
      target_kind: "binding",
      target_id: cm.binding_id,
      expected_revision: 0,
      previous_revision_id: null,
      product_id: p2.item_id,
      location_id: loc.item_id,
      reason: "SYN-Identidad del conteo",
    };
    await f.rpc(
      "correct_feed_inventory",
      { p_event: correction },
      users.director.token,
    );
    await book(a);
    assert.match(
      await a.locator("#bookState").textContent(),
      /identidad del conteo/,
    );
    assert.equal(await a.locator("#bookForm").isVisible(), false);
    assert.match(await a.locator("#bookBalance").textContent(), /9.5 bultos/);
    await visit(cap, "/experimental/feed-inventory/", "capture");
    await book(cap);
    assert.equal(await cap.locator("#bookForm").isVisible(), false);
    await cap.locator("#bookHistoryLoad").click();
    await ready(cap);
    assert.ok((await cap.locator("#bookHistory li").count()) > 0);
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_delivery_events?event_id=eq.${initial.e.event_id}`,
        )
      )[0].event_payload.quantity,
      "3",
    );
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_supply_events?event_id=eq.${excess.event_id}`,
        )
      )[0].event_payload.quantity,
      "100",
    );
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await f.close();
  }
});
