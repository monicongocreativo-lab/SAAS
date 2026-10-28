import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("sender UI → real Auth/Postgres → warehouse: daily origin, partial dispatch, retry, stale balance and scoped roles", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase.",
  timeout: 120000,
}, async () => {
  const fixture = await startRealCustodyFixture({ seedTransfers: false });
  let browser;
  const { ids, users, provider, rpc } = fixture;
  const collection = (date, occurrence, quantity, scope = ids) => ({
    schema_version: 2,
    event_id: randomUUID(),
    company_id: ids.company,
    site_id: scope.site,
    house_id: scope.house,
    lot_id: scope.lot,
    business_date: date,
    occurrence,
    quantity_eggs: quantity,
    occurred_at: `${date}T12:00:00.000Z`,
    captured_at: `${date}T12:01:00.000Z`,
    actor_declared_id: "Ficticio",
    device_id: randomUUID(),
  });
  const dispatch = (quantity, date = "2026-10-27", scope = ids) => ({
    schema_version: 1,
    transfer_id: randomUUID(),
    company_id: ids.company,
    site_id: scope.site,
    house_id: scope.house,
    lot_id: scope.lot,
    origin_business_date: date,
    quantity_sent: quantity,
    sent_from: "Galpón ficticio",
    sent_to: "Bodega ficticia",
    sent_at: new Date().toISOString(),
  });
  try {
    await rpc(
      "receive_collection_event",
      { p_event: collection("2026-10-27", 2, 50) },
      users.capture.token,
    );
    await rpc(
      "receive_collection_event",
      { p_event: collection("2026-10-26", 1, 0) },
      users.capture.token,
    );
    await rpc(
      "receive_collection_event",
      { p_event: collection("2026-10-25", 1, 30) },
      users.capture.token,
    );
    const other = {
      site: randomUUID(),
      house: randomUUID(),
      lot: randomUUID(),
    };
    await provider("/rest/v1/sites", {
      method: "POST",
      body: {
        id: other.site,
        company_id: ids.company,
        code: "SYN-OTHER",
        name: "Sede ajena a captura",
      },
    });
    await provider("/rest/v1/houses", {
      method: "POST",
      body: {
        id: other.house,
        company_id: ids.company,
        site_id: other.site,
        code: "SYN-OTHER",
        name: "Galpón fuera de ámbito",
      },
    });
    await provider("/rest/v1/lots", {
      method: "POST",
      body: {
        id: other.lot,
        company_id: ids.company,
        site_id: other.site,
        house_id: other.house,
        code: "SYN-OTHER",
        status: "active",
      },
    });
    const [directorMembership] = await provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.director.id}`,
    );
    await provider("/rest/v1/role_assignments", {
      method: "POST",
      body: {
        company_id: ids.company,
        membership_id: directorMembership.id,
        role_key: "capture",
        site_id: other.site,
        house_id: other.house,
        lot_id: other.lot,
      },
    });
    await rpc(
      "receive_collection_event",
      { p_event: collection("2026-10-27", 1, 20, other) },
      users.director.token,
    );
    const email = `${randomUUID()}@example.invalid`,
      password = `Ficticia-${randomUUID()}`;
    const transport = await provider("/auth/v1/admin/users", {
      method: "POST",
      body: { email, password, email_confirm: true },
    });
    users.transport = { id: transport.id, email, password };
    const signed = await provider("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email, password },
      token: null,
    });
    users.transport.token = signed.access_token;
    const membership = randomUUID();
    await provider("/rest/v1/company_memberships", {
      method: "POST",
      body: {
        id: membership,
        company_id: ids.company,
        user_id: transport.id,
        status: "active",
      },
    });
    await provider("/rest/v1/role_assignments", {
      method: "POST",
      body: {
        company_id: ids.company,
        membership_id: membership,
        role_key: "transport",
        site_id: ids.site,
        house_id: ids.house,
        lot_id: ids.lot,
      },
    });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const senderContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      page = await senderContext.newPage(),
      pageErrors = [];
    page.on("pageerror", (cause) => pageErrors.push(cause.message));
    async function login(target, role) {
      await target.goto(`${fixture.origin}/experimental/custody/`);
      await target.locator("#loginPanel").waitFor({ state: "visible" });
      await target.locator("#loginForm [name=email]").fill(users[role].email);
      await target
        .locator("#loginForm [name=password]")
        .fill(users[role].password);
      await target.locator("#loginForm button").click();
      await target.waitForFunction(
        () =>
          !document.querySelector("#workspace").hidden &&
          !document.querySelector("#refreshOrigins").disabled,
      );
    }
    async function chooseDate(target, date) {
      await target.locator("#originDate").fill(date);
      await target.waitForFunction(
        () =>
          document.querySelector("#origins").getAttribute("aria-busy") ===
            "false" && !document.querySelector("#refreshOrigins").disabled,
      );
    }
    async function selectOrigin(target) {
      await target.locator("#origins button").first().click();
    }
    const waitAvailable = (target, n) =>
      target.waitForFunction(
        (n) =>
          document
            .querySelector("#dispatchOrigin")
            .textContent.includes(`${n} disponibles para entrega`) &&
          !document.querySelector("#refreshOrigins").disabled,
        n,
      );
    async function api(
      target,
      tail,
      body,
      role = "capture",
      company = ids.company,
    ) {
      return target.evaluate(
        async ({ path, body, user }) => {
          const r = await fetch(path, {
            method: body ? "POST" : "GET",
            headers: {
              "content-type": "application/json",
              "x-tamago-user": user,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          return { status: r.status, body: await r.json() };
        },
        {
          path: `/v1/companies/${company}/${tail}`,
          body,
          user: users[role].id,
        },
      );
    }

    await page.goto(`${fixture.origin}/experimental/recogidas/`);
    await page.locator("#loginForm [name=email]").fill(users.capture.email);
    await page
      .locator("#loginForm [name=password]")
      .fill(users.capture.password);
    await page.locator("#loginForm button").click();
    await page.locator("#catalogPanel").waitFor({ state: "visible" });
    await page
      .getByRole("link", {
        name: "Registrar entrega a Bodega · requiere conexión",
      })
      .click();
    await page.waitForFunction(
      () =>
        !document.querySelector("#workspace").hidden &&
        !document.querySelector("#refreshOrigins").disabled,
    );
    await chooseDate(page, "2026-10-24");
    assert.equal(await page.locator("#origins button").count(), 0);
    assert.match(
      await page.locator("#originsStatus").textContent(),
      /No se interpreta como cero/,
    );
    await chooseDate(page, "2026-10-26");
    await selectOrigin(page);
    assert.match(
      await page.locator("#dispatchOrigin").textContent(),
      /0 huevos registrados/,
    );
    assert.equal(await page.locator("#dispatchForm").isVisible(), false);
    await chooseDate(page, "2026-10-27");
    assert.equal(
      await page.locator("#origins button").count(),
      1,
      "Other assigned lot must be invisible to this capture user.",
    );
    await selectOrigin(page);
    await waitAvailable(page, 150);
    assert.match(
      await page.locator("#dispatchOrigin").textContent(),
      /2 recogida/,
    );
    assert.equal(
      await page.evaluate(() => document.activeElement.name),
      "quantity",
    );
    await page.locator("#dispatchForm [name=quantity]").fill("40");
    await page.locator("#dispatchForm [name=sent_to]").fill("Bodega ficticia");
    const bodies = [];
    let drop = true;
    await page.route("**/custody-transfers", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      bodies.push(route.request().postData());
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.evaluate(() => {
      document.querySelector("#dispatchForm").requestSubmit();
      document.querySelector("#dispatchForm").requestSubmit();
    });
    await page.waitForFunction(
      () =>
        !document.querySelector("#retryPanel").hidden &&
        !document.querySelector("#retry").disabled,
    );
    assert.equal(bodies.length, 1);
    assert.equal(await page.locator("#originDate").isDisabled(), true);
    assert.match(
      await page.locator("#pendingSummary").textContent(),
      /origen 2026-10-27.*40 huevos/,
    );
    await page.locator("#retry").click();
    await waitAvailable(page, 110);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
    const first = JSON.parse(bodies[0]);
    await page.unroute("**/custody-transfers");
    assert.equal(await page.locator("#receiptForm").isVisible(), false);
    const [stored] = await provider(
      `/rest/v1/collection_transfers?transfer_id=eq.${first.transfer_id}`,
    );
    assert.equal(stored.sent_by, users.capture.id);
    assert.equal(stored.quantity_sent, 40);
    const warehouseContext = await browser.newContext(),
      warehouse = await warehouseContext.newPage();
    await login(warehouse, "warehouse");
    assert.equal(await warehouse.locator("#dispatchPanel").isVisible(), false);
    await warehouse
      .locator(`#transfers button[data-id="${first.transfer_id}"]`)
      .click();
    await warehouse.locator("#receiptForm").waitFor({ state: "visible" });
    await warehouse.locator("#receiptForm [name=quantity]").fill("39");
    await warehouse
      .locator("#receiptForm [name=location]")
      .fill("Bodega ficticia");
    await warehouse.locator("#receiptForm button").click();
    await warehouse.waitForFunction(
      () =>
        document
          .querySelector("#caseStatus")
          .textContent.includes("diferencia enviada − recibida: 1 huevos") &&
        !document.querySelector("#refreshDetail").disabled,
    );
    await page.bringToFront();
    await page.locator("#refreshOrigins").click();
    await waitAvailable(page, 110);
    await page.locator("#dispatchForm [name=quantity]").fill("100");
    await page.locator("#dispatchForm [name=sent_to]").fill("Bodega ficticia");
    const external = dispatch(30);
    const { schema_version: _v, ...externalRpc } = external;
    await rpc(
      "dispatch_collection_transfer",
      { p_transfer: externalRpc },
      users.transport.token,
    );
    await page.locator("#dispatchForm button").click();
    await page.waitForFunction(() =>
      document.querySelector("#error").textContent.includes("El origen cambió"),
    );
    assert.equal(
      await page.locator("#dispatchForm [name=quantity]").inputValue(),
      "100",
    );
    assert.equal(await page.locator("#retryPanel").isVisible(), false);
    await page.locator("#refreshOrigins").click();
    await waitAvailable(page, 80);
    await page.locator("#dispatchForm [name=quantity]").fill("80");
    await page.locator("#dispatchForm button").click();
    await waitAvailable(page, 0);
    assert.equal(await page.locator("#dispatchForm").isVisible(), false);
    await page.reload();
    await page.waitForFunction(
      () =>
        !document.querySelector("#workspace").hidden &&
        !document.querySelector("#refreshOrigins").disabled,
    );
    await chooseDate(page, "2026-10-27");
    await selectOrigin(page);
    await waitAvailable(page, 0);

    const transportContext = await browser.newContext({
        viewport: { width: 390, height: 844 },
      }),
      transportPage = await transportContext.newPage();
    await login(transportPage, "transport");
    await chooseDate(transportPage, "2026-10-25");
    await selectOrigin(transportPage);
    await waitAvailable(transportPage, 30);
    await transportPage.locator("#dispatchForm [name=quantity]").fill("10");
    await transportPage
      .locator("#dispatchForm [name=sent_to]")
      .fill("Bodega ficticia");
    await transportPage.locator("#dispatchForm button").click();
    await waitAvailable(transportPage, 20);
    assert.equal(
      await transportPage.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await transportPage
      .locator("#dispatchTitle")
      .evaluate((el) => el.scrollIntoView({ block: "start" }));
    await mkdir("evidence", { recursive: true });
    await transportPage.screenshot({ path: "evidence/dev010a-dispatch.png" });
    assert.equal(
      (
        await api(page, "custody-transfers", {
          ...dispatch(1),
          sent_by: users.director.id,
        })
      ).status,
      400,
    );
    assert.equal(
      (await api(page, "custody-transfers", dispatch(1, "2026-10-27", other)))
        .status,
      403,
    );
    assert.equal(
      (await api(page, "custody-transfers", dispatch(1, "2026-10-24"))).status,
      409,
    );
    assert.equal(
      (await api(warehouse, "custody-transfers", dispatch(1), "warehouse"))
        .status,
      403,
    );
    assert.equal(
      (await api(page, "custody-origins?business_date=2026-02-31")).status,
      400,
    );
    const foreignContext = await browser.newContext(),
      foreign = await foreignContext.newPage();
    await login(foreign, "foreign");
    const foreignOrigins = await api(
      foreign,
      "custody-origins?business_date=2026-10-27",
      undefined,
      "foreign",
    );
    assert.equal(foreignOrigins.body.items.length, 0);
    assert.equal(foreignOrigins.body.authorized, false);
    assert.equal(
      (await api(foreign, "custody-transfers", dispatch(1), "foreign")).status,
      403,
    );
    const actual = await provider(
      `/rest/v1/collection_transfers?company_id=eq.${ids.company}&house_id=eq.${ids.house}&origin_business_date=eq.2026-10-27`,
    );
    assert.equal(actual.length, 3);
    assert.equal(
      actual.reduce((s, t) => s + t.quantity_sent, 0),
      150,
    );
    const original = await provider(
      `/rest/v1/collection_events?company_id=eq.${ids.company}&house_id=eq.${ids.house}&business_date=eq.2026-10-27&order=occurrence.asc`,
    );
    assert.deepEqual(
      original.map((e) => e.quantity_eggs),
      [100, 50],
    );
    const [issue] = await provider(
      `/rest/v1/custody_incidents?transfer_id=eq.${first.transfer_id}`,
    );
    assert.equal(issue.quantity_difference, 1);
    assert.equal(issue.status, "open");
    assert.deepEqual(pageErrors, []);
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
});
