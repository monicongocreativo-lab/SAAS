import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("connected field layout / real Auth: offline save, restart, export, receipt and accessible navigation", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase",
  timeout: 120000,
}, async () => {
  const container = process.env.TAMAGO_FIELD_TEST_CONTAINER;
  assert.match(
    container ?? "",
    /^supabase-tamago-(?:dev010c|dev010e2|dev012a|dev012b|dev012c|dev012d|dev012e|dev012f|dev012g|dev012l)-[a-z0-9-]+-database-[a-f0-9]+$/,
  );
  const fixture = await startRealCustodyFixture({
    seedTransfers: false,
    offlineIdentity: true,
    cleanupOffline: async (companyId) => {
      assert.match(companyId, /^[0-9a-f-]{36}$/);
      const result = spawnSync(
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
        {
          input: `begin; delete from public.collection_events where company_id='${companyId}'; delete from public.offline_collection_quarantine where company_id='${companyId}'; delete from public.offline_capture_grants where company_id='${companyId}'; commit;`,
          encoding: "utf8",
        },
      );
      assert.equal(result.status, 0, "Scoped local fixture cleanup failed");
    },
  });
  let browser, context;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      acceptDownloads: true,
      reducedMotion: "reduce",
    });
    let page = await context.newPage();
    const url = `${fixture.origin}/experimental/recogidas/`;
    const open = () => page.goto(url);
    const { users, ids } = fixture;
    await open();
    await page
      .locator("#offlineState")
      .filter({ hasText: /preparada/i })
      .waitFor();
    assert.equal(await page.locator(".field-steps a").count(), 3);
    assert.equal(await page.locator("[data-person]").count(), 0);
    assert.equal(
      await page.locator("#legacyExperiment").getAttribute("open"),
      null,
    );
    await page.locator("#loginForm [name=email]").fill(users.capture.email);
    await page
      .locator("#loginForm [name=password]")
      .fill(users.capture.password);
    await page.locator("#loginForm button").click();
    await page
      .locator("#authStatus")
      .filter({ hasText: "Sesión verificada" })
      .waitFor();
    for (const [selector, id] of [
      ["#catalogCompany", ids.company],
      ["#catalogSite", ids.site],
      ["#catalogHouse", ids.house],
      ["#catalogLot", ids.lot],
    ])
      await page.locator(selector).selectOption(id);
    await page
      .locator("#prepareIdentityForm input")
      .fill(users.capture.password);
    await page.locator("#prepareIdentityForm button").click();
    await page
      .locator("#identityStatus")
      .filter({ hasText: "Identidad local abierta" })
      .waitFor();
    await page.locator(".field-steps a").nth(1).focus();
    await page.keyboard.press("Enter");
    assert.equal(new URL(page.url()).hash, "#collectionCapture");
    assert.equal(
      await page
        .locator("#collectionCapture")
        .evaluate((el) => document.activeElement === el),
      true,
    );
    await context.setOffline(true);
    await page.locator("[name=protected_occurrence]").selectOption("2");
    await page.locator("[name=protected_quantity_eggs]").fill("17");
    await page.locator("#saveIdentityCollection").click();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "17 huevos · pendiente de envío" })
      .waitFor();
    assert.match(
      await page.locator("#identityQueueSummary").textContent(),
      /1 registro\(s\) · 1 pendiente\(s\)/,
    );
    const download = page.waitForEvent("download");
    await page.locator("#exportIdentityCollections").click();
    const exported = JSON.parse(
      await readFile(await (await download).path(), "utf8"),
    );
    assert.match(JSON.stringify(exported), /"quantity_eggs":17/);
    // New page with the network still disabled: resources and encrypted capture
    // come from existing local stores, not a mock server or fake UI state.
    await page.close();
    page = await context.newPage();
    await open();
    assert.equal(await page.locator("#identityRecords li").count(), 0);
    assert.match(
      await page.locator("#identityQueueSummary").textContent(),
      /Abre un perfil/,
    );
    await page.waitForFunction(
      () => document.querySelector("#offlineProfile").options.length > 1,
    );
    await page.locator("#offlineProfile").selectOption({ index: 1 });
    await page
      .locator("#unlockIdentityForm input")
      .fill(users.capture.password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "17 huevos · pendiente de envío" })
      .waitFor();
    assert.equal(await page.locator("#identityRecords li").count(), 1);
    await page.locator(".field-steps a").nth(2).click();
    assert.equal(new URL(page.url()).hash, "#collectionStatus");
    await mkdir("evidence", { recursive: true });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: "evidence/dev010c-field-mobile.png" });
    await context.setOffline(false);
    await page.locator("#refreshSession").click();
    await page
      .locator("#authStatus")
      .filter({ hasText: "Sesión verificada" })
      .waitFor();
    await page
      .locator("#unlockIdentityForm input")
      .fill(users.capture.password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "pendiente de envío" })
      .waitFor();
    // The online cookie survived the page restart. Server revalidates real Auth,
    // grant, device signature, scope and event before issuing an acknowledgment.
    await page.locator("#syncIdentityCollections").click();
    await page
      .locator("#identityRecords")
      .filter({
        hasText: "recibido por servidor; revisión operativa pendiente",
      })
      .waitFor();
    assert.match(
      await page.locator("#identityQueueSummary").textContent(),
      /0 pendiente\(s\).*1 recibido\(s\)/,
    );
    const events = await fixture.provider(
      `/rest/v1/collection_events?company_id=eq.${ids.company}&quantity_eggs=eq.17`,
    );
    assert.equal(events.length, 1);
    assert.equal(events[0].occurrence, 2);
    await page.reload();
    await page
      .locator("#authStatus")
      .filter({ hasText: "Sesión verificada" })
      .waitFor();
    await page.waitForFunction(
      () => !document.querySelector("#refreshSession").disabled,
    );
    await page.waitForFunction(
      () => document.querySelector("#offlineProfile").options.length > 1,
    );
    await page.locator("#offlineProfile").selectOption({ index: 1 });
    await page
      .locator("#unlockIdentityForm input")
      .fill(users.capture.password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "recibido por servidor" })
      .waitFor();
    assert.equal(await page.locator("#identityRecords li").count(), 1);
    assert.match(
      await page.locator("#identityCaptureStatus").textContent(),
      /Perfil abierto/,
    );
    assert.match(
      await page.locator("#identitySyncStatus").textContent(),
      /misma persona/,
    );
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator(".field-steps a").nth(2).click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: "evidence/dev010c-field-desktop.png" });
    await page.locator("#lockIdentity").click();
    assert.equal(await page.locator("#identityRecords li").count(), 0);
    assert.match(
      await page.locator("#identityQueueSummary").textContent(),
      /Abre un perfil/,
    );
    assert.equal(
      await page
        .locator("#identityCaptureFields")
        .evaluate((element) => element.disabled),
      true,
    );
    assert.equal(
      await page.locator("#saveIdentityCollection").isDisabled(),
      true,
    );
  } catch (error) {
    if (context) {
      const p = context.pages()[0];
      if (p)
        await p
          .screenshot({
            path: "/private/tmp/tamago-dev010c-browser-failure.png",
            fullPage: true,
          })
          .catch(() => {});
    }
    throw error;
  } finally {
    await context?.close();
    await browser?.close();
    await fixture.close();
  }
});
