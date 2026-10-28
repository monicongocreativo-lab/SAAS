import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import test from "node:test";
import { chromium } from "playwright";
import { makeServer } from "../../scripts/serve.mjs";

const company = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "SYN-TAMAGO",
  legal_name: "Tamago ficticio",
  status: "active",
};
const currentUser = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const invitedUser = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const membershipsFixture = [
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    user_id: currentUser,
    status: "active",
    roles: [{ role_key: "admin", revoked_at: null }],
  },
  {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    user_id: invitedUser,
    status: "invited",
    roles: [{ role_key: "warehouse", revoked_at: null }],
  },
];

const server = makeServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
let browser;

try {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.TAMAGO_BROWSER_CHANNEL
      ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
      : {}),
  });

  await test("admin UI respects company roles, safely renders identities and sends membership actions", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    const calls = [];
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      const method = request.method();
      calls.push({ path, method, headers: request.headers() });
      let response;
      if (path === "/v1/auth/me")
        response = { status: 401, body: { error: "AUTHENTICATION_REQUIRED" } };
      else if (path === "/v1/auth/login")
        response = {
          status: 200,
          body: { user_id: currentUser },
          headers: {
            "set-cookie":
              "__Host-tamago_dev_session=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/",
          },
        };
      else if (path === "/v1/companies")
        response = { status: 200, body: [company] };
      else if (path.endsWith("/identities/provisionings/pending"))
        response = { status: 200, body: [] };
      else if (path.endsWith("/memberships") && method === "GET")
        response = { status: 200, body: membershipsFixture };
      else if (path.endsWith("/memberships") && method === "POST") {
        calls[calls.length - 1].body = request.postDataJSON();
        response = {
          status: 200,
          body: { status: "invited", action: "invite" },
        };
      } else if (path.endsWith("/identities") && method === "POST") {
        calls[calls.length - 1].body = request.postDataJSON();
        response = {
          status: 201,
          body: {
            operation_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            user_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            membership_id: "99999999-9999-4999-8999-999999999999",
            temporary_password: "synthetic-temporary-password-12345",
            credential_recoverable: true,
          },
        };
      } else if (path.endsWith("/acknowledge") && method === "POST") {
        response = { status: 200, body: { credential_discarded: true } };
      } else if (
        path.endsWith(`/${membershipsFixture[1].id}`) &&
        method === "PATCH"
      ) {
        calls[calls.length - 1].body = request.postDataJSON();
        response = {
          status: 200,
          body: { status: "revoked", action: "revoke" },
        };
      } else response = { status: 404, body: { error: "NOT_FOUND" } };
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: JSON.stringify(response.body),
        ...(response.headers ? { headers: response.headers } : {}),
      });
    });

    await page.goto(`${baseUrl}/experimental/admin/`);
    await page.locator("#loginForm [name=email]").fill("admin@example.test");
    await page.locator("#loginForm [name=password]").fill("synthetic-password");
    await page.locator('#loginForm button[type="submit"]').click();
    await page.getByText("2 membresía(s)").waitFor();
    await page.getByRole("button", { name: "Buscar pendientes" }).click();
    await page.getByText("No hay entregas pendientes.").waitFor();
    const sessionCookie = (await context.cookies()).find(
      (cookie) => cookie.name === "__Host-tamago_dev_session",
    );
    assert.equal(sessionCookie?.httpOnly, true);
    assert.equal(sessionCookie?.secure, true);
    assert.equal(
      await page.locator("#members code").nth(1).textContent(),
      invitedUser,
    );
    assert.equal(
      await page
        .locator('#inviteForm [name="role_key"] option[value="director"]')
        .count(),
      0,
    );
    assert.equal(
      await page
        .locator('#inviteForm [name="role_key"] option[value="admin"]')
        .count(),
      0,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );

    await page
      .locator('#createIdentityForm [name="email"]')
      .fill("field@example.test");
    await page.locator("#createIdentityForm button").click();
    await page.getByText("Identidad creada").waitFor();
    assert.equal(
      await page.locator("#temporaryPassword").inputValue(),
      "synthetic-temporary-password-12345",
    );
    const identityCall = calls.find((call) =>
      call.path.endsWith("/identities"),
    );
    assert.deepEqual(identityCall.body, {
      email: "field@example.test",
      role_key: "capture",
    });
    assert.match(identityCall.headers["idempotency-key"], /^[0-9a-f-]{36}$/i);
    await page.getByRole("button", { name: "Ya la entregué; borrar" }).click();
    await page.getByText("Contraseña temporal fue borrada").waitFor();
    assert.equal(await page.locator("#temporaryPassword").inputValue(), "");

    await page.locator("details summary").click();

    await page.locator('#inviteForm [name="user_id"]').fill(invitedUser);
    await page.locator("#inviteForm button").click();
    await page.waitForFunction(
      () =>
        document
          .querySelector("#message")
          .textContent.includes("Invitación de membresía creada") ||
        !document.querySelector("#error").hidden,
    );
    assert.equal(await page.locator("#error").isVisible(), false);
    assert.deepEqual(
      calls.find(
        (call) => call.method === "POST" && call.path.endsWith("/memberships"),
      ).body,
      { user_id: invitedUser, role_key: "capture" },
    );

    await page.getByRole("button", { name: "Cancelar" }).click();
    await page.getByText("Cambio guardado por el servidor.").waitFor();
    assert.deepEqual(calls.find((call) => call.method === "PATCH").body, {
      action: "revoke",
    });

    await page.screenshot({
      path: "/private/tmp/tamago-dev004-admin-mobile.png",
      fullPage: true,
    });
    await context.close();
  });

  await test("same-origin auth proxy forwards only approved routes and preserves session cookie", async () => {
    const received = [];
    const upstream = createHttpServer((request, response) => {
      received.push({
        method: request.method,
        url: request.url,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
      });
      response.setHeader(
        "set-cookie",
        "__Host-test_session=opaque; Secure; HttpOnly; Path=/",
      );
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"user_id":"synthetic"}');
    });
    await new Promise((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const proxy = makeServer({
      authUpstream: `http://127.0.0.1:${upstream.address().port}`,
    });
    await new Promise((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    try {
      const response = await fetch(
        `http://127.0.0.1:${proxy.address().port}/v1/auth/me`,
        {
          headers: {
            origin: "http://127.0.0.1:8765",
            cookie: "__Host-tamago_dev_session=synthetic-cookie",
          },
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { user_id: "synthetic" });
      assert.match(response.headers.get("set-cookie"), /HttpOnly/);
      assert.deepEqual(received[0], {
        method: "GET",
        url: "/v1/auth/me",
        origin: "http://127.0.0.1:8765",
        cookie: "__Host-tamago_dev_session=synthetic-cookie",
      });

      const catalog = await fetch(
        `http://127.0.0.1:${proxy.address().port}/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/operational-catalog`,
        {
          headers: {
            origin: "http://127.0.0.1:8765",
            cookie: "__Host-tamago_dev_session=synthetic-cookie",
          },
        },
      );
      assert.equal(catalog.status, 200);
      assert.equal(
        received[1].url,
        "/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/operational-catalog",
      );

      const grantKeys = await fetch(
        `http://127.0.0.1:${proxy.address().port}/v1/offline-grant-keys`,
      );
      assert.equal(grantKeys.status, 200);
      assert.equal(received[2].url, "/v1/offline-grant-keys");
      const grantRegistration = await fetch(
        `http://127.0.0.1:${proxy.address().port}/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/offline-capture-grants`,
        {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:8765",
            cookie: "__Host-tamago_dev_session=synthetic-cookie",
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      assert.equal(grantRegistration.status, 200);
      assert.equal(
        received[3].url,
        "/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/offline-capture-grants",
      );
      const offlineReceipt = await fetch(
        `http://127.0.0.1:${proxy.address().port}/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/offline-collection-events`,
        {
          method: "POST",
          headers: {
            origin: "http://127.0.0.1:8765",
            cookie: "__Host-tamago_dev_session=synthetic-cookie",
            "content-type": "application/json",
          },
          body: "{}",
        },
      );
      assert.equal(offlineReceipt.status, 200);
      assert.equal(
        received[4].url,
        "/v1/companies/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/offline-collection-events",
      );

      const forbidden = await fetch(
        `http://127.0.0.1:${proxy.address().port}/v1/admin/users`,
      );
      assert.equal(forbidden.status, 404);
      assert.equal(received.length, 5);
      assert.throws(
        () => makeServer({ authUpstream: "https://example.com" }),
        /loopback/,
      );
    } finally {
      await new Promise((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
      await new Promise((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  await test("temporary access is gated until the user changes their password", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const calls = [];
    await page.route("**/v1/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const method = request.method();
      calls.push({ path, method });
      let response = { status: 404, body: { error: "NOT_FOUND" } };
      if (path === "/v1/auth/me")
        response = { status: 401, body: { error: "AUTHENTICATION_REQUIRED" } };
      else if (path === "/v1/auth/login")
        response = {
          status: 200,
          body: { user_id: currentUser, password_change_required: true },
          headers: {
            "set-cookie":
              "__Host-tamago_dev_session=synthetic; Secure; HttpOnly; SameSite=Lax; Path=/",
          },
        };
      else if (path === "/v1/auth/change-initial-password" && method === "POST")
        response = { status: 200, body: { password_changed: true } };
      else if (path === "/v1/companies")
        response = { status: 200, body: [company] };
      else if (path.endsWith("/memberships"))
        response = { status: 200, body: membershipsFixture };
      await route.fulfill({
        status: response.status,
        contentType: "application/json",
        body: JSON.stringify(response.body),
        ...(response.headers ? { headers: response.headers } : {}),
      });
    });
    try {
      await page.goto(`${baseUrl}/experimental/admin/`);
      await page.locator("#loginForm [name=email]").fill("new@example.test");
      await page
        .locator("#loginForm [name=password]")
        .fill("temporary-password");
      await page.locator('#loginForm button[type="submit"]').click();
      await page
        .getByRole("heading", { name: "Cambia tu contraseña temporal" })
        .waitFor();
      assert.equal(
        calls.some((call) => call.path === "/v1/companies"),
        false,
      );
      await page
        .locator('#passwordChangeForm [name="new_password"]')
        .fill("synthetic-new-password-56789");
      await page
        .locator('#passwordChangeForm [name="confirm_password"]')
        .fill("synthetic-new-password-56789");
      await page.locator("#passwordChangeForm button").click();
      await page.getByText("Contraseña cambiada").waitFor();
      assert.equal(
        calls.some((call) => call.path === "/v1/auth/change-initial-password"),
        true,
      );
      assert.equal(
        calls.some((call) => call.path === "/v1/companies"),
        true,
      );
    } finally {
      await context.close();
    }
  });
} finally {
  await browser?.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
