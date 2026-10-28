import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("inventory UI / real Auth: catalog, original bindings, lost reply, cutoff decision, invalid preview, permissions and mobile", {
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
        new URL(url).pathname.endsWith("/rpc/bind_feed_fact") &&
        r.ok
      ) {
        drop = false;
        await r.arrayBuffer();
        throw new Error("SYN-lost committed reply");
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
    const count = {
      ...scope,
      format: "tamago.feed-opening-count",
      schema_version: 1,
      opening_id: randomUUID(),
      count_id: randomUUID(),
      business_date: "2026-10-28",
      cutoff_at: "2026-10-28T12:00:00.000Z",
      product_declared: "SYN-Alias original",
      location_declared: "SYN-Bodega original",
      quantity: "10",
      unit: "BAG_40KG",
      evidence_reference: "SYN-Conteo",
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
          reason: "SYN-Revisión",
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
      product_declared: "SYN-Alias entrega",
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
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const ctx = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        timezoneId: "Europe/Lisbon",
      }),
      p = await ctx.newPage(),
      errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    const ready = () =>
      p.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
    async function login(role) {
      await p.goto(`${f.origin}/experimental/feed-inventory/`);
      await p.locator("#loginPanel").waitFor({ state: "visible" });
      await p.locator("#loginForm [name=email]").fill(users[role].email);
      await p.locator("#loginForm [name=password]").fill(users[role].password);
      await p.locator("#loginForm button").click();
      await p.locator("#workspace").waitFor({ state: "visible" });
      await ready();
      await p.locator("#lot").selectOption(ids.lot);
      await ready();
    }
    await login("director");
    assert.match(
      await p.locator("#permission").textContent(),
      /Dirección verificada/,
    );
    async function review(form) {
      await p.locator(`#${form} button[type=submit]`).click();
      await p.locator("#intentPanel").waitFor({ state: "visible" });
      await ready();
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
    async function confirm() {
      await p.locator("#confirm").click();
      await ready();
    }
    async function make(kind, code, label) {
      await p.locator("#catalogForm [name=kind]").selectOption(kind);
      await p.locator("#catalogForm [name=code]").fill(code);
      await p.locator("#catalogForm [name=label]").fill(label);
      await p.locator("#catalogForm [name=reason]").fill("SYN-Alta revisada");
      await review("catalogForm");
      await p.locator("#confirm").evaluate((b) => {
        b.click();
        b.click();
      });
      await ready();
      await p.locator("#intentPanel").waitFor({ state: "hidden" });
    }
    await make("product", "F1", "SYN-Fórmula");
    await make("location", "L1", "SYN-Ubicación");
    const products = await f.provider(
      `/rest/v1/feed_catalog_items?company_id=eq.${ids.company}`,
    );
    assert.equal(products.length, 2);
    const product = products.find((x) => x.kind === "product"),
      location = products.find((x) => x.kind === "location");
    await p.locator("#openingForm [name=id]").fill(count.opening_id);
    await p.locator("#openingForm button").click();
    await ready();
    assert.match(
      await p.locator("#opening").textContent(),
      /SYN-Alias original/,
    );
    await p.locator("#useCount").click();
    await ready();
    async function binding() {
      await p
        .locator("#bindingForm [name=product]")
        .selectOption(product.item_id);
      await p
        .locator("#bindingForm [name=location]")
        .selectOption(location.item_id);
      await p
        .locator("#bindingForm [name=reason]")
        .fill("SYN-Soporte comprobado");
      await review("bindingForm");
    }
    await binding();
    drop = true;
    await confirm();
    assert.match(
      await p.locator("#intentState").textContent(),
      /Sin confirmación válida/,
    );
    assert.equal(await p.locator("#edit").isDisabled(), true);
    await p.locator("#retry").click();
    await ready();
    await p.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(await p.locator("#receipt").textContent(), /sin duplicar/);
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_fact_bindings?company_id=eq.${ids.company}`,
        )
      ).length,
      1,
    );
    await p.locator("#sourceForm [name=id]").fill(delivery.event_id);
    await p.locator("#sourceForm button").click();
    await ready();
    assert.match(
      await p.locator("#source").textContent(),
      /Fecha y hora · Colombia: 28\/10\/2026,? 07:00:00/,
    );
    await binding();
    await confirm();
    await p.locator("#intentPanel").waitFor({ state: "hidden" });
    await p.locator("#previewForm [name=date]").fill("2026-10-28");
    await p.locator("#previewForm [name=time]").fill("12:00");
    await p.locator("#previewForm button").click();
    await ready();
    assert.match(
      await p.locator("#preview").textContent(),
      /Empates pendientes: 1/,
    );
    await p
      .locator("#cutoffForm [name=source]")
      .selectOption(`delivery/${delivery.event_id}`);
    await ready();
    assert.match(
      await p.locator("#tieDetail").textContent(),
      /SYN-Alias entrega/,
    );
    await p
      .locator("#cutoffForm [name=classification]")
      .selectOption("after_count");
    await p
      .locator("#cutoffForm [name=reason]")
      .fill("SYN-Descarga posterior verificada");
    await review("cutoffForm");
    await confirm();
    await p.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(
      await p.locator("#preview").textContent(),
      /Resultado provisional: 13/,
    );
    await mkdir("evidence", { recursive: true });
    await p.screenshot({
      path: "evidence/dev012h-direccion-desktop.png",
      fullPage: true,
    });
    await p.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await p.screenshot({
      path: "evidence/dev012h-direccion-mobile.png",
      fullPage: false,
    });
    await p
      .locator("#preview")
      .screenshot({ path: "evidence/dev012h-resultado-mobile.png" });
    await p.route(
      "**/feed-inventory/previews/**",
      async (route) => {
        const r = await route.fetch(),
          v = await r.json();
        v.balance_bags = "999";
        await route.fulfill({ response: r, json: v });
      },
      { times: 1 },
    );
    await p.locator("#previewForm button").click();
    await ready();
    assert.equal(await p.locator("#error").isVisible(), true);
    assert.doesNotMatch(
      await p.locator("#preview").textContent(),
      /999|Resultado provisional/,
    );
    await p.locator("#previewForm button").click();
    await ready();
    assert.match(
      await p.locator("#preview").textContent(),
      /Resultado provisional: 13/,
    );
    // A corrected binding invalidates the old decision and the UI must not offer a second original decision.
    const [bound] = await f.provider(
      `/rest/v1/feed_fact_bindings?source_id=eq.${delivery.event_id}`,
    );
    const [decided] = await f.provider(
      `/rest/v1/feed_cutoff_decisions?source_id=eq.${delivery.event_id}`,
    );
    const alternate = {
      format: "tamago.feed-catalog-item",
      schema_version: 1,
      ...scope,
      item_id: randomUUID(),
      kind: "product",
      code: "ALT",
      label: "SYN-Otra identidad",
      unit: "BAG_40KG",
      reason: "SYN-Prueba de corrección",
    };
    await f.rpc(
      "record_feed_catalog_item",
      { p_event: alternate },
      users.director.token,
    );
    const correction = {
      format: "tamago.feed-inventory-correction",
      schema_version: 1,
      revision_id: randomUUID(),
      company_id: ids.company,
      target_kind: "binding",
      target_id: bound.binding_id,
      expected_revision: 0,
      previous_revision_id: null,
      product_id: alternate.item_id,
      location_id: location.item_id,
      reason: "SYN-Identidad revisada",
    };
    await f.rpc(
      "correct_feed_inventory",
      { p_event: correction },
      users.director.token,
    );
    const back = {
      ...correction,
      revision_id: randomUUID(),
      expected_revision: 1,
      previous_revision_id: correction.revision_id,
      product_id: product.item_id,
      reason: "SYN-Retorno revisado",
    };
    await f.rpc(
      "correct_feed_inventory",
      { p_event: back },
      users.director.token,
    );
    await p.locator("#sourceForm button").click();
    await ready();
    assert.match(await p.locator("#source").textContent(), /corrección 2/);
    assert.match(
      await p.locator("#source").textContent(),
      /SYN-Retorno revisado/,
    );
    await p.locator("#previewForm button").click();
    await ready();
    assert.match(
      await p.locator("#preview").textContent(),
      /Requiere corrección auditada/,
    );
    assert.equal(await p.locator("#cutoffForm").isVisible(), false);
    await p
      .getByRole("button", { name: "Ver historial de decisión", exact: true })
      .click();
    await ready();
    assert.match(
      await p.locator("#correctionPanel").textContent(),
      /Historial de decisión · versión 0/,
    );
    await p
      .locator("#preview")
      .screenshot({ path: "evidence/dev012i-empate-invalidado-mobile.png" });
    const reviewed = {
      format: "tamago.feed-inventory-correction",
      schema_version: 1,
      revision_id: randomUUID(),
      company_id: ids.company,
      target_kind: "cutoff",
      target_id: decided.action_id,
      expected_revision: 0,
      previous_revision_id: null,
      classification: "after_count",
      expected_opening_binding_revision: 0,
      expected_movement_binding_revision: 2,
      reason: "SYN-Revisado sobre vínculos vigentes",
    };
    await f.rpc(
      "correct_feed_inventory",
      { p_event: reviewed },
      users.director.token,
    );
    await p.locator("#previewForm button").click();
    await ready();
    assert.match(
      await p.locator("#preview").textContent(),
      /Resultado provisional: 13/,
    );
    // More than one page: identities stay explicit and no names are auto-matched.
    for (let n = 0; n < 25; n++)
      await f.rpc(
        "record_feed_catalog_item",
        {
          p_event: {
            format: "tamago.feed-catalog-item",
            schema_version: 1,
            ...scope,
            item_id: randomUUID(),
            kind: "product",
            code: `P${n}`,
            label: "SYN-Fórmula",
            unit: "BAG_40KG",
            reason: "SYN-Página",
          },
        },
        users.director.token,
      );
    await p.locator("#reload").click();
    await ready();
    assert.equal(await p.locator("#catalog li").count(), 25);
    await p.locator("#more").click();
    await ready();
    assert.equal(await p.locator("#catalog li").count(), 28);
    // Supply lookup uses the real plural API route, just like its capture screen.
    const supplied = {
      ...scope,
      schema_version: 1,
      event_id: randomUUID(),
      business_date: "2026-10-28",
      occurred_at: "2026-10-28T14:00:00.000Z",
      product_declared: "SYN-Suministro a vincular",
      quantity: "0.25",
      unit: "BAG_40KG",
      source_declared: "SYN-Ubicación",
      physical_batch_declared: null,
      notes: null,
    };
    await f.rpc(
      "record_feed_supply",
      { p_event: supplied },
      users.capture.token,
    );
    await p.locator("#sourceForm [name=kind]").selectOption("supply");
    await p.locator("#sourceForm [name=id]").fill(supplied.event_id);
    await p.locator("#sourceForm button").click();
    await ready();
    assert.equal(await p.locator("#bindingForm").isVisible(), true);
    assert.match(
      await p.locator("#source").textContent(),
      /SYN-Suministro a vincular/,
    );
    const colombiaTime = /Fecha y hora · Colombia: 28\/10\/2026,? 09:00:00/;
    assert.match(await p.locator("#source").textContent(), colombiaTime);
    const bogotaContext = await browser.newContext({
      storageState: await ctx.storageState(),
      timezoneId: "America/Bogota",
      viewport: { width: 390, height: 844 },
    });
    try {
      const localPage = await bogotaContext.newPage();
      await localPage.goto(`${f.origin}/experimental/feed-inventory/`);
      await localPage.locator("#workspace").waitFor({ state: "visible" });
      await localPage.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
      await localPage.locator("#lot").selectOption(ids.lot);
      await localPage.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
      await localPage.locator("#sourceForm [name=kind]").selectOption("supply");
      await localPage.locator("#sourceForm [name=id]").fill(supplied.event_id);
      await localPage.locator("#sourceForm button").click();
      await localPage.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
      assert.match(
        await localPage.locator("#source").textContent(),
        colombiaTime,
      );
      assert.equal(
        await localPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await localPage
        .locator("#source")
        .screenshot({ path: "evidence/dev012n-hora-colombia-mobile.png" });
    } finally {
      await bogotaContext.close();
    }
    const [storedSupply] = await f.provider(
      `/rest/v1/feed_supply_events?event_id=eq.${supplied.event_id}`,
    );
    assert.deepEqual(storedSupply.event_payload, supplied);
    await f.provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&role_key=eq.director`,
      { method: "DELETE" },
    );
    await p.locator("#reload").click();
    await ready();
    assert.equal(
      await p.locator("#catalogForm [name=code]").isDisabled(),
      true,
    );
    await p.locator("#logout").click();
    await ready();
    await login("capture");
    assert.equal(
      await p.locator("#catalogForm [name=code]").isDisabled(),
      true,
    );
    assert.match(await p.locator("#permission").textContent(), /sin permiso/);
    assert.equal(await p.locator("#receipt").textContent(), "");
    assert.equal(await p.locator("#source").textContent(), "");
    const original = await f.provider(
      `/rest/v1/feed_delivery_events?event_id=eq.${delivery.event_id}`,
    );
    assert.deepEqual(original[0].event_payload, delivery);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await f.close();
  }
});
