import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

const enabled =
  process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
  Boolean(process.env.TAMAGO_CUSTODY_TEST_ENV_FILE);
test("custody UI → gateway → real Auth/Postgres: receipt, investigation, review, recovery and isolation", {
  skip: enabled
    ? false
    : "Requires an explicitly provisioned disposable DEV-009C Supabase.",
  timeout: 120000,
}, async () => {
  const fixture = await startRealCustodyFixture();
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const warehouseContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await warehouseContext.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    async function login(target, role) {
      await target.goto(`${fixture.origin}/experimental/custody/`);
      await target.locator("#loginPanel").waitFor({ state: "visible" });
      await target
        .locator("#loginForm [name=email]")
        .fill(fixture.users[role].email);
      await target
        .locator("#loginForm [name=password]")
        .fill(fixture.users[role].password);
      await target.locator("#loginForm button").click();
      await target.locator("#workspace").waitFor({ state: "visible" });
    }
    async function select(target, id = fixture.ids.transfer) {
      await target.locator(`#transfers button[data-id="${id}"]`).click();
      await target.locator("#detail").waitFor({ state: "visible" });
      await target.waitForFunction(
        () => !document.querySelector("#refreshDetail").disabled,
      );
    }
    const waitRevision = (target, n) =>
      target.waitForFunction(
        (n) =>
          document
            .querySelector("#caseStatus")
            .textContent.includes(`revisión ${n}`) &&
          !document.querySelector("#refreshDetail").disabled,
        n,
      );
    async function call(
      target,
      tail,
      body,
      role = "warehouse",
      company = fixture.ids.company,
    ) {
      return target.evaluate(
        async ({ path, body, user }) => {
          const result = await fetch(path, {
            method: body ? "POST" : "GET",
            headers: {
              "content-type": "application/json",
              "x-tamago-user": user,
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          return { status: result.status, body: await result.json() };
        },
        {
          path: `/v1/companies/${company}/${tail}`,
          body,
          user: fixture.users[role].id,
        },
      );
    }
    await login(page, "warehouse");
    await page.waitForFunction(
      () => document.querySelectorAll("#transfers button").length === 25,
    );
    await page.locator("#moreTransfers").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#transfers button").length === 27,
    );
    assert.equal(await page.locator("#moreTransfers").isVisible(), false);
    await select(page);
    assert.match(
      await page.locator("#quantities").textContent(),
      /100 huevos enviados/,
    );
    await page.locator("#receiptForm [name=quantity]").fill("98");
    await page.locator("#receiptForm [name=location]").fill("Bodega ficticia");
    await page
      .locator("#receiptForm [name=note]")
      .fill("Conteo físico ficticio");
    const sent = [];
    let drop = true;
    await page.route("**/custody-transfers/*/receipt", async (route) => {
      sent.push(route.request().postData());
      if (drop) {
        drop = false;
        await route.fetch();
        await route.abort("failed");
      } else await route.continue();
    });
    await page.evaluate(() => {
      document.querySelector("#receiptForm").requestSubmit();
      document.querySelector("#receiptForm").requestSubmit();
    });
    await page.locator("#retryPanel").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => !document.querySelector("#retry").disabled,
    );
    assert.equal(sent.length, 1, "Double submit must not send twice.");
    assert.equal(
      await page.locator("#receiptForm [name=quantity]").isDisabled(),
      true,
    );
    assert.doesNotMatch(
      await page.locator("#message").textContent(),
      /Confirmado/,
    );
    await page.locator("#retry").click();
    await waitRevision(page, 0);
    assert.equal(sent.length, 2);
    assert.equal(
      sent[0],
      sent[1],
      "Lost response retry must preserve timestamp and content.",
    );
    await page.unroute("**/custody-transfers/*/receipt");
    const [transfer] = await fixture.provider(
      `/rest/v1/collection_transfers?transfer_id=eq.${fixture.ids.transfer}`,
    );
    assert.equal(transfer.received_quantity, 98);
    let [incident] = await fixture.provider(
      `/rest/v1/custody_incidents?transfer_id=eq.${fixture.ids.transfer}`,
    );
    assert.equal(incident.quantity_difference, 2);
    await page.reload();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await select(page);
    assert.match(
      await page.locator("#quantities").textContent(),
      /98 huevos recibidos/,
    );
    const literal = '<img src=x onerror="window.custodyInjected=true">';
    await page.locator("#evidenceForm [name=notes]").fill(literal);
    await page.locator("#evidenceForm button").click();
    await waitRevision(page, 1);
    assert.equal(await page.locator("#evidence img").count(), 0);
    assert.equal(await page.evaluate(() => window.custodyInjected), undefined);
    await page
      .locator("#submitForm [name=summary]")
      .fill("Primera investigación ficticia");
    await page.locator("#submitForm button").click();
    await waitRevision(page, 2);
    assert.equal(await page.locator("#evidenceForm").isVisible(), false);

    const directorContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const director = await directorContext.newPage();
    await login(director, "director");
    await select(director);
    assert.equal(await director.locator("#reviewForm").isVisible(), true);
    assert.equal(await director.locator("#receiptForm").isVisible(), false);
    const forbidden = await call(
      director,
      "custody-case-actions",
      {
        schema_version: 1,
        command_id: crypto.randomUUID(),
        company_id: fixture.ids.company,
        incident_id: incident.incident_id,
        expected_revision: 2,
        action: "add_evidence",
        details: { kind: "other", reference: null, notes: "No es Bodega" },
      },
      "director",
    );
    assert.equal(forbidden.status, 403);
    await director
      .locator("#reviewForm [name=reason]")
      .fill("Solicito antecedente de entrega ficticio");
    await director.locator("#reviewForm button").click();
    await waitRevision(director, 3);
    await page.bringToFront();
    await page.locator("#refreshDetail").click();
    await waitRevision(page, 3);

    // Another client advances the case between this screen's read and write.
    await fixture.rpc(
      "record_custody_case_action",
      {
        p_command: {
          schema_version: 1,
          command_id: crypto.randomUUID(),
          company_id: fixture.ids.company,
          incident_id: incident.incident_id,
          expected_revision: 3,
          action: "add_evidence",
          details: {
            kind: "other",
            reference: null,
            notes: "Antecedente de otro cliente ficticio",
          },
        },
      },
      fixture.users.warehouse.token,
    );
    await page
      .locator("#evidenceForm [name=notes]")
      .fill("Borrador conservado tras conflicto");
    await page.locator("#evidenceForm button").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#error")
        .textContent.includes("expediente cambió"),
    );
    assert.equal(
      await page.locator("#evidenceForm [name=notes]").inputValue(),
      "Borrador conservado tras conflicto",
    );
    assert.equal(await page.locator("#retryPanel").isVisible(), false);
    await page.locator("#refreshDetail").click();
    await waitRevision(page, 4);
    await page.locator("#evidenceForm button").click();
    await waitRevision(page, 5);
    await page
      .locator("#submitForm [name=summary]")
      .fill("Segunda investigación ficticia");
    await page.locator("#submitForm button").click();
    await waitRevision(page, 6);
    await director.bringToFront();
    await director.locator("#refreshDetail").click();
    await waitRevision(director, 6);
    await director
      .locator("#reviewForm [name=action]")
      .selectOption("continue_investigation");
    await director
      .locator("#reviewForm [name=reason]")
      .fill("Continuar investigación sin aplicar pérdida");
    await director.locator("#reviewForm button").click();
    await waitRevision(director, 7);

    for (let n = 0; n < 51; n++)
      await fixture.rpc(
        "record_custody_case_action",
        {
          p_command: {
            schema_version: 1,
            command_id: crypto.randomUUID(),
            company_id: fixture.ids.company,
            incident_id: incident.incident_id,
            expected_revision: 7 + n,
            action: "add_evidence",
            details: {
              kind: "other",
              reference: null,
              notes: `Antecedente paginado ficticio ${n}`,
            },
          },
        },
        fixture.users.warehouse.token,
      );
    await page.bringToFront();
    await page.locator("#refreshDetail").click();
    await waitRevision(page, 58);
    assert.equal(await page.locator("#history li").count(), 50);
    await page.locator("#moreHistory").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#history li").length === 58,
    );
    assert.equal(await page.locator("#evidence li").count(), 50);
    await page.locator("#moreEvidence").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#evidence li").length === 54,
    );
    assert.match(
      await page.locator("#history").textContent(),
      /Primera investigación ficticia/,
    );
    assert.match(
      await page.locator("#history").textContent(),
      /Segunda investigación ficticia/,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
      true,
    );
    await mkdir("evidence", { recursive: true });
    await page.locator("#originTitle").scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "evidence/dev009c-custody.png",
      fullPage: false,
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "evidence/dev009c-custody-overview.png",
      fullPage: false,
    });

    // Explicit zero receipt remains different from no receipt.
    await page.locator("#refreshList").click();
    await page.waitForFunction(
      () => !document.querySelector("#refreshList").disabled,
    );
    await page.locator("#moreTransfers").click();
    await page.waitForFunction(
      () => document.querySelectorAll("#transfers button").length === 27,
    );
    await select(page, fixture.extra[0]);
    await page.locator("#receiptForm [name=quantity]").fill("0");
    await page.locator("#receiptForm [name=location]").fill("Bodega ficticia");
    await page.locator("#receiptForm button").click();
    await waitRevision(page, 0);
    assert.match(
      await page.locator("#quantities").textContent(),
      /0 huevos recibidos/,
    );

    const foreignContext = await browser.newContext();
    const foreign = await foreignContext.newPage();
    await login(foreign, "foreign");
    await foreign.waitForFunction(() =>
      document
        .querySelector("#listStatus")
        .textContent.includes("No hay traslados"),
    );
    assert.equal(
      (
        await call(
          foreign,
          `custody-transfers/${fixture.ids.transfer}`,
          undefined,
          "foreign",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          foreign,
          "custody-case-actions",
          {
            schema_version: 1,
            command_id: crypto.randomUUID(),
            company_id: fixture.ids.company,
            incident_id: incident.incident_id,
            expected_revision: 58,
            action: "submit",
            details: { summary: "Ajeno" },
          },
          "foreign",
        )
      ).status,
      403,
    );
    assert.equal((await call(page, "custody-transfers?offset=-1")).status, 400);
    const cookies = await warehouseContext.cookies();
    const crossOrigin = await fetch(
      `${fixture.origin}/v1/companies/${fixture.ids.company}/custody-case-actions`,
      {
        method: "POST",
        headers: {
          origin: "https://untrusted.invalid",
          cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; "),
          "x-tamago-user": fixture.users.warehouse.id,
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    assert.equal(crossOrigin.status, 403);
    assert.equal(
      (
        await call(page, "custody-case-actions", {
          company_id: fixture.ids.foreign,
        })
      ).status,
      400,
    );

    // A session changed in another tab must never apply the visible actor's form.
    await page.evaluate(
      async (credentials) => {
        await fetch("/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(credentials),
        });
      },
      {
        email: fixture.users.director.email,
        password: fixture.users.director.password,
      },
    );
    await page.locator("#refreshDetail").click();
    await page.locator("#loginPanel").waitFor({ state: "visible" });
    assert.equal(await page.locator("#detail").isVisible(), false);
    assert.equal(await page.locator("#identity").textContent(), "");
    await page
      .locator("#loginForm [name=email]")
      .fill(fixture.users.warehouse.email);
    await page
      .locator("#loginForm [name=password]")
      .fill(fixture.users.warehouse.password);
    await page.locator("#loginForm button").click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await select(page);
    let release;
    let held;
    let delivered;
    const delivery = new Promise((resolve) => {
      delivered = resolve;
    });
    const arrived = new Promise((resolve) => {
      held = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/custody-transfers/${fixture.ids.transfer}`,
      async (route) => {
        const result = await route.fetch();
        held();
        await gate;
        await route.fulfill({ response: result });
        delivered();
      },
    );
    await page.locator("#refreshDetail").click();
    await arrived;
    await page.locator("#logout").click();
    await page.locator("#loginPanel").waitFor({ state: "visible" });
    release();
    await delivery;
    await page.unroute(`**/custody-transfers/${fixture.ids.transfer}`);
    assert.equal(await page.locator("#detail").isVisible(), false);
    assert.equal(await page.locator("#originTitle").textContent(), "");
    const anonymous = await browser.newContext();
    const anon = await anonymous.request.get(
      `${fixture.origin}/v1/companies/${fixture.ids.company}/custody-transfers`,
      { headers: { "x-tamago-user": fixture.users.warehouse.id } },
    );
    assert.equal(anon.status(), 401);
    assert.deepEqual(pageErrors, []);
    const totals = await fixture.provider(
      `/rest/v1/collection_events?company_id=eq.${fixture.ids.company}&select=quantity_eggs`,
    );
    assert.deepEqual(
      totals.map((x) => x.quantity_eggs),
      [126],
    );
    [incident] = await fixture.provider(
      `/rest/v1/custody_incidents?transfer_id=eq.${fixture.ids.transfer}`,
    );
    assert.equal(incident.status, "investigating");
    assert.equal(incident.revision, 58);
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
});
