import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAuthPrototypeServer } from "../../src/auth-prototype/server.mjs";

const actorId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const companyId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const actorPassword = "synthetic-admin-password-98765";
const serviceRoleKey = "synthetic-local-service-role";
const appOrigin = "http://127.0.0.1:8765";
const actor = {
  id: actorId,
  email: "admin@example.invalid",
  password: actorPassword,
  app_metadata: {},
};
const identities = new Map([[actorId, actor]]);
const tokens = new Map([[
  "synthetic-admin-access-token",
  actor,
]]);
const directory = mkdtempSync(join(tmpdir(), "tamago-provisioning-flow-"));
const encryptionKey = randomBytes(32);
let server;
let baseUrl;
let userCreateCalls = 0;

before(async () => {
  server = createAuthPrototypeServer({
    apiUrl: "http://127.0.0.1:55421",
    restUrl: "http://127.0.0.1:55421/rest/v1",
    publishableKey: "synthetic-publishable-key",
    serviceRoleKey,
    allowedOrigins: [appOrigin],
    sessionDbPath: join(directory, "sessions.sqlite"),
    sessionEncryptionKey: encryptionKey,
    fetchImpl: providerFetch,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  if (server?.listening) await once(server, "close");
  encryptionKey.fill(0);
  rmSync(directory, { recursive: true, force: true });
});

test("identity provisioning is idempotent, gated until password change, and one-time credential handoff is erasable", async () => {
  const adminSession = await login(actor.email, actorPassword);
  const operationId = randomUUID();
  const identityEmail = "field@example.invalid";
  const url = `${baseUrl}/v1/companies/${companyId}/identities`;
  const first = await provision(url, adminSession.cookie, operationId, {
    email: identityEmail,
    role_key: "capture",
  });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.email_confirmed_by_prototype, true);
  assert.equal(typeof first.body.temporary_password, "string");
  assert.ok(first.body.temporary_password.length >= 32);
  assert.equal(userCreateCalls, 1);

  const replay = await provision(url, adminSession.cookie, operationId, {
    email: identityEmail,
    role_key: "capture",
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.body.user_id, first.body.user_id);
  assert.equal(replay.body.temporary_password, first.body.temporary_password);
  assert.equal(userCreateCalls, 1, "retry returns the same account and secret without creating a duplicate");
  const recoveries = await fetch(
    `${baseUrl}/v1/companies/${companyId}/identities/provisionings/pending`,
    { headers: { cookie: adminSession.cookie } },
  );
  const recoveryBody = await recoveries.json();
  assert.equal(recoveries.status, 200, JSON.stringify(recoveryBody));
  assert.equal(recoveryBody[0]?.temporary_password, first.body.temporary_password);

  const temporarySession = await login(identityEmail, first.body.temporary_password);
  assert.equal(temporarySession.result.password_change_required, true);
  const blocked = await fetch(`${baseUrl}/v1/companies`, {
    headers: { cookie: temporarySession.cookie },
  });
  assert.equal(blocked.status, 403);

  const samePassword = await post("/v1/auth/change-initial-password", temporarySession.cookie, {
    new_password: first.body.temporary_password,
  });
  assert.equal(samePassword.status, 400);
  const permanentPassword = "synthetic-permanent-password-12345";
  const changed = await post("/v1/auth/change-initial-password", temporarySession.cookie, {
    new_password: permanentPassword,
  });
  assert.equal(changed.status, 200);
  const me = await fetch(`${baseUrl}/v1/auth/me`, {
    headers: { cookie: temporarySession.cookie },
  });
  assert.equal((await me.json()).password_change_required, false);

  const acknowledged = await post(
    `/v1/companies/${companyId}/identities/provisionings/${operationId}/acknowledge`,
    adminSession.cookie,
    {},
  );
  assert.equal(acknowledged.status, 200);
  const afterAck = await provision(url, adminSession.cookie, operationId, {
    email: identityEmail,
    role_key: "capture",
  });
  assert.equal(afterAck.body.credential_recoverable, false);
  assert.equal("temporary_password" in afterAck.body, false);
  const emptyRecoveries = await fetch(
    `${baseUrl}/v1/companies/${companyId}/identities/provisionings/pending`,
    { headers: { cookie: adminSession.cookie } },
  );
  assert.deepEqual(await emptyRecoveries.json(), []);
});

test("first director cannot be created through ordinary identity provisioning", async () => {
  const adminSession = await login(actor.email, actorPassword);
  const result = await provision(
    `${baseUrl}/v1/companies/${companyId}/identities`,
    adminSession.cookie,
    randomUUID(),
    { email: "director@example.invalid", role_key: "director" },
  );
  assert.equal(result.response.status, 400);
  assert.equal(userCreateCalls, 1);
});

async function login(email, password) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { origin: appOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const result = await response.json();
  return {
    response,
    result,
    cookie: response.headers.get("set-cookie").split(";")[0],
  };
}

async function provision(url, cookie, operationId, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      origin: appOrigin,
      cookie,
      "content-type": "application/json",
      "idempotency-key": operationId,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json() };
}

async function post(path, cookie, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { origin: appOrigin, cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response;
}

async function providerFetch(input, options = {}) {
  const url = new URL(input);
  const body = options.body ? JSON.parse(options.body) : {};
  const authorization = options.headers?.authorization ?? "";
  const bearer = authorization.replace(/^Bearer\s+/i, "");
  if (url.pathname === "/auth/v1/token" && options.method === "POST") {
    const identity = [...identities.values()].find((entry) => entry.email === body.email && entry.password === body.password);
    if (!identity) return jsonResponse({ error: "invalid_credentials" }, 400);
    const accessToken = `synthetic-access-${identity.id}`;
    const refreshToken = `synthetic-refresh-${identity.id}`;
    tokens.set(accessToken, identity);
    return jsonResponse({
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 3600,
      user: { id: identity.id, app_metadata: { ...identity.app_metadata } },
    });
  }
  if (url.pathname === "/auth/v1/user" && options.method === undefined) {
    const identity = tokens.get(bearer);
    return identity
      ? jsonResponse({ id: identity.id, email: identity.email, app_metadata: { ...identity.app_metadata } })
      : jsonResponse({ error: "unauthorized" }, 401);
  }
  if (url.pathname === "/auth/v1/admin/users" && options.method === "POST") {
    assert.equal(bearer, serviceRoleKey);
    userCreateCalls += 1;
    const identity = {
      id: randomUUID(),
      email: body.email,
      password: body.password,
      app_metadata: { ...body.app_metadata },
    };
    identities.set(identity.id, identity);
    return jsonResponse(identity);
  }
  const updateUser = /^\/auth\/v1\/admin\/users\/([0-9a-f-]+)$/.exec(url.pathname);
  if (updateUser && options.method === "PUT") {
    assert.equal(bearer, serviceRoleKey);
    const identity = identities.get(updateUser[1]);
    if (!identity) return jsonResponse({ error: "not_found" }, 404);
    identity.password = body.password;
    for (const [key, value] of Object.entries(body.app_metadata ?? {})) {
      if (value === null) delete identity.app_metadata[key];
      else identity.app_metadata[key] = value;
    }
    return jsonResponse(identity);
  }
  if (url.pathname === "/rest/v1/rpc/authorize_company_identity_creation") {
    assert.ok(tokens.has(bearer));
    return jsonResponse(true);
  }
  if (url.pathname === "/rest/v1/rpc/manage_company_membership") {
    assert.ok(tokens.has(bearer));
    return jsonResponse({
      membership_id: randomUUID(),
      user_id: body.p_user_id,
      status: "invited",
    });
  }
  if (updateUser && options.method === "DELETE") {
    assert.equal(bearer, serviceRoleKey);
    identities.delete(updateUser[1]);
    return new Response(null, { status: 204 });
  }
  return jsonResponse({ error: `unexpected ${options.method ?? "GET"} ${url.pathname}` }, 500);
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
