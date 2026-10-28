import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  fixtureIds,
  fixtureUsers,
  startPasswordIdentityFixture,
} from "../fixtures/password-identity-server.mjs";

test("protected queue validates durable receipts, safely retries lost replies and keeps quarantine separate from operational approval", async () => {
  const fixture = await startPasswordIdentityFixture({ hostname: "127.0.0.1" });
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/experimental/recogidas/`);
    await page.locator("#loginForm [name=email]").fill(fixtureUsers[0].email);
    await page
      .locator("#loginForm [name=password]")
      .fill(fixtureUsers[0].password);
    await page.locator("#loginForm button").click();
    await page
      .locator("#authStatus")
      .filter({ hasText: "Sesión verificada" })
      .waitFor();
    for (const [selector, id] of [
      ["#catalogCompany", fixtureIds.company],
      ["#catalogSite", fixtureIds.site],
      ["#catalogHouse", fixtureIds.house],
      ["#catalogLot", fixtureIds.lot],
    ])
      await page.locator(selector).selectOption(id);
    await page
      .locator("#prepareIdentityForm input")
      .fill(fixtureUsers[0].password);
    await page.locator("#prepareIdentityForm button").click();
    await page
      .locator("#identityStatus")
      .filter({ hasText: "Identidad local abierta" })
      .waitFor();
    const capture = async (occurrence, quantity) => {
      await page
        .locator("[name=protected_quantity_eggs]")
        .fill(String(quantity));
      await page
        .locator("[name=protected_occurrence]")
        .selectOption(String(occurrence));
      await page.locator("#saveIdentityCollection").click();
      await page
        .locator("#identityRecords")
        .filter({ hasText: `${quantity} huevos` })
        .waitFor();
    };
    const exportOriginal = async () => {
      const pending = page.waitForEvent("download");
      await page.locator("#exportIdentityCollections").click();
      return JSON.parse(await readFile(await (await pending).path(), "utf8"));
    };
    const routePattern = "**/offline-collection-events";
    const send = () => page.locator("#syncIdentityCollections").click();
    const incomplete = () =>
      page
        .locator("#identitySyncStatus")
        .filter({ hasText: "Envío incompleto" })
        .waitFor();
    await capture(1, 413);
    const original = await exportOriginal();
    // Reply lost after real gateway processing: pending survives, server has one.
    await page.route(routePattern, async (route) => {
      await route.fetch();
      await route.abort("failed");
    });
    await send();
    await incomplete();
    assert.equal(fixture.state.receipts.size, 1);
    assert.match(
      await page.locator("#identityRecords").textContent(),
      /pendiente de envío/,
    );
    await page.unroute(routePattern);
    // A forged/mismatched successful HTTP body must not clear the pending row.
    await page.route(routePattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, company_id: "99999999-9999-4999-8999-999999999999" },
      });
    });
    await send();
    await page
      .locator("#identityError")
      .filter({ hasText: "acuse no corresponde" })
      .waitFor();
    await page.unroute(routePattern);
    // Server receipt received, local acknowledgement write fails atomically.
    await page.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      globalThis.restoreReceiptAdd = () => {
        IDBObjectStore.prototype.add = add;
      };
      IDBObjectStore.prototype.add = function (...args) {
        if (
          this.name === "receipts" &&
          this.transaction.db.name === "tamago-protected-collections-lab-v1"
        )
          throw new DOMException(
            "Synthetic receipt storage failure",
            "QuotaExceededError",
          );
        return add.apply(this, args);
      };
    });
    await send();
    await page
      .locator("#identityError")
      .filter({ hasText: "conservar el acuse" })
      .waitFor();
    assert.match(
      await page.locator("#identityRecords").textContent(),
      /pendiente de envío/,
    );
    await page.evaluate(() => globalThis.restoreReceiptAdd());
    await send();
    await page
      .locator("#identityRecords")
      .filter({
        hasText: "recibido por servidor; revisión operativa pendiente",
      })
      .waitFor();
    assert.equal(fixture.state.receipts.size, 1);
    assert.deepEqual(await exportOriginal(), original);
    await capture(2, 71);
    fixture.state.registryStatus = "revoked";
    await send();
    await page
      .locator("#identityRecords")
      .filter({
        hasText: "recibido en cuarentena; requiere revisión (grant_revoked)",
      })
      .waitFor();
    assert.equal(fixture.state.quarantines.size, 1);
    assert.equal(
      await page.locator("#syncIdentityCollections").isDisabled(),
      true,
    );
    await page.screenshot({
      path: "evidence/dev008b-protected-sync.png",
      fullPage: true,
    });
    await page.reload();
    await page.locator("#offlineProfile").selectOption({ index: 1 });
    await page
      .locator("#unlockIdentityForm input")
      .fill(fixtureUsers[0].password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "grant_revoked" })
      .waitFor();
    assert.match(
      await page.locator("#identityRecords").textContent(),
      /413 huevos.*recibido por servidor/,
    );
    assert.equal(
      await page.locator("#syncIdentityCollections").isDisabled(),
      true,
    );
    // A different authenticated session cannot send this profile's third row.
    await capture(3, 19);
    await page.route("**/v1/auth/me", (route) =>
      route.fulfill({
        status: 401,
        json: { error: "AUTHENTICATION_REQUIRED" },
      }),
    );
    await send();
    await page
      .locator("#identityError")
      .filter({ hasText: "Inicia sesión online antes" })
      .waitFor();
    await page.unroute("**/v1/auth/me");
    await page.evaluate(async (user) => {
      await fetch("/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
    }, fixtureUsers[1]);
    await send();
    await page
      .locator("#identityError")
      .filter({ hasText: "misma cuenta" })
      .waitFor();
    assert.equal(fixture.state.receipts.size, 1);
    assert.equal(fixture.state.quarantines.size, 1);
    await page.evaluate(async (user) => {
      await fetch("/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: user.email, password: user.password }),
      });
    }, fixtureUsers[0]);
    fixture.state.registryStatus = "registry_current_unverified";
    let entered;
    let release;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const held = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(routePattern, async (route) => {
      const response = await route.fetch();
      entered();
      await held;
      await route.fulfill({ response });
    });
    await send();
    await started;
    await page.locator("#lockIdentity").click();
    release();
    await page.waitForResponse((response) =>
      response.url().endsWith("/offline-collection-events"),
    );
    await page.unroute(routePattern);
    assert.equal(await page.locator("#identityRecords").textContent(), "");
    await page
      .locator("#unlockIdentityForm input")
      .fill(fixtureUsers[0].password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "19 huevos · pendiente de envío" })
      .waitFor();
    await send();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "19 huevos · recibido por servidor" })
      .waitFor();
    assert.equal(fixture.state.receipts.size, 2);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
  } finally {
    await browser?.close();
    await fixture.close();
  }
});
