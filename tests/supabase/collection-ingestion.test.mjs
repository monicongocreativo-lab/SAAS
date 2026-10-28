import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createAuthPrototypeServer } from "../../src/auth-prototype/server.mjs";
import { readLocalSupabaseEnvironment } from "../../src/auth-prototype/local-supabase-environment.mjs";

const appOrigin = "http://127.0.0.1:8765";
if (process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST !== "1")
  throw new Error(
    "Set TAMAGO_ALLOW_LOCAL_SUPABASE_TEST=1 to confirm this test is intentional.",
  );
const local = validateLocalSupabaseEnvironment(readLocalSupabaseEnvironment());
const directory = mkdtempSync(join(tmpdir(), "tamago-collection-ingest-"));
const encryptionKey = randomBytes(32);
const createdUsers = [];
const createdMemberships = [];
let companyId;
let foreignCompanyId;
let siteId;
let otherSiteId;
let houseId;
let otherHouseId;
let lotId;
let otherLotId;
let server;
let baseUrl;
let captureUser;
let otherScopeUser;

before(async () => {
  companyId = randomUUID();
  foreignCompanyId = randomUUID();
  siteId = randomUUID();
  otherSiteId = randomUUID();
  houseId = randomUUID();
  otherHouseId = randomUUID();
  lotId = randomUUID();
  otherLotId = randomUUID();
  captureUser = await createUser("capture");
  otherScopeUser = await createUser("other-scope");
  const company = await adminFetch("/rest/v1/companies", {
    method: "POST",
    body: { id: companyId, code: `TEST-COLLECTION-${randomUUID().slice(0, 8).toUpperCase()}`, legal_name: "Empresa ficticia de recogidas" },
    prefer: "return=minimal",
  });
  assert.equal(company.status, 201, await company.text());
  const foreignCompany = await adminFetch("/rest/v1/companies", {
    method: "POST",
    body: { id: foreignCompanyId, code: `TEST-FOREIGN-${randomUUID().slice(0, 8).toUpperCase()}`, legal_name: "Empresa ficticia ajena" },
    prefer: "return=minimal",
  });
  assert.equal(foreignCompany.status, 201, await foreignCompany.text());
  await createSite(siteId, "SITE-A");
  await createSite(otherSiteId, "SITE-B");
  const house = await adminFetch("/rest/v1/houses", {
    method: "POST",
    body: { id: houseId, company_id: companyId, site_id: siteId, code: "HOUSE-A", name: "Galpón ficticio A" },
    prefer: "return=minimal",
  });
  assert.equal(house.status, 201);
  const otherHouse = await adminFetch("/rest/v1/houses", {
    method: "POST",
    body: { id: otherHouseId, company_id: companyId, site_id: otherSiteId, code: "HOUSE-B", name: "Galpón ficticio B" },
    prefer: "return=minimal",
  });
  assert.equal(otherHouse.status, 201);
  const lot = await adminFetch("/rest/v1/lots", {
    method: "POST",
    body: { id: lotId, company_id: companyId, site_id: siteId, house_id: houseId, code: "LOT-A", status: "active" },
    prefer: "return=minimal",
  });
  assert.equal(lot.status, 201);
  const otherLot = await adminFetch("/rest/v1/lots", {
    method: "POST",
    body: { id: otherLotId, company_id: companyId, site_id: otherSiteId, house_id: otherHouseId, code: "LOT-B", status: "active" },
    prefer: "return=minimal",
  });
  assert.equal(otherLot.status, 201);
  const captureMembership = await createMembership(captureUser.id);
  const otherMembership = await createMembership(otherScopeUser.id);
  await createRole(captureMembership, siteId, houseId, lotId);
  await createRole(otherMembership, otherSiteId, null, null);

  server = createAuthPrototypeServer({
    apiUrl: local.API_URL,
    restUrl: local.REST_URL,
    publishableKey: local.PUBLISHABLE_KEY ?? local.ANON_KEY,
    serviceRoleKey: local.SERVICE_ROLE_KEY,
    allowedOrigins: [appOrigin],
    sessionDbPath: join(directory, "sessions.sqlite"),
    sessionEncryptionKey: encryptionKey,
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (companyId) {
    await adminFetch(`/rest/v1/collection_events?company_id=eq.${companyId}`, { method: "DELETE" });
    for (const membershipId of createdMemberships) {
      await adminFetch(`/rest/v1/role_assignments?membership_id=eq.${membershipId}`, { method: "DELETE" });
      await adminFetch(`/rest/v1/company_memberships?id=eq.${membershipId}`, { method: "DELETE" });
    }
    if (lotId) await adminFetch(`/rest/v1/lots?id=eq.${lotId}`, { method: "DELETE" });
    if (otherLotId) await adminFetch(`/rest/v1/lots?id=eq.${otherLotId}`, { method: "DELETE" });
    for (const id of [houseId, otherHouseId])
      if (id) await adminFetch(`/rest/v1/houses?id=eq.${id}`, { method: "DELETE" });
    for (const id of [siteId, otherSiteId])
      if (id) await adminFetch(`/rest/v1/sites?id=eq.${id}`, { method: "DELETE" });
    await adminFetch(`/rest/v1/companies?id=eq.${companyId}`, { method: "DELETE" });
    if (foreignCompanyId)
      await adminFetch(`/rest/v1/companies?id=eq.${foreignCompanyId}`, { method: "DELETE" });
  }
  for (const userId of createdUsers)
    await adminFetch(`/auth/v1/admin/users/${userId}`, { method: "DELETE" });
  if (server?.listening) {
    server.close();
    await once(server, "close");
  }
  encryptionKey.fill(0);
  rmSync(directory, { recursive: true, force: true });
});

test("authenticated receipt is tenant/scope checked and retry-safe", async () => {
  const url = `${baseUrl}/v1/companies/${companyId}/collection-events`;
  const event = eventBody();
  const anonymous = await post(url, event, null);
  assert.equal(anonymous.status, 401);

  const capture = await login(captureUser);
  const first = await post(url, event, capture.cookie);
  const receipt = await first.json();
  assert.equal(first.status, 200, JSON.stringify(receipt));
  assert.equal(receipt.receipt_status, "received");
  assert.equal(receipt.review_status, "pending");
  assert.equal(receipt.duplicate, false);

  const retry = await post(url, event, capture.cookie);
  const repeatedReceipt = await retry.json();
  assert.equal(retry.status, 200);
  assert.equal(repeatedReceipt.duplicate, true);
  assert.equal(repeatedReceipt.received_at, receipt.received_at);

  const changedIdContent = await post(url, { ...event, quantity_eggs: 301 }, capture.cookie);
  assert.equal(changedIdContent.status, 409);
  assert.equal((await changedIdContent.json()).error, "COLLECTION_EVENT_CONFLICT");

  const duplicateOccurrence = await post(url, { ...event, event_id: randomUUID() }, capture.cookie);
  assert.equal(duplicateOccurrence.status, 409);
  assert.equal((await duplicateOccurrence.json()).error, "COLLECTION_OCCURRENCE_CONFLICT");

  const outsider = await login(otherScopeUser);
  const forbidden = await post(url, { ...event, event_id: randomUUID(), occurrence: 2 }, outsider.cookie);
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error, "COLLECTION_CAPTURE_FORBIDDEN");

  const actorRows = await adminFetch(`/rest/v1/collection_events?event_id=eq.${event.event_id}&select=captured_by,actor_declared_id,review_status`);
  assert.equal(actorRows.status, 200);
  const [stored] = await actorRows.json();
  assert.equal(stored.captured_by, captureUser.id, "server identity is derived from the authenticated JWT");
  assert.equal(stored.actor_declared_id, event.actor_declared_id, "declared field actor is preserved separately");
  assert.equal(stored.review_status, "pending");
});

test("operational catalog returns only active resources visible to the authenticated scope", async () => {
  const capture = await login(captureUser);
  const own = await fetch(`${baseUrl}/v1/companies/${companyId}/operational-catalog`, {
    headers: { cookie: capture.cookie },
  });
  assert.equal(own.status, 200);
  const ownCatalog = await own.json();
  assert.deepEqual(ownCatalog.sites.map(({ id }) => id), [siteId]);
  assert.deepEqual(ownCatalog.houses.map(({ id }) => id), [houseId]);
  assert.deepEqual(ownCatalog.lots.map(({ id }) => id), [lotId]);

  const other = await login(otherScopeUser);
  const otherResponse = await fetch(`${baseUrl}/v1/companies/${companyId}/operational-catalog`, {
    headers: { cookie: other.cookie },
  });
  assert.equal(otherResponse.status, 200);
  const otherCatalog = await otherResponse.json();
  assert.deepEqual(otherCatalog.sites.map(({ id }) => id), [otherSiteId]);
  assert.deepEqual(otherCatalog.houses.map(({ id }) => id), [otherHouseId]);
  assert.deepEqual(otherCatalog.lots.map(({ id }) => id), [otherLotId]);

  const forbiddenCompany = await fetch(
    `${baseUrl}/v1/companies/${foreignCompanyId}/operational-catalog`,
    { headers: { cookie: capture.cookie } },
  );
  assert.equal(forbiddenCompany.status, 404);
});

test("collection endpoint rejects tenant mismatch, extra fields and wrong origin", async () => {
  const capture = await login(captureUser);
  const url = `${baseUrl}/v1/companies/${companyId}/collection-events`;
  const mismatch = await post(url, { ...eventBody(), company_id: randomUUID() }, capture.cookie);
  assert.equal(mismatch.status, 400);
  const extra = await post(url, { ...eventBody(), captured_by: captureUser.id }, capture.cookie);
  assert.equal(extra.status, 400);
  const wrongOrigin = await fetch(url, {
    method: "POST",
    headers: { origin: "https://attacker.invalid", cookie: capture.cookie, "content-type": "application/json" },
    body: JSON.stringify(eventBody()),
  });
  assert.equal(wrongOrigin.status, 403);
});

function eventBody() {
  const now = new Date();
  const businessDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const timestamp = now.toISOString();
  return {
    schema_version: 2,
    event_id: randomUUID(),
    company_id: companyId,
    site_id: siteId,
    house_id: houseId,
    lot_id: lotId,
    business_date: businessDate,
    occurrence: 1,
    quantity_eggs: 300,
    occurred_at: timestamp,
    captured_at: timestamp,
    actor_declared_id: "galponero-dispositivo-sintetico",
    device_id: randomUUID(),
  };
}

async function createUser(label) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = `synthetic-${randomUUID()}-Password!`;
  const response = await adminFetch("/auth/v1/admin/users", {
    method: "POST",
    body: { email, password, email_confirm: true },
  });
  const user = await response.json();
  assert.equal(response.status, 200);
  createdUsers.push(user.id);
  return { id: user.id, email, password };
}

async function createSite(id, code) {
  const response = await adminFetch("/rest/v1/sites", {
    method: "POST",
    body: { id, company_id: companyId, code, name: `Sede ficticia ${code}` },
    prefer: "return=minimal",
  });
  assert.equal(response.status, 201);
}

async function createMembership(userId) {
  const response = await adminFetch("/rest/v1/company_memberships", {
    method: "POST",
    body: { company_id: companyId, user_id: userId, status: "active" },
    prefer: "return=representation",
  });
  assert.equal(response.status, 201);
  const [membership] = await response.json();
  createdMemberships.push(membership.id);
  return membership;
}

async function createRole(membership, site, house, lot) {
  const response = await adminFetch("/rest/v1/role_assignments", {
    method: "POST",
    body: {
      company_id: companyId,
      membership_id: membership.id,
      role_key: "capture",
      site_id: site,
      house_id: house,
      lot_id: lot,
    },
    prefer: "return=minimal",
  });
  assert.equal(response.status, 201);
}

async function login(user) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { origin: appOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  assert.equal(response.status, 200);
  return { cookie: response.headers.get("set-cookie").split(";")[0] };
}

async function post(url, body, cookie) {
  return fetch(url, {
    method: "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      origin: appOrigin,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function adminFetch(path, { method = "GET", body, prefer } = {}) {
  const headers = {
    apikey: local.SERVICE_ROLE_KEY,
    authorization: `Bearer ${local.SERVICE_ROLE_KEY}`,
  };
  if (body) headers["content-type"] = "application/json";
  if (prefer) headers.prefer = prefer;
  return fetch(new URL(path, local.API_URL), {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function validateLocalSupabaseEnvironment(env) {
  for (const key of ["API_URL", "REST_URL", "PUBLISHABLE_KEY", "SERVICE_ROLE_KEY"])
    if (!env[key]) throw new Error(`Missing local Supabase value: ${key}`);
  return env;
}
