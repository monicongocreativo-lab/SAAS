import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { makeServer } from "../../scripts/serve.mjs";

const ids = {
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  company: "11111111-1111-4111-8111-111111111111",
  site: "22222222-2222-4222-8222-222222222222",
  house: "33333333-3333-4333-8333-333333333333",
  lot: "44444444-4444-4444-8444-444444444444",
};
const company = {
  id: ids.company,
  code: "TAMAGO",
  legal_name: "Tamago ficticio",
  status: "active",
};
const catalog = {
  company,
  sites: [{ id: ids.site, code: "SEDE-A", name: "Sede A", status: "active" }],
  houses: [
    {
      id: ids.house,
      site_id: ids.site,
      code: "GALPON-A",
      name: "Galpón A",
      status: "active",
    },
  ],
  lots: [
    {
      id: ids.lot,
      site_id: ids.site,
      house_id: ids.house,
      code: "LOTE-A",
      status: "active",
    },
  ],
};

const server = makeServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TAMAGO_BROWSER_CHANNEL
    ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
    : {}),
});

try {
  await test("DEV-006 logs in, changes initial password, and selects only the authenticated catalog", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      serviceWorkers: "block",
    });
    const page = await context.newPage();
    const calls = [];
    let authenticated = false;
    let passwordPending = false;

    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      calls.push({
        path,
        method,
        body: request.postDataJSON() ?? null,
        authenticatedAtStart: authenticated,
      });
      let status = 200;
      let body = {};
      const headers = {};
      if (path === "/v1/auth/me" && !authenticated) {
        status = 401;
        body = { error: "AUTHENTICATION_REQUIRED" };
      } else if (path === "/v1/auth/login") {
        const credentials = request.postDataJSON();
        if (credentials.password !== "correct-temporary") {
          status = 401;
          body = { error: "INVALID_CREDENTIALS" };
        } else {
          authenticated = true;
          passwordPending = true;
          body = { user_id: ids.user, password_change_required: true };
          headers["set-cookie"] =
            "__Host-tamago_dev_session=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/";
        }
      } else if (path === "/v1/auth/me" && authenticated) {
        body = { user_id: ids.user, password_change_required: passwordPending };
      } else if (
        path === "/v1/auth/change-initial-password" &&
        method === "POST"
      ) {
        passwordPending = false;
        body = { password_changed: true };
      } else if (path === "/v1/companies") {
        body = [company];
      } else if (path === `/v1/companies/${ids.company}/operational-catalog`) {
        body = catalog;
      } else if (path === "/v1/auth/logout" && method === "POST") {
        authenticated = false;
        status = 204;
        body = null;
      } else {
        status = 404;
        body = { error: "NOT_FOUND" };
      }
      calls.at(-1).responseStatus = status;
      await route.fulfill({
        status,
        ...(status === 204
          ? {}
          : { contentType: "application/json", body: JSON.stringify(body) }),
        headers,
      });
    });

    try {
      await page.goto(`${baseUrl}/experimental/recogidas/`);
      await page
        .locator("#authStatus")
        .filter({ hasText: "Inicia sesión" })
        .waitFor();
      await page.locator("#loginForm").waitFor({ state: "visible" });
      await page
        .locator("#loginForm [name=email]")
        .fill("galponero@example.test");
      await page.locator("#loginForm [name=password]").fill("wrong-password");
      await page.locator('#loginForm button[type="submit"]').click();
      await page
        .locator("#authError")
        .filter({ hasText: "incorrectos" })
        .waitFor();

      await page
        .locator("#loginForm [name=password]")
        .fill("correct-temporary");
      await page.locator('#loginForm button[type="submit"]').click();
      await page.locator("#passwordChangeForm").waitFor({ state: "visible" });
      assert.equal(
        calls.some(({ path }) => path === "/v1/companies"),
        false,
      );

      await page
        .locator('#passwordChangeForm [name="new_password"]')
        .fill("new-synthetic-password-123");
      await page
        .locator('#passwordChangeForm [name="confirm_password"]')
        .fill("new-synthetic-password-123");
      await page.locator('#passwordChangeForm button[type="submit"]').click();
      await page.locator("#catalogCompany").waitFor({ state: "visible" });
      await page.waitForFunction(
        () => !document.querySelector("#catalogCompany").disabled,
      );

      await page.locator("#catalogCompany").selectOption(ids.company);
      await page.locator("#catalogSite").selectOption(ids.site);
      await page.locator("#catalogHouse").selectOption(ids.house);
      await page.locator("#catalogLot").selectOption(ids.lot);
      assert.match(
        await page.locator("#catalogStatus").textContent(),
        /lote\(s\) autorizado/,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          local: Object.keys(localStorage),
          session: Object.keys(sessionStorage),
        })),
        { local: [], session: [] },
      );
      assert.equal(
        calls.some(
          ({ path }) =>
            path === `/v1/companies/${ids.company}/collection-events`,
        ),
        false,
      );

      await page.locator("#logout").click();
      await page.locator("#loginForm").waitFor({ state: "visible" });
      assert.equal(calls.at(-1).path, "/v1/auth/logout");
    } finally {
      await context.close();
    }
  });

  await test("DEV-006 shows an empty authorized directory without synthetic choices", async () => {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage();
    const calls = [];
    await page.route("**/v1/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      calls.push(path);
      if (path === "/v1/auth/me")
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            user_id: ids.user,
            password_change_required: false,
          }),
        });
      else if (path === "/v1/companies")
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: "[]",
        });
      else await route.fulfill({ status: 404, body: "{}" });
    });
    try {
      await page.goto(`${baseUrl}/experimental/recogidas/`);
      await page.locator("#catalogCompany").waitFor({ state: "visible" });
      await page
        .locator("#catalogStatus")
        .filter({ hasText: "no tiene empresas activas" })
        .waitFor();
      assert.deepEqual(calls, ["/v1/auth/me", "/v1/companies"]);
      assert.equal(await page.locator("#catalogCompany option").count(), 1);
      assert.equal(
        await page
          .locator("#catalogCompany option")
          .filter({ hasText: "SYN-TAMAGO" })
          .count(),
        0,
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          local: Object.keys(localStorage),
          session: Object.keys(sessionStorage),
        })),
        { local: [], session: [] },
      );
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
