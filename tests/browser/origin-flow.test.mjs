import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("origin consultation / real Auth and PostgreSQL: no double count, opposite differences, missing information and safe error", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase",
  timeout: 120000,
}, async () => {
  const f = await startRealCustodyFixture({ seedTransfers: false });
  let browser;
  const { ids, users, rpc, provider } = f;
  async function transfer(sent, received) {
    const transfer_id = randomUUID();
    await rpc(
      "dispatch_collection_transfer",
      {
        p_transfer: {
          transfer_id,
          company_id: ids.company,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: ids.lot,
          origin_business_date: "2026-10-27",
          quantity_sent: sent,
          sent_from: "Galpón ficticio",
          sent_to: "Bodega ficticia",
          sent_at: "2026-10-27T13:00:00Z",
        },
      },
      users.capture.token,
    );
    if (received !== null)
      await rpc(
        "confirm_collection_transfer_receipt",
        {
          p_transfer_id: transfer_id,
          p_received_quantity: received,
          p_received_at_location: "Bodega ficticia",
          p_received_at: "2026-10-27T14:00:00Z",
          p_receiver_note: null,
        },
        users.warehouse.token,
      );
    return transfer_id;
  }
  try {
    const a = await transfer(60, 59),
      b = await transfer(30, 31);
    await transfer(10, null);
    await rpc(
      "record_manual_classification",
      {
        p_record: {
          schema_version: 1,
          session_id: randomUUID(),
          company_id: ids.company,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: ids.lot,
          origin_business_date: "2026-10-27",
          classified_at: "2026-10-28T17:00:00.000Z",
          machine_configuration_reference: null,
          notes: null,
          inputs: [
            { transfer_id: a, quantity_eggs: 20 },
            { transfer_id: b, quantity_eggs: 10 },
          ],
          lines: [
            {
              line_id: randomUUID(),
              quantity_eggs: 25,
              typology: "AA",
              condition: "DIRTY",
              destination: "PENDING",
            },
            {
              line_id: randomUUID(),
              quantity_eggs: 5,
              typology: "PIPO",
              condition: "BROKEN",
              destination: "DISCARD",
            },
          ],
        },
      },
      users.warehouse.token,
    );
    await rpc(
      "receive_collection_event",
      {
        p_event: {
          schema_version: 2,
          event_id: randomUUID(),
          company_id: ids.company,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: ids.lot,
          business_date: "2026-10-26",
          occurrence: 1,
          quantity_eggs: 0,
          occurred_at: "2026-10-26T12:00:00Z",
          captured_at: "2026-10-26T12:01:00Z",
          actor_declared_id: "Ficticio",
          device_id: randomUUID(),
        },
      },
      users.capture.token,
    );
    const snapshot = () =>
      Promise.all(
        [
          "collection_events",
          "collection_transfers",
          "manual_classification_sessions",
          "custody_incidents",
        ].map(async (table) => {
          const rows = await provider(
            `/rest/v1/${table}?company_id=eq.${ids.company}`,
          );
          // SQL without ORDER BY has no stable row order; compare all row contents.
          return rows.sort((a, b) =>
            JSON.stringify(a).localeCompare(JSON.stringify(b)),
          );
        }),
      );
    const before = await snapshot();
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${f.origin}/experimental/custody/`);
    await page.locator("#loginForm [name=email]").fill(users.warehouse.email);
    await page
      .locator("#loginForm [name=password]")
      .fill(users.warehouse.password);
    await page.locator("#loginForm button").click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector("#flowDate").disabled,
    );
    await page.locator("#flowDate").fill("2026-10-27");
    await page.locator("#refreshFlow").click();
    const card = page.locator(`#flowItems [data-lot-id="${ids.lot}"]`);
    await card
      .locator("[data-metric=quantity_collected] dd")
      .filter({ hasText: "100 huevos" })
      .waitFor();
    for (const [key, n] of Object.entries({
      quantity_collected: 100,
      quantity_at_house: 0,
      quantity_in_transit: 10,
      quantity_received: 90,
      quantity_classified: 30,
      quantity_pending_classification: 60,
    }))
      assert.equal(
        await card.locator(`[data-metric=${key}] dd`).textContent(),
        `${n} huevos`,
      );
    assert.match(
      await card.textContent(),
      /faltantes 1 · sobrantes 1 · diferencia neta 0. Incidencias abiertas: 2/,
    );
    assert.match(
      await card.textContent(),
      /No definido 25 · Descarte declarado 5/,
    );
    await page.waitForFunction(
      () =>
        document.querySelector("#flowPanel").getAttribute("aria-busy") ===
        "false",
    );
    await mkdir("evidence", { recursive: true });
    await page.locator("#flowPanel").scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.locator("#flowPanel").screenshot({
      path: "evidence/dev012a-origin-flow-mobile.png",
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.locator("#flowPanel").screenshot({
      path: "evidence/dev012a-origin-flow-desktop.png",
    });
    assert.deepEqual(await snapshot(), before);
    await page.locator("#flowDate").fill("2026-10-25");
    await page.locator("#refreshFlow").click();
    await card.getByText("Sin información", { exact: true }).first().waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#refreshFlow").disabled,
    );
    await page.locator("#flowDate").fill("2026-10-26");
    await page.locator("#refreshFlow").click();
    await card
      .locator("[data-metric=quantity_collected] dd")
      .filter({ hasText: "0 huevos" })
      .waitFor();
    assert.match(await card.textContent(), /1 recogida/);
    await page.route("**/custody-flow?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ format: "wrong" }),
      }),
    );
    await page.locator("#refreshFlow").click();
    await page
      .locator("#flowStatus")
      .filter({ hasText: "No se pudo actualizar" })
      .waitFor();
    assert.equal(await page.locator("#flowItems article").count(), 0);
    await page.unroute("**/custody-flow?**");
    await page.locator("#flowDate").fill("2026-10-27");
    await page.locator("#refreshFlow").click();
    await card
      .locator("[data-metric=quantity_collected] dd")
      .filter({ hasText: "100 huevos" })
      .waitFor();
    assert.deepEqual(await snapshot(), before);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser?.close();
    await f.close();
  }
});
