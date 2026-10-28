import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("feed supply UI / real Auth/Postgres: decimal and zero, lost receipt, stable retry, scopes, reload and account isolation", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase",
  timeout: 120000,
}, async () => {
  const f = await startRealCustodyFixture({ seedTransfers: false });
  let browser;
  const { ids, users } = f;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    async function login(target, role) {
      await target.goto(`${f.origin}/experimental/feed-supply/`);
      await target.waitForFunction(
        () =>
          !document.querySelector("#loginPanel").hidden ||
          (!document.querySelector("#logout").hidden &&
            !document.querySelector("#refreshAccount").disabled),
      );
      if (await target.locator("#logout").isVisible()) {
        await target.locator("#logout").click();
      }
      await target.locator("#loginPanel").waitFor({ state: "visible" });
      await target.locator("#loginForm [name=email]").fill(users[role].email);
      await target
        .locator("#loginForm [name=password]")
        .fill(users[role].password);
      await target.locator("#loginForm button").click();
      await target.locator("#workspace").waitFor({ state: "visible" });
      await target.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
    }
    async function draft(quantity, product = "SYN-Fórmula") {
      await page.locator("#lot").selectOption(ids.lot);
      await page.locator("#businessDate").fill("2026-10-28");
      await page.locator("#occurredTime").fill("23:15");
      await page.locator("#product").fill(product);
      await page.locator("#quantity").fill(quantity);
      await page.locator("#review").click();
      await page.locator("#reviewPanel").waitFor({ state: "visible" });
    }
    async function ready() {
      await page.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
    }
    await login(page, "capture");
    await page.locator("#historyDate").fill("2026-10-27");
    await page.locator("#refreshHistory").click();
    await page
      .locator("#historyStatus")
      .filter({ hasText: "Sin información" })
      .waitFor();
    const payloads = [];
    let committedDrop = true;
    await page.route("**/feed-supplies", async (route) => {
      payloads.push(JSON.parse(route.request().postData()));
      if (committedDrop) {
        committedDrop = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await draft("004,2500", "SYN-<img src=x onerror=alert(1)>");
    assert.match(
      await page.locator("#reviewSummary").textContent(),
      /4,25 bultos de 40 kg/,
    );
    assert.equal(await page.locator("#quantity").isDisabled(), true);
    await page.locator("#confirm").evaluate((button) => {
      button.click();
      button.click();
    });
    await page.locator("#pendingPanel").waitFor({ state: "visible" });
    await ready();
    assert.equal(payloads.length, 1);
    const saved = payloads[0];
    assert.equal(saved.quantity, "4.25");
    assert.equal(saved.occurred_at, "2026-10-29T04:15:00.000Z");
    assert.equal(await page.locator("#receiptStatus").textContent(), "");
    assert.equal(await page.locator("#company").isDisabled(), true);
    assert.equal(await page.locator("#quantity").inputValue(), "004,2500");
    await page.locator("#retry").click();
    await page
      .locator("#receiptStatus")
      .filter({ hasText: "Registrado en servidor: 4,25" })
      .waitFor();
    await ready();
    assert.equal(payloads.length, 1);
    assert.equal(await page.locator("#detail img").count(), 0);
    assert.match(await page.locator("#detail").textContent(), /SYN-<img/);
    let rows = await f.provider(
      `/rest/v1/feed_supply_events?company_id=eq.${ids.company}`,
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].event_id, saved.event_id);
    assert.equal(rows[0].quantity, "4.25");
    await page.unroute("**/feed-supplies");
    const retries = [];
    await page.route("**/feed-supplies", async (route) => {
      retries.push(JSON.parse(route.request().postData()));
      if (retries.length === 1)
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ accepted: true }),
        });
      else if (retries.length === 2) await route.abort("failed");
      else await route.continue();
    });
    await draft("0");
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "reviewTitle",
    );
    await page.locator("#confirm").click();
    await page.locator("#pendingPanel").waitFor({ state: "visible" });
    await ready();
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "pendingTitle",
    );
    assert.match(
      await page.locator("#error").textContent(),
      /respuesta no coincide/,
    );
    assert.doesNotMatch(
      await page.locator("#receiptStatus").textContent(),
      /servidor: 0/,
    );
    await page.locator("#retry").click();
    await page.waitForFunction(
      () => !document.querySelector("#refreshAccount").disabled,
    );
    assert.equal(retries.length, 2);
    assert.doesNotMatch(
      await page.locator("#receiptStatus").textContent(),
      /servidor: 0/,
    );
    await page.locator("#retry").click();
    await page
      .locator("#receiptStatus")
      .filter({ hasText: "Registrado en servidor: 0" })
      .waitFor();
    await ready();
    assert.equal(retries.length, 3);
    assert.deepEqual(retries[0], retries[1]);
    assert.deepEqual(retries[1], retries[2]);
    await page.unroute("**/feed-supplies");
    rows = await f.provider(
      `/rest/v1/feed_supply_events?company_id=eq.${ids.company}`,
    );
    assert.equal(rows.length, 2);
    await page.reload();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await ready();
    await page.locator("#historyDate").fill("2026-10-28");
    await page.locator("#refreshHistory").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#history li").length === 2,
    );
    await ready();
    assert.match(
      await page.locator("#history").textContent(),
      /0 bultos de 40 kg/,
    );
    await page
      .locator(`#history li[data-id="${saved.event_id}"] button`)
      .click();
    await page.locator("#detail").filter({ hasText: saved.event_id }).waitFor();
    await ready();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await mkdir("evidence", { recursive: true });
    await page.screenshot({
      path: "evidence/dev012c-feed-mobile.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.evaluate(() => scrollTo(0, 0));
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "evidence/dev012c-feed-desktop.png",
      fullPage: true,
    });
    // Server pagination without presenting unlike formulas as one consumption total.
    for (let i = 0; i < 25; i++)
      await f.rpc(
        "record_feed_supply",
        {
          p_event: {
            ...saved,
            event_id: randomUUID(),
            quantity: "1",
            product_declared: "SYN-Otra fórmula",
          },
        },
        users.capture.token,
      );
    await page.locator("#refreshHistory").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#history li").length === 25,
    );
    await ready();
    await page.locator("#moreHistory").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#history li").length === 27,
    );
    await ready();
    assert.equal(await page.locator("#moreHistory").isVisible(), false);
    await page.route("**/feed-supplies?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ format: "wrong" }),
      }),
    );
    await page.locator("#refreshHistory").click();
    await page
      .locator("#error")
      .filter({ hasText: "historial no es válida" })
      .waitFor();
    assert.equal(await page.locator("#history li").count(), 0);
    await page.unroute("**/feed-supplies?**");
    await page.locator("#refreshHistory").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#history li").length === 25,
    );
    await ready();
    // Offline never claims a local save for this connected-only screen.
    await context.setOffline(true);
    await page
      .locator("#message")
      .filter({ hasText: "No se guarda alimento offline" })
      .waitFor();
    assert.equal(await page.locator("#review").isDisabled(), true);
    await context.setOffline(false);
    await ready();
    // A newly revoked role is checked by SQL even after UI review.
    await draft("1");
    const [membership] = await f.provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.capture.id}`,
    );
    await f.provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${membership.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    await page.locator("#confirm").click();
    await page
      .locator("#error")
      .filter({ hasText: "permiso actual" })
      .waitFor();
    await ready();
    assert.equal(await page.locator("#pendingPanel").isVisible(), true);
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_supply_events?company_id=eq.${ids.company}`,
        )
      ).length,
      27,
    );
    // A login on another tab invalidates every old-account field and result.
    const other = await context.newPage();
    await login(other, "foreign");
    await page.locator("#refreshAccount").click();
    await page.locator("#loginPanel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#workspace").isVisible(), false);
    assert.equal(await page.locator("#quantity").inputValue(), "");
    assert.equal(await page.locator("#history li").count(), 0);
    assert.equal(await page.locator("#pendingSummary").textContent(), "");
    const readContext = await browser.newContext();
    const readPage = await readContext.newPage();
    await login(readPage, "director");
    await readPage.locator("#lot").selectOption(ids.lot);
    assert.equal(await readPage.locator("#review").isDisabled(), true);
    await readPage.locator("#historyDate").fill("2026-10-28");
    await readPage.locator("#refreshHistory").click();
    await readPage.waitForFunction(
      () => document.querySelectorAll("#history li").length === 25,
    );
    assert.deepEqual(errors, []);
    await readContext.close();
    await context.close();
  } finally {
    await browser?.close();
    await f.close();
  }
});
