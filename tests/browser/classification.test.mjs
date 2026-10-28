import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("classification UI / real Auth/Postgres: partial origins, balanced counts, lost acknowledgment, conflict and account isolation", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local DEV-010E",
  timeout: 120000,
}, async () => {
  const f = await startRealCustodyFixture({ seedTransfers: false });
  let browser, context;
  const { ids, users, provider, rpc } = f;
  async function receive(sent, received, scope = ids) {
    const transfer_id = randomUUID();
    await rpc(
      "dispatch_collection_transfer",
      {
        p_transfer: {
          transfer_id,
          company_id: ids.company,
          site_id: scope.site,
          house_id: scope.house,
          lot_id: scope.lot,
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
    const a = await receive(60, 59),
      b = await receive(30, 29);
    await receive(10, null);
    const other = { ...ids, lot: randomUUID() };
    await provider("/rest/v1/lots", {
      method: "POST",
      body: {
        id: other.lot,
        company_id: ids.company,
        site_id: ids.site,
        house_id: ids.house,
        code: "SYN-OTHER",
        status: "active",
      },
    });
    for (const role of ["capture", "warehouse"]) {
      const [membership] = await provider(
        `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users[role].id}`,
      );
      await provider("/rest/v1/role_assignments", {
        method: "POST",
        body: {
          company_id: ids.company,
          membership_id: membership.id,
          role_key: role,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: other.lot,
        },
      });
    }
    await rpc(
      "receive_collection_event",
      {
        p_event: {
          schema_version: 2,
          event_id: randomUUID(),
          company_id: ids.company,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: other.lot,
          business_date: "2026-10-27",
          occurrence: 1,
          quantity_eggs: 5,
          occurred_at: "2026-10-27T12:00:00Z",
          captured_at: "2026-10-27T12:01:00Z",
          actor_declared_id: "Ficticio",
          device_id: randomUUID(),
        },
      },
      users.capture.token,
    );
    await receive(5, 5, other);
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("dialog", (dialog) => void dialog.accept());
    const errors = [];
    const resourceErrors = [];
    page.on("response", (response) => {
      if (
        new URL(response.url()).pathname.startsWith(
          "/experimental/classification/",
        ) &&
        response.status() >= 400
      )
        resourceErrors.push(response.status());
    });
    page.on("pageerror", (error) => errors.push(error.message));
    async function login(target, role) {
      await target.goto(`${f.origin}/experimental/classification/`);
      await target.locator("#loginForm [name=email]").fill(users[role].email);
      await target
        .locator("#loginForm [name=password]")
        .fill(users[role].password);
      await target.locator("#loginForm button").click();
      await target.locator("#companySelect").selectOption(ids.company);
      await target.locator("#originDate").fill("2026-10-27");
      await target.locator("#originDate").press("Tab");
      await target.waitForFunction(
        () => document.querySelector("#originGroup").options.length === 3,
      );
    }
    await login(page, "warehouse");
    const key = [ids.company, ids.site, ids.house, ids.lot, "2026-10-27"].join(
      "/",
    );
    await page.locator("#originGroup").selectOption(key);
    assert.equal(await page.locator("#originList button").count(), 2);
    assert.equal(await page.locator("#incidentHint").isVisible(), true);
    assert.equal(await page.locator("#scenarioSelect").count(), 0);
    assert.equal(await page.locator("#reviewButton").isDisabled(), true);
    const choose = async (id, qty) => {
      await page.locator(`#originList button[title="${id}"]`).click();
      await page
        .locator("#processRows tr")
        .filter({ hasText: id.slice(0, 8) })
        .locator("input")
        .fill(String(qty));
    };
    await choose(a, 20);
    await choose(b, 10);
    await page.getByLabel("Huevos, resultado 1", { exact: true }).fill("20");
    await page
      .getByLabel("Tipología, resultado 1", { exact: true })
      .selectOption("AA");
    assert.equal(await page.locator("#reviewButton").isDisabled(), true);
    await page.locator("#addLine").click();
    await page.getByLabel("Huevos, resultado 2", { exact: true }).fill("5");
    await page
      .getByLabel("Condición, resultado 2", { exact: true })
      .selectOption("DIRTY");
    await page.locator("#addLine").click();
    await page.getByLabel("Huevos, resultado 3", { exact: true }).fill("5");
    await page
      .getByLabel("Tipología, resultado 3", { exact: true })
      .selectOption("PIPO");
    await page
      .getByLabel("Condición, resultado 3", { exact: true })
      .selectOption("BROKEN");
    assert.equal(
      await page
        .getByLabel("Destino, resultado 3", { exact: true })
        .inputValue(),
      "DISCARD",
    );
    assert.equal(
      await page
        .getByLabel("Destino, resultado 3", { exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await page
        .getByLabel("Condición, resultado 1", { exact: true })
        .locator("option:checked")
        .textContent(),
      "Limpio",
    );
    assert.equal(
      await page
        .getByLabel("Destino, resultado 1", { exact: true })
        .locator("option:checked")
        .textContent(),
      "No definido",
    );
    await page.locator("#classifiedDate").fill("2026-10-28");
    await page.locator("#classifiedTime").fill("12:00");
    await context.setOffline(true);
    assert.equal(await page.locator("#networkNotice").isVisible(), true);
    assert.equal(await page.locator("#reviewButton").isDisabled(), true);
    await context.setOffline(false);
    await page.locator("#reviewButton").click();
    assert.equal(
      await page
        .locator("#reviewHeading")
        .evaluate((el) => document.activeElement === el),
      true,
    );
    await mkdir("evidence", { recursive: true });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page
      .locator("#reviewPanel")
      .screenshot({ path: "evidence/dev010e-classification-mobile.png" });
    const sent = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.endsWith("/manual-classifications")
      )
        sent.push(request.postDataJSON());
    });
    await page.route("**/manual-classifications", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      await route.fetch();
      await route.abort("failed");
    });
    await page.evaluate(() => {
      document.querySelector("#confirmButton").click();
      document.querySelector("#confirmButton").click();
    });
    await page.locator("#uncertainNotice").waitFor({ state: "visible" });
    await page
      .locator("#error")
      .filter({ hasText: "No se confirmó el resultado" })
      .waitFor();
    assert.equal(sent.length, 1);
    assert.equal(await page.locator("#companySelect").isDisabled(), true);
    const stored = await provider(
      `/rest/v1/manual_classification_sessions?company_id=eq.${ids.company}`,
    );
    assert.equal(stored.length, 1);
    assert.equal(stored[0].processed_quantity, 30);
    assert.equal(stored[0].lot_id, ids.lot);
    await page.unroute("**/manual-classifications");
    await page.locator("#retryIntent").click();
    await page
      .locator("#sessionDetail")
      .filter({ hasText: "30 huevos" })
      .waitFor();
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.match(await page.locator("#sessionDetail").textContent(), /Limpio/);
    assert.match(
      await page.locator("#sessionDetail").textContent(),
      /No definido/,
    );
    assert.equal(
      (
        await provider(
          `/rest/v1/manual_classification_sessions?company_id=eq.${ids.company}`,
        )
      ).length,
      1,
    );
    const incidents = await provider(
      `/rest/v1/custody_incidents?company_id=eq.${ids.company}`,
    );
    assert.equal(incidents.length, 2);
    assert.ok(incidents.every((x) => x.status === "open"));
    const events = await provider(
      `/rest/v1/collection_events?company_id=eq.${ids.company}`,
    );
    assert.equal(
      events.reduce((n, x) => n + x.quantity_eggs, 0),
      105,
    );
    const readContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
      colorScheme: "dark",
    });
    const readPage = await readContext.newPage();
    await readPage.goto(`${f.origin}/experimental/classification/`);
    await readPage.locator("#loginForm [name=email]").fill(users.capture.email);
    await readPage
      .locator("#loginForm [name=password]")
      .fill(users.capture.password);
    await readPage.locator("#loginForm button").click();
    await readPage.locator("#companySelect").selectOption(ids.company);
    await readPage.locator("#originDate").fill("2026-10-27");
    await readPage.locator("#originDate").press("Tab");
    await readPage.locator("#permissionNotice").waitFor({ state: "visible" });
    assert.equal(await readPage.locator("#addLine").isDisabled(), true);
    await readPage.locator(".view-tab[data-view=session]").click();
    await readPage.locator("#sessionList button").first().click();
    await readPage
      .locator("#sessionDetail")
      .filter({ hasText: "30 huevos" })
      .waitFor();
    assert.equal(
      await readPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.equal(
      await readPage.locator(".date-pair").evaluate((parent) => {
        const boxes = [...parent.querySelectorAll("label")].map((node) =>
          node.getBoundingClientRect(),
        );
        return boxes.every((a, index) =>
          boxes
            .slice(index + 1)
            .every(
              (b) =>
                a.right <= b.left ||
                b.right <= a.left ||
                a.bottom <= b.top ||
                b.bottom <= a.top,
            ),
        );
      }),
      true,
      "Mobile date and time labels must not overlap",
    );
    await readPage.screenshot({
      path: "evidence/dev010e-classification-dark.png",
    });
    await readContext.close();
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: "evidence/dev010e-classification-desktop.png",
    });
    // Reload loses no server session: return through the actual paginated list.
    await page.reload();
    await page.locator("#companySelect").selectOption(ids.company);
    await page.locator("#originDate").fill("2026-10-27");
    await page.locator("#originDate").press("Tab");
    await page.locator(".view-tab[data-view=session]").click();
    await page.locator("#sessionList button").first().click();
    await page
      .locator("#sessionDetail")
      .filter({ hasText: stored[0].session_id })
      .waitFor();
    await page.locator(".view-tab[data-view=capture]").click();
    await page.locator("#originGroup").selectOption(key);
    await choose(a, 39);
    await page.getByLabel("Huevos, resultado 1", { exact: true }).fill("39");
    await page.locator("#classifiedDate").fill("2026-10-28");
    await page.locator("#classifiedTime").fill("12:00");
    await page.locator("#reviewButton").click();
    const packet = {
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
      inputs: [{ transfer_id: a, quantity_eggs: 1 }],
      lines: [
        {
          line_id: randomUUID(),
          quantity_eggs: 1,
          typology: "AA",
          condition: "NORMAL",
          destination: "PENDING",
        },
      ],
    };
    await rpc(
      "record_manual_classification",
      { p_record: packet },
      users.warehouse.token,
    );
    await page.locator("#confirmButton").click();
    await page.locator("#changedNotice").waitFor({ state: "visible" });
    await page.locator("#refreshInputs").click();
    const amount = page
      .locator("#processRows tr")
      .filter({ hasText: a.slice(0, 8) })
      .locator("input");
    assert.equal(await amount.inputValue(), "39");
    assert.equal(await page.locator("#reviewButton").isDisabled(), true);
    await amount.fill("38");
    await page.getByLabel("Huevos, resultado 1", { exact: true }).fill("38");
    await page.locator("#reviewButton").click();
    const [membership] = await provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.warehouse.id}`,
    );
    await provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${membership.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    await page.locator("#confirmButton").click();
    await page.locator("#permissionNotice").waitFor({ state: "visible" });
    assert.equal(
      (
        await provider(
          `/rest/v1/manual_classification_sessions?company_id=eq.${ids.company}`,
        )
      ).length,
      2,
    );
    const otherPage = await context.newPage();
    await otherPage.goto(`${f.origin}/experimental/classification/`);
    await otherPage.request.post(`${f.origin}/v1/auth/login`, {
      headers: { Origin: f.origin },
      data: { email: users.foreign.email, password: users.foreign.password },
    });
    await page.locator("#refreshInputs").click();
    await page.locator("#loginPanel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#workspace").isHidden(), true);
    assert.equal(await page.locator("#sessionDetail").textContent(), "");
    assert.deepEqual(errors, []);
    assert.deepEqual(resourceErrors, []);
  } catch (error) {
    if (context?.pages()[0])
      await context
        .pages()[0]
        .screenshot({
          path: "/private/tmp/tamago-dev010e-ui-failure.png",
          fullPage: true,
        })
        .catch(() => {});
    throw error;
  } finally {
    await context?.close();
    await browser?.close();
    await f.close();
  }
});
