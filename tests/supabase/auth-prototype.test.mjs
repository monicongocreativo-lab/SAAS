import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { readLocalSupabaseEnvironment } from "../../src/auth-prototype/local-supabase-environment.mjs";
import { createAuthPrototypeServer } from "../../src/auth-prototype/server.mjs";

const APP_ORIGIN = "http://127.0.0.1:8765";
if (process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST !== "1")
  throw new Error(
    "Set TAMAGO_ALLOW_LOCAL_SUPABASE_TEST=1 to confirm this test is intentional.",
  );
const localEnv = validateLocalSupabaseEnvironment(
  readLocalSupabaseEnvironment(),
);
const createdUsers = [];
const createdCompanies = [];
const createdMemberships = [];
const sessionDirectory = mkdtempSync(join(tmpdir(), "tamago-auth-p03-"));
const sessionDbPath = join(sessionDirectory, "sessions.sqlite");
const sessionEncryptionKey = randomBytes(32);
let testNow = Date.now();
let server = createAuthServer();
let gatewayUrl;

before(async () => {
  await startServer();
});

after(async () => {
  await cleanupFixtures();
  await stopServer();
  sessionEncryptionKey.fill(0);
  rmSync(sessionDirectory, { recursive: true, force: true });
});

test("Supabase Auth sessions are cookie-backed and RLS prevents cross-company reads", async () => {
  const tamagoUser = await createLocalUser();
  const tamagoAdmin = await createLocalUser();
  const invitedUser = await createLocalUser();
  const paulinaUser = await createLocalUser();
  const tamagoCompany = await createLocalCompany("TAMAGO");
  const paulinaCompany = await createLocalCompany("PAULINA");
  const tamagoMembership = await createMembership(
    tamagoCompany.id,
    tamagoUser.id,
  );
  const tamagoAdminMembership = await createMembership(
    tamagoCompany.id,
    tamagoAdmin.id,
  );
  const paulinaMembership = await createMembership(
    paulinaCompany.id,
    paulinaUser.id,
  );
  await createRoleAssignment(tamagoCompany.id, tamagoMembership.id, "capture");
  await createRoleAssignment(
    tamagoCompany.id,
    tamagoAdminMembership.id,
    "admin",
  );
  await createRoleAssignment(
    paulinaCompany.id,
    paulinaMembership.id,
    "director",
  );

  const anonymousResponse = await fetch(`${gatewayUrl}/v1/companies`);
  assert.equal(anonymousResponse.status, 401);

  const rejectedOrigin = await fetch(`${gatewayUrl}/v1/auth/login`, {
    method: "POST",
    headers: {
      origin: "https://attacker.invalid",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      email: tamagoUser.email,
      password: tamagoUser.password,
    }),
  });
  assert.equal(rejectedOrigin.status, 403);

  const wrongPassword = await fetch(`${gatewayUrl}/v1/auth/login`, {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({
      email: tamagoUser.email,
      password: "wrong-password",
    }),
  });
  assert.equal(wrongPassword.status, 401);

  const wrongMediaType = await fetch(`${gatewayUrl}/v1/auth/login`, {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
    body: "email=user@example.invalid&password=not-used",
  });
  assert.equal(wrongMediaType.status, 415);

  const tamagoLogin = await login(tamagoUser);
  assert.equal(tamagoLogin.response.status, 200);
  assert.match(tamagoLogin.setCookie, /HttpOnly/);
  assert.match(tamagoLogin.setCookie, /Secure/);
  assert.match(tamagoLogin.setCookie, /SameSite=Lax/);
  const confirmationUrl = `${gatewayUrl}/v1/auth/confirm-password`;
  const rejectedConfirmation = await mutateJson(
    confirmationUrl,
    tamagoLogin.cookie,
    { method: "POST", body: { password: "incorrect-confirmation" } },
  );
  assert.equal(rejectedConfirmation.response.status, 401);
  const confirmed = await mutateJson(confirmationUrl, tamagoLogin.cookie, {
    method: "POST",
    body: { password: tamagoUser.password },
  });
  assert.equal(confirmed.response.status, 200);
  assert.deepEqual(confirmed.body, {
    user_id: tamagoUser.id,
    password_confirmed: true,
  });
  assert.equal(
    (await json(`${gatewayUrl}/v1/auth/me`, tamagoLogin.cookie)).user_id,
    tamagoUser.id,
  );

  const persistedDb = readFileSync(sessionDbPath);
  assert.equal(
    persistedDb.includes(Buffer.from(tamagoLogin.cookie.split("=")[1])),
    false,
  );
  await stopServer();
  server = createAuthServer();
  await startServer();
  const sessionDb = new DatabaseSync(sessionDbPath);
  sessionDb
    .prepare("UPDATE auth_sessions SET access_expires_at = ?")
    .run(testNow + 500);
  sessionDb.close();
  testNow += 1_000;
  assert.equal(
    (await json(`${gatewayUrl}/v1/auth/me`, tamagoLogin.cookie)).user_id,
    tamagoUser.id,
    "the opaque browser session survives restart and refreshes provider tokens",
  );
  await stopServer();
  server = createAuthServer();
  await startServer();
  assert.equal(
    (await json(`${gatewayUrl}/v1/auth/me`, tamagoLogin.cookie)).user_id,
    tamagoUser.id,
    "rotated tokens were durably saved before a second restart",
  );

  const tamagoCompanies = await json(
    `${gatewayUrl}/v1/companies`,
    tamagoLogin.cookie,
  );
  assert.deepEqual(
    tamagoCompanies.map((company) => company.code),
    [tamagoCompany.code],
  );
  const foreignCompanyResponse = await fetch(
    `${gatewayUrl}/v1/companies/${paulinaCompany.id}`,
    { headers: { cookie: tamagoLogin.cookie } },
  );
  assert.equal(foreignCompanyResponse.status, 404);

  const adminLogin = await login(tamagoAdmin);
  const membershipUrl = `${gatewayUrl}/v1/companies/${tamagoCompany.id}/memberships`;
  const invited = await mutateJson(membershipUrl, adminLogin.cookie, {
    method: "POST",
    body: { user_id: invitedUser.id, role_key: "warehouse" },
  });
  assert.equal(invited.response.status, 200);
  assert.equal(invited.body.status, "invited");
  assert.equal(invited.body.role_key, "warehouse");
  createdMemberships.push(invited.body.membership_id);

  const visibleMembers = await json(membershipUrl, adminLogin.cookie);
  assert.equal(visibleMembers.length, 3);
  assert.equal(
    visibleMembers.find(
      (membership) => membership.id === invited.body.membership_id,
    ).roles[0].role_key,
    "warehouse",
  );

  const assignedRole = await mutateJson(
    `${membershipUrl}/${invited.body.membership_id}`,
    adminLogin.cookie,
    { method: "PATCH", body: { action: "assign_role", role_key: "transport" } },
  );
  assert.equal(assignedRole.response.status, 200);
  const revokedRole = await mutateJson(
    `${membershipUrl}/${invited.body.membership_id}`,
    adminLogin.cookie,
    { method: "PATCH", body: { action: "revoke_role", role_key: "transport" } },
  );
  assert.equal(revokedRole.response.status, 200);

  const captureInvite = await mutateJson(membershipUrl, tamagoLogin.cookie, {
    method: "POST",
    body: { user_id: randomUUID(), role_key: "capture" },
  });
  assert.equal(captureInvite.response.status, 403);

  const selfElevation = await mutateJson(membershipUrl, adminLogin.cookie, {
    method: "POST",
    body: { user_id: tamagoAdmin.id, role_key: "director" },
  });
  assert.equal(selfElevation.response.status, 400);

  const invitedLogin = await login(invitedUser);
  const accepted = await mutateJson(
    `${membershipUrl}/${invited.body.membership_id}`,
    invitedLogin.cookie,
    { method: "PATCH", body: { action: "accept" } },
  );
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.status, "active");
  assert.deepEqual(
    (await json(`${gatewayUrl}/v1/companies`, invitedLogin.cookie)).map(
      (company) => company.id,
    ),
    [tamagoCompany.id],
  );

  const suspended = await mutateJson(
    `${membershipUrl}/${invited.body.membership_id}`,
    adminLogin.cookie,
    { method: "PATCH", body: { action: "suspend" } },
  );
  assert.equal(suspended.response.status, 200);
  assert.equal(suspended.body.status, "suspended");
  assert.deepEqual(
    await json(`${gatewayUrl}/v1/companies`, invitedLogin.cookie),
    [],
  );

  const reactivated = await mutateJson(
    `${membershipUrl}/${invited.body.membership_id}`,
    adminLogin.cookie,
    { method: "PATCH", body: { action: "reactivate" } },
  );
  assert.equal(reactivated.response.status, 200);
  assert.equal(reactivated.body.status, "active");
  assert.deepEqual(
    (await json(`${gatewayUrl}/v1/companies`, invitedLogin.cookie)).map(
      (company) => company.id,
    ),
    [tamagoCompany.id],
  );

  const reactivatedRoleAssignment = await mutateJson(
    `${membershipUrl}/${invited.body.membership_id}`,
    adminLogin.cookie,
    { method: "PATCH", body: { action: "assign_role", role_key: "billing" } },
  );
  assert.equal(reactivatedRoleAssignment.response.status, 200);
  const revokedMembership = await mutateJson(
    `${membershipUrl}/${invited.body.membership_id}`,
    adminLogin.cookie,
    { method: "PATCH", body: { action: "revoke" } },
  );
  assert.equal(revokedMembership.response.status, 200);
  assert.equal(revokedMembership.body.status, "revoked");
  assert.deepEqual(
    await json(`${gatewayUrl}/v1/companies`, invitedLogin.cookie),
    [],
  );

  const revokeResponse = await adminFetch(
    `/rest/v1/company_memberships?id=eq.${tamagoMembership.id}`,
    {
      method: "PATCH",
      body: { status: "revoked", revoked_at: new Date().toISOString() },
      prefer: "return=minimal",
    },
  );
  assert.equal(revokeResponse.status, 204);
  assert.equal(
    (await json(`${gatewayUrl}/v1/auth/me`, tamagoLogin.cookie)).user_id,
    tamagoUser.id,
  );
  assert.deepEqual(
    await json(`${gatewayUrl}/v1/companies`, tamagoLogin.cookie),
    [],
  );

  const paulinaLogin = await login(paulinaUser);
  const paulinaCompanies = await json(
    `${gatewayUrl}/v1/companies`,
    paulinaLogin.cookie,
  );
  assert.deepEqual(
    paulinaCompanies.map((company) => company.code),
    [paulinaCompany.code],
  );

  const tamperedCookie = tamagoLogin.cookie.replace(/.$/, "x");
  const tamperedResponse = await fetch(`${gatewayUrl}/v1/auth/me`, {
    headers: { cookie: tamperedCookie },
  });
  assert.equal(tamperedResponse.status, 401);

  const malformedCookieResponse = await fetch(`${gatewayUrl}/v1/auth/me`, {
    headers: { cookie: "__Host-tamago_dev_session=%" },
  });
  assert.equal(malformedCookieResponse.status, 401);

  const provisionEmail = `provision-${randomUUID()}@example.invalid`;
  const provisioningId = randomUUID();
  const provisionUrl = `${gatewayUrl}/v1/companies/${tamagoCompany.id}/identities`;
  const provisioned = await mutateProvisioning(
    provisionUrl,
    adminLogin.cookie,
    provisioningId,
    {
      email: provisionEmail,
      role_key: "capture",
    },
  );
  assert.equal(provisioned.response.status, 201);
  assert.equal(provisioned.body.credential_recoverable, true);
  assert.equal(provisioned.body.email_confirmed_by_prototype, true);
  assert.equal(typeof provisioned.body.temporary_password, "string");
  assert.ok(provisioned.body.temporary_password.length >= 32);
  createdUsers.push(provisioned.body.user_id);
  createdMemberships.push(provisioned.body.membership_id);

  const replayedProvision = await mutateProvisioning(
    provisionUrl,
    adminLogin.cookie,
    provisioningId,
    {
      email: provisionEmail,
      role_key: "capture",
    },
  );
  assert.equal(replayedProvision.response.status, 200);
  assert.equal(replayedProvision.body.user_id, provisioned.body.user_id);
  assert.equal(
    replayedProvision.body.temporary_password,
    provisioned.body.temporary_password,
  );

  const temporaryLogin = await login({
    email: provisionEmail,
    password: provisioned.body.temporary_password,
  });
  assert.equal(temporaryLogin.response.status, 200);
  assert.equal(
    (await temporaryLogin.response.json()).password_change_required,
    true,
  );
  assert.equal(
    (
      await fetch(`${gatewayUrl}/v1/companies`, {
        headers: { cookie: temporaryLogin.cookie },
      })
    ).status,
    403,
  );
  const samePassword = await mutateJson(
    `${gatewayUrl}/v1/auth/change-initial-password`,
    temporaryLogin.cookie,
    {
      method: "POST",
      body: { new_password: provisioned.body.temporary_password },
    },
  );
  assert.equal(samePassword.response.status, 400);
  const changedPassword = randomBytes(32).toString("base64url");
  const changed = await mutateJson(
    `${gatewayUrl}/v1/auth/change-initial-password`,
    temporaryLogin.cookie,
    {
      method: "POST",
      body: { new_password: changedPassword },
    },
  );
  assert.equal(changed.response.status, 200);
  const changedAuthUserResponse = await adminFetch(
    `/auth/v1/admin/users/${provisioned.body.user_id}`,
  );
  const changedAuthUser = await changedAuthUserResponse.json();
  assert.equal(
    changedAuthUser.app_metadata?.tamago_initial_access_state,
    undefined,
    "the Auth provider must clear the initial-access marker in its durable user record",
  );
  assert.equal(
    (await json(`${gatewayUrl}/v1/auth/me`, temporaryLogin.cookie))
      .password_change_required,
    false,
  );
  const permanentLogin = await login({
    email: provisionEmail,
    password: changedPassword,
  });
  assert.equal(permanentLogin.response.status, 200);
  assert.equal(
    (await permanentLogin.response.json()).password_change_required,
    false,
  );

  const acknowledged = await mutateJson(
    `${gatewayUrl}/v1/companies/${tamagoCompany.id}/identities/provisionings/${provisioningId}/acknowledge`,
    adminLogin.cookie,
    { method: "POST", body: {} },
  );
  assert.equal(acknowledged.response.status, 200);
  assert.equal(acknowledged.body.credential_discarded, true);
  const afterAcknowledgement = await mutateProvisioning(
    provisionUrl,
    adminLogin.cookie,
    provisioningId,
    {
      email: provisionEmail,
      role_key: "capture",
    },
  );
  assert.equal(afterAcknowledgement.response.status, 200);
  assert.equal(afterAcknowledgement.body.credential_recoverable, false);
  assert.equal("temporary_password" in afterAcknowledgement.body, false);

  const directorProvisioning = await mutateProvisioning(
    provisionUrl,
    adminLogin.cookie,
    randomUUID(),
    {
      email: `director-${randomUUID()}@example.invalid`,
      role_key: "director",
    },
  );
  assert.equal(directorProvisioning.response.status, 400);

  const logoutResponse = await fetch(`${gatewayUrl}/v1/auth/logout`, {
    method: "POST",
    headers: { origin: APP_ORIGIN, cookie: tamagoLogin.cookie },
  });
  assert.equal(logoutResponse.status, 204);
  const afterLogout = await fetch(`${gatewayUrl}/v1/auth/me`, {
    headers: { cookie: tamagoLogin.cookie },
  });
  assert.equal(afterLogout.status, 401);
});

async function login(user) {
  const response = await fetch(`${gatewayUrl}/v1/auth/login`, {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const setCookie = response.headers.get("set-cookie") ?? "";
  return { response, setCookie, cookie: setCookie.split(";")[0] };
}

function createAuthServer() {
  return createAuthPrototypeServer({
    apiUrl: localEnv.API_URL,
    restUrl: localEnv.REST_URL,
    publishableKey: localEnv.PUBLISHABLE_KEY ?? localEnv.ANON_KEY,
    serviceRoleKey: localEnv.SERVICE_ROLE_KEY,
    allowedOrigins: [APP_ORIGIN],
    sessionDbPath,
    sessionEncryptionKey,
    now: () => testNow,
  });
}

async function startServer() {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  gatewayUrl = `http://127.0.0.1:${server.address().port}`;
}

async function stopServer() {
  if (!server?.listening) return;
  server.close();
  await once(server, "close").catch(() => {});
}

async function mutateJson(url, cookie, { method, body }) {
  const response = await fetch(url, {
    method,
    headers: {
      origin: APP_ORIGIN,
      cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => null) };
}

async function mutateProvisioning(url, cookie, idempotencyKey, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      origin: APP_ORIGIN,
      cookie,
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  return { response, body: await response.json().catch(() => null) };
}

async function json(url, cookie) {
  const response = await fetch(url, { headers: { cookie } });
  assert.equal(
    response.status,
    200,
    `Expected 200 from ${new URL(url).pathname}`,
  );
  return response.json();
}

async function createLocalUser() {
  const email = `test-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  const response = await adminFetch("/auth/v1/admin/users", {
    method: "POST",
    body: { email, password, email_confirm: true },
  });
  const user = await response.json();
  assert.equal(
    response.status,
    200,
    "Local Auth admin must create a synthetic user",
  );
  createdUsers.push(user.id);
  return { id: user.id, email, password };
}

async function createLocalCompany(label) {
  const code = `TEST-${label}-${randomUUID().slice(0, 8).toUpperCase()}`;
  const response = await adminFetch("/rest/v1/companies", {
    method: "POST",
    body: { code, legal_name: `Empresa ficticia ${label}` },
    prefer: "return=representation",
  });
  assert.equal(
    response.status,
    201,
    "Local admin fixture must create a synthetic company",
  );
  const [company] = await response.json();
  createdCompanies.push(company.id);
  return { id: company.id, code };
}

async function createMembership(companyId, userId) {
  const response = await adminFetch("/rest/v1/company_memberships", {
    method: "POST",
    body: { company_id: companyId, user_id: userId, status: "active" },
    prefer: "return=representation",
  });
  assert.equal(
    response.status,
    201,
    "Local admin fixture must create a synthetic membership",
  );
  const [membership] = await response.json();
  createdMemberships.push(membership.id);
  return membership;
}

async function createRoleAssignment(companyId, membershipId, roleKey) {
  const response = await adminFetch("/rest/v1/role_assignments", {
    method: "POST",
    body: {
      company_id: companyId,
      membership_id: membershipId,
      role_key: roleKey,
    },
    prefer: "return=minimal",
  });
  assert.equal(
    response.status,
    201,
    "Local admin fixture must create a synthetic role",
  );
}

async function adminFetch(path, { method, body, prefer } = {}) {
  const headers = {
    apikey: localEnv.SERVICE_ROLE_KEY,
    authorization: `Bearer ${localEnv.SERVICE_ROLE_KEY}`,
  };
  if (body) headers["content-type"] = "application/json";
  if (prefer) headers.prefer = prefer;
  return fetch(new URL(path, localEnv.API_URL), {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function cleanupFixtures() {
  for (const membershipId of createdMemberships) {
    await adminFetch(
      `/rest/v1/role_assignments?membership_id=eq.${membershipId}`,
      { method: "DELETE" },
    );
    await adminFetch(`/rest/v1/company_memberships?id=eq.${membershipId}`, {
      method: "DELETE",
    });
  }
  for (const companyId of createdCompanies)
    await adminFetch(`/rest/v1/companies?id=eq.${companyId}`, {
      method: "DELETE",
    });
  for (const userId of createdUsers)
    await adminFetch(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
}

function validateLocalSupabaseEnvironment(environment) {
  for (const key of [
    "REST_URL",
    "PUBLISHABLE_KEY",
    "ANON_KEY",
    "SERVICE_ROLE_KEY",
  ])
    if (!environment[key])
      throw new Error(`Missing local Supabase status value: ${key}`);
  return environment;
}
