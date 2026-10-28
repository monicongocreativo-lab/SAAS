import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("intake UI / real Auth/Postgres: receipt and count recovery, stale approval, roles, pagination, revocation and account isolation", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase",
  timeout: 180000,
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
    const capContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      dirContext = await browser.newContext({
        viewport: { width: 1280, height: 900 },
      });
    const cap = await capContext.newPage(),
      dir = await dirContext.newPage(),
      errors = [];
    for (const p of [cap, dir])
      p.on("pageerror", (e) => errors.push(e.message));
    async function ready(p) {
      await p.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
    }
    async function login(p, role) {
      await p.goto(`${f.origin}/experimental/feed-intake/`);
      await p.waitForFunction(
        () =>
          !document.querySelector("#loginPanel").hidden ||
          (!document.querySelector("#logout").hidden &&
            !document.querySelector("#refreshAccount").disabled),
      );
      if (await p.locator("#logout").isVisible())
        await p.locator("#logout").click();
      await p.locator("#loginPanel").waitFor({ state: "visible" });
      await p.locator("#loginForm [name=email]").fill(users[role].email);
      await p.locator("#loginForm [name=password]").fill(users[role].password);
      await p.locator("#loginForm button").click();
      await p.locator("#workspace").waitFor({ state: "visible" });
      await ready(p);
    }
    async function open(p, id) {
      await p.locator("#openingLookup [name=id]").fill(id);
      await p.locator("#openingLookup button").click();
      await p.locator("#caseSummary").filter({ hasText: id }).waitFor();
      await ready(p);
    }
    async function review(p, id) {
      await p.locator(`#${id} button[type=submit]`).click();
      await p
        .locator("#intentTitle")
        .filter({ hasText: "Revisión de intención" })
        .waitFor();
      await ready(p);
    }
    async function confirm(p) {
      await p.locator("#confirmIntent").click();
      await ready(p);
    }
    await login(cap, "capture");
    await cap.locator("#lot").selectOption(ids.lot);
    await cap.locator("#businessDate").fill("2026-10-28");
    await cap.locator("#occurredTime").fill("00:15");
    await cap.locator("#deliveryForm [name=product]").fill("SYN-Fórmula");
    await cap.locator("#deliveryForm [name=location]").fill("SYN-Bodega");
    await cap.locator("#deliveryForm [name=quantity]").fill("0");
    await cap.locator("#reviewDelivery").click();
    await cap
      .locator("#error")
      .filter({ hasText: "Revisa cantidades" })
      .waitFor();
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_delivery_events?company_id=eq.${ids.company}`,
        )
      ).length,
      0,
    );
    await cap.locator("#deliveryForm [name=quantity]").fill("012,500");
    await cap.locator("#deliveryForm summary").click();
    await cap
      .locator("#deliveryForm [name=supplier]")
      .fill("SYN-<img src=x onerror=alert(1)>");
    let lostDelivery = true;
    const deliveries = [];
    await cap.route("**/feed-deliveries", async (route) => {
      deliveries.push(JSON.parse(route.request().postData()));
      if (lostDelivery) {
        lostDelivery = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await review(cap, "deliveryForm");
    assert.match(
      await cap.locator("#intentSummary").textContent(),
      /12,5 bultos/,
    );
    await cap.locator("#confirmIntent").evaluate((b) => {
      b.click();
      b.click();
    });
    await cap
      .locator("#intentTitle")
      .filter({ hasText: "Confirmación pendiente" })
      .waitFor();
    await ready(cap);
    assert.equal(deliveries.length, 1);
    assert.equal(await cap.locator("#receiptStatus").isVisible(), false);
    await cap.locator("#retryIntent").click();
    await cap
      .locator("#receiptStatus")
      .filter({ hasText: "Recepción confirmada" })
      .waitFor();
    await ready(cap);
    assert.equal(deliveries.length, 1);
    assert.equal(await cap.locator("#deliveryDetail img").count(), 0);
    assert.match(
      await cap.locator("#deliveryDetail").textContent(),
      /SYN-<img/,
    );
    await cap.unroute("**/feed-deliveries");
    await cap.locator("#countForm [name=product]").fill("SYN-Fórmula");
    await cap.locator("#countForm [name=location]").fill("SYN-Bodega");
    await cap.locator("#countForm [name=quantity]").fill("0");
    await cap.locator("#countForm [name=evidence]").fill("SYN-Acta conteo0");
    let invalidCount = true;
    const counts = [];
    await cap.route("**/feed-opening-counts", async (route) => {
      counts.push(JSON.parse(route.request().postData()));
      if (invalidCount) {
        invalidCount = false;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ accepted: true }),
        });
      } else await route.continue();
    });
    await review(cap, "countForm");
    assert.equal(await cap.locator("#receiptStatus").isVisible(), false);
    assert.equal(
      await cap.evaluate(() => document.activeElement.id),
      "intentTitle",
    );
    await confirm(cap);
    await cap
      .locator("#intentTitle")
      .filter({ hasText: "Confirmación pendiente" })
      .waitFor();
    assert.doesNotMatch(
      await cap.locator("#receiptStatus").textContent(),
      /Conteo confirmado/,
    );
    await cap.locator("#retryIntent").click();
    await cap
      .locator("#receiptStatus")
      .filter({ hasText: "Conteo confirmado" })
      .waitFor();
    await ready(cap);
    assert.equal(counts.length, 2);
    assert.deepEqual(counts[0], counts[1]);
    const c1 = counts[0],
      openingId = c1.opening_id;
    await cap.unroute("**/feed-opening-counts");
    assert.equal(await cap.locator("#approvalForm").isVisible(), false);
    assert.match(await cap.locator("#currentCount").textContent(), /0 bultos/);
    await login(dir, "director");
    await dir.locator("#lot").selectOption(ids.lot);
    assert.equal(await dir.locator("#reviewCount").isDisabled(), true);
    await open(dir, openingId);
    assert.equal(await dir.locator("#approvalForm").isVisible(), true);
    assert.equal(await dir.locator("#recountForm").isVisible(), false);
    await dir
      .locator("#approvalForm [name=reason]")
      .fill("SYN-Revisado conteo0");
    await review(dir, "approvalForm");
    assert.match(
      await dir.locator("#intentSummary").textContent(),
      /Cantidad: 0 bultos/,
    );
    // Capture records another physical count while Direction reviews the old version.
    await cap.locator("#recountForm [name=date]").fill("2026-10-28");
    await cap.locator("#recountForm [name=time]").fill("00:20");
    await cap.locator("#recountForm [name=quantity]").fill("1,25");
    await cap.locator("#recountForm [name=evidence]").fill("SYN-Acta recuento");
    await review(cap, "recountForm");
    await confirm(cap);
    await cap
      .locator("#caseSummary")
      .filter({ hasText: "Versión vigente 2" })
      .waitFor();
    await confirm(dir);
    await dir
      .locator("#intentTitle")
      .filter({ hasText: "Intención rechazada" })
      .waitFor();
    assert.equal(await dir.locator("#discardIntent").isVisible(), true);
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_opening_approvals?company_id=eq.${ids.company}`,
        )
      ).length,
      0,
    );
    await dir.locator("#discardIntent").click();
    await dir
      .locator("#caseSummary")
      .filter({ hasText: "Versión vigente 2" })
      .waitFor();
    await ready(dir);
    await dir
      .locator("#approvalForm [name=reason]")
      .fill("SYN-Recuento y soporte revisados");
    await review(dir, "approvalForm");
    assert.match(
      await dir.locator("#intentSummary").textContent(),
      /Cantidad: 1,25 bultos/,
    );
    let lostApproval = true;
    const approvals = [];
    await dir.route("**/feed-opening-approvals", async (route) => {
      approvals.push(JSON.parse(route.request().postData()));
      if (lostApproval) {
        lostApproval = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await confirm(dir);
    await dir
      .locator("#intentTitle")
      .filter({ hasText: "Confirmación pendiente" })
      .waitFor();
    assert.equal(await dir.locator("#discardIntent").isVisible(), false);
    await dir.locator("#retryIntent").click();
    await dir
      .locator("#receiptStatus")
      .filter({ hasText: "CONTEO APROBADO" })
      .waitFor();
    await dir
      .locator("#caseSummary")
      .filter({ hasText: "NO APLICADO AL INVENTARIO" })
      .waitFor();
    await ready(dir);
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].expected_revision, 2);
    assert.equal(await dir.locator("#approvalForm").isVisible(), false);
    assert.equal(await dir.locator("#countHistory li").count(), 2);
    await dir.unroute("**/feed-opening-approvals");
    await dir.reload();
    await dir.locator("#workspace").waitFor({ state: "visible" });
    await ready(dir);
    await open(dir, openingId);
    assert.match(
      await dir.locator("#approvalDetail").textContent(),
      /versión 2/,
    );
    assert.match(
      await dir.locator("#caseSummary").textContent(),
      /NO APLICADO/,
    );
    await mkdir("evidence", { recursive: true });
    await cap.locator("#refreshCase").click();
    await ready(cap);
    await cap
      .locator("#caseSummary")
      .filter({ hasText: "NO APLICADO" })
      .waitFor();
    assert.equal(
      await cap.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await cap
      .locator("#casePanel")
      .screenshot({ path: "evidence/dev012f-opening-mobile.png" });
    assert.equal(
      await dir.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await dir
      .locator("#casePanel")
      .screenshot({ path: "evidence/dev012f-opening-desktop.png" });
    await cap
      .locator("#deliverySection")
      .screenshot({ path: "evidence/dev012f-delivery-mobile.png" });
    // Pagination for deliveries, cases and immutable count versions.
    for (let i = 0; i < 26; i++) {
      await f.rpc(
        "record_feed_delivery",
        {
          p_event: {
            ...deliveries[0],
            event_id: randomUUID(),
            supplier_declared: null,
          },
        },
        users.capture.token,
      );
      await f.rpc(
        "record_feed_opening_count",
        {
          p_event: { ...c1, opening_id: randomUUID(), count_id: randomUUID() },
        },
        users.capture.token,
      );
    }
    await cap.locator("#deliveryHistoryDate").fill("2026-10-28");
    await cap.locator("#refreshDeliveries").click();
    await cap.waitForFunction(
      () => document.querySelectorAll("#deliveries li").length === 25,
    );
    await ready(cap);
    await cap.locator("#moreDeliveries").click();
    await cap.waitForFunction(
      () => document.querySelectorAll("#deliveries li").length === 27,
    );
    await ready(cap);
    await dir.locator("#refreshCases").click();
    await dir.waitForFunction(
      () => document.querySelectorAll("#cases li").length === 25,
    );
    await ready(dir);
    await dir.locator("#moreCases").click();
    await dir.waitForFunction(
      () => document.querySelectorAll("#cases li").length === 27,
    );
    await ready(dir);
    let paged = { ...c1, opening_id: randomUUID(), count_id: randomUUID() };
    await f.rpc(
      "record_feed_opening_count",
      { p_event: paged },
      users.capture.token,
    );
    for (let revision = 1; revision < 27; revision++) {
      paged = {
        ...paged,
        count_id: randomUUID(),
        previous_count_id: paged.count_id,
        expected_revision: revision,
        quantity: String(revision),
      };
      await f.rpc(
        "record_feed_opening_count",
        { p_event: paged },
        users.capture.token,
      );
    }
    await open(dir, paged.opening_id);
    assert.equal(await dir.locator("#countHistory li").count(), 25);
    await dir.locator("#moreCounts").click();
    await dir.waitForFunction(
      () => document.querySelectorAll("#countHistory li").length === 27,
    );
    await ready(dir);
    assert.match(await dir.locator("#currentCount").textContent(), /26 bultos/);
    await dir.route("**/feed-openings?**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ format: "wrong" }),
      }),
    );
    await dir.locator("#refreshCases").click();
    await dir
      .locator("#error")
      .filter({ hasText: "respuesta no es compatible" })
      .waitFor();
    assert.equal(await dir.locator("#cases li").count(), 0);
    await dir.unroute("**/feed-openings?**");
    await dir.locator("#refreshCases").click();
    await dir.waitForFunction(
      () => document.querySelectorAll("#cases li").length === 25,
    );
    await ready(dir);
    await capContext.setOffline(true);
    await cap
      .locator("#message")
      .filter({ hasText: "no guardan offline" })
      .waitFor();
    assert.equal(await cap.locator("#reviewCount").isDisabled(), true);
    await capContext.setOffline(false);
    await dir
      .locator("#approvalForm [name=reason]")
      .fill("SYN-Intento tras revocación");
    await review(dir, "approvalForm");
    const [membership] = await f.provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.director.id}`,
    );
    await f.provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${membership.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    await confirm(dir);
    await dir.locator("#error").filter({ hasText: "permiso actual" }).waitFor();
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_opening_approvals?company_id=eq.${ids.company}`,
        )
      ).length,
      1,
    );
    const other = await dirContext.newPage();
    await login(other, "foreign");
    await dir.locator("#refreshAccount").click();
    await dir.locator("#loginPanel").waitFor({ state: "visible" });
    assert.equal(await dir.locator("#workspace").isVisible(), false);
    assert.equal(await dir.locator("#cases li").count(), 0);
    assert.equal(await dir.locator("#intentSummary").textContent(), "");
    assert.equal(
      await dir.locator("#countForm [name=quantity]").inputValue(),
      "",
    );
    assert.deepEqual(errors, []);
    await capContext.close();
    await dirContext.close();
  } finally {
    await browser?.close();
    await f.close();
  }
});
