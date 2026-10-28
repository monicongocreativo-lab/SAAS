import { assertCollectionReceipt } from "../../src/offline/collection-receipt.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAuthPrototypeServer } from "../../src/auth-prototype/server.mjs";
import { readLocalSupabaseEnvironment } from "../../src/auth-prototype/local-supabase-environment.mjs";
import {
  createOfflineDeviceEventProof,
  generateOfflineDeviceKeyPair,
} from "../../src/offline/device-event-proof.mjs";
import { verifyOfflineGrant } from "../../src/offline/identity-grant.mjs";

const APP_ORIGIN = "http://127.0.0.1:8765";
if (process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST !== "1")
  throw new Error(
    "Set TAMAGO_ALLOW_LOCAL_SUPABASE_TEST=1 to confirm this test is intentional.",
  );

const local = validateLocalSupabaseEnvironment(readLocalSupabaseEnvironment());
const fixture = {
  companyId: randomUUID(),
  siteId: randomUUID(),
  houseId: randomUUID(),
  lotId: randomUUID(),
  deviceId: randomUUID(),
  captureUser: null,
  warehouseUser: null,
  outsiderUser: null,
  captureMembershipId: null,
  warehouseMembershipId: null,
  grantId: null,
  receivedEventId: randomUUID(),
  quarantinedEventId: randomUUID(),
};
const sessionDirectory = mkdtempSync(join(tmpdir(), "tamago-offline-receipt-"));
const encryptionKey = randomBytes(32);
const issuerKeys = await generateKeyPair("ES256", { extractable: false });
const issuerPublicJwk = await exportJWK(issuerKeys.publicKey);
const deviceKeys = await generateOfflineDeviceKeyPair();
const signerId = `offline-integration-${randomUUID().slice(0, 8)}`;
const server = createAuthPrototypeServer({
  apiUrl: local.API_URL,
  restUrl: local.REST_URL,
  publishableKey: local.PUBLISHABLE_KEY ?? local.ANON_KEY,
  serviceRoleKey: local.SERVICE_ROLE_KEY,
  allowedOrigins: [APP_ORIGIN],
  sessionDbPath: join(sessionDirectory, "sessions.sqlite"),
  sessionEncryptionKey: encryptionKey,
  offlineGrantSigningKey: issuerKeys.privateKey,
  offlineGrantKeyId: signerId,
  offlineGrantPublicJwk: issuerPublicJwk,
});
let baseUrl;

before(async () => {
  fixture.captureUser = await createUser("capture");
  fixture.warehouseUser = await createUser("warehouse");
  fixture.outsiderUser = await createUser("outsider");
  await createFixtures();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server.listening) {
    server.close();
    await once(server, "close");
  }
  try {
    cleanupFixturesWithLocalDatabase();
    for (const user of [fixture.captureUser, fixture.warehouseUser, fixture.outsiderUser])
      if (user) await deleteFixtureUser(user.id);
  } finally {
    encryptionKey.fill(0);
    rmSync(sessionDirectory, { recursive: true, force: true });
  }
});

test("grant real, captura firmada y recepción por Bodega persisten en Postgres local", async () => {
  const capture = await login(fixture.captureUser);
  const warehouse = await login(fixture.warehouseUser);
  const warehouseAccessToken = await supabaseAccessToken(fixture.warehouseUser);
  const deviceRegistration = {
    request_id: randomUUID(),
    device_id: fixture.deviceId,
    site_id: fixture.siteId,
    house_id: fixture.houseId,
    lot_id: fixture.lotId,
  };
  const deviceJwk = await exportJWK(deviceKeys.publicKey);
  const registrationProof = await new SignJWT({
    company_id: fixture.companyId,
    device_id: fixture.deviceId,
    site_id: fixture.siteId,
    house_id: fixture.houseId,
    lot_id: fixture.lotId,
    permission: "collection.capture",
  })
    .setProtectedHeader({
      alg: "ES256",
      typ: "tamago-device-registration+jwt",
      jwk: deviceJwk,
    })
    .setSubject(fixture.captureUser.id)
    .setJti(deviceRegistration.request_id)
    .setIssuedAt()
    .sign(deviceKeys.privateKey);

  const grantResponse = await postJson(
    `${baseUrl}/v1/companies/${fixture.companyId}/offline-capture-grants`,
    { ...deviceRegistration, proof: { jws: registrationProof } },
    capture.cookie,
  );
  assert.equal(grantResponse.status, 201, JSON.stringify(grantResponse.body));
  fixture.grantId = grantResponse.body.grant_id;
  assert.equal(grantResponse.body.delivery_status, "not_received");
  const verifiedGrant = await verifyOfflineGrant(grantResponse.body.token, {
    publicKey: issuerKeys.publicKey,
    expected: {
      sub: fixture.captureUser.id,
      company_id: fixture.companyId,
      device_id: fixture.deviceId,
      site_id: fixture.siteId,
      house_id: fixture.houseId,
      lot_id: fixture.lotId,
      permission: "collection.capture",
      device_key_thumbprint: deviceKeys.thumbprint,
    },
  });
  assert.equal(verifiedGrant.signature_verified, true);

  const event = createEvent(fixture.receivedEventId, 1);
  const proof = await createOfflineDeviceEventProof(
    event,
    { ...verifiedGrant, grant_id: fixture.grantId, subject_user_id: fixture.captureUser.id },
    deviceKeys,
  );
  const bundle = createBundle(event, fixture.grantId, fixture.captureUser.id, proof);
  const receiveUrl = `${baseUrl}/v1/companies/${fixture.companyId}/offline-collection-events`;
  const first = await postJson(receiveUrl, bundle, warehouse.cookie);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await assertCollectionReceipt(first.body, bundle.records[0], fixture.warehouseUser.id);
  assert.equal(first.body.identity_status, "verified");
  assert.equal(first.body.review_status, "pending");
  assert.equal(first.body.synchronization_user_id, fixture.warehouseUser.id);
  assert.equal(first.body.capture_subject_id, fixture.captureUser.id);
  assert.equal(first.body.duplicate, false);

  const retry = await postJson(receiveUrl, bundle, warehouse.cookie);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(retry.body.duplicate, true);
  assert.equal(retry.body.received_at, first.body.received_at);

  const storedEvents = await adminFetch(
    `/rest/v1/collection_events?event_id=eq.${fixture.receivedEventId}&select=event_id,captured_by,capture_subject_id,offline_grant_id,device_proof,review_status`,
  );
  assert.equal(storedEvents.status, 200);
  const [storedEvent] = await storedEvents.json();
  assert.equal(storedEvent.captured_by, fixture.warehouseUser.id);
  assert.equal(storedEvent.capture_subject_id, fixture.captureUser.id);
  assert.equal(storedEvent.offline_grant_id, fixture.grantId);
  assert.deepEqual(storedEvent.device_proof, proof);
  assert.equal(storedEvent.review_status, "pending");

  const invalidEvent = createEvent(fixture.quarantinedEventId, 2);
  const invalidProof = {
    ...proof,
    jws: (() => {
      const [header, payload, signature] = proof.jws.split(".");
      const corrupted = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      return `${header}.${payload}.${corrupted}`;
    })(),
  };
  const invalidBundle = createBundle(
    invalidEvent,
    fixture.grantId,
    fixture.captureUser.id,
    invalidProof,
  );
  const quarantined = await postJson(receiveUrl, invalidBundle, warehouse.cookie);
  assert.equal(quarantined.status, 202, JSON.stringify(quarantined.body));
  await assertCollectionReceipt(quarantined.body, invalidBundle.records[0], fixture.warehouseUser.id);
  assert.equal(quarantined.body.review_status, "review_required");
  assert.equal(quarantined.body.quarantine_reason, "proof_invalid");
  assert.equal(quarantined.body.proof_status, "invalid");

  const quarantineRetry = await postJson(receiveUrl, invalidBundle, warehouse.cookie);
  assert.equal(quarantineRetry.status, 202, JSON.stringify(quarantineRetry.body));
  assert.equal(quarantineRetry.body.duplicate, true);
  assert.equal(quarantineRetry.body.received_at, quarantined.body.received_at);

  const quarantineRows = await fetch(
    new URL(
      `/rest/v1/offline_collection_quarantine?event_id=eq.${fixture.quarantinedEventId}&select=event_payload,identity_binding,device_proof,received_by_user_id,review_status`,
      local.API_URL,
    ),
    {
      headers: {
        apikey: local.PUBLISHABLE_KEY ?? local.ANON_KEY,
        authorization: `Bearer ${warehouseAccessToken}`,
      },
    },
  );
  assert.equal(quarantineRows.status, 200);
  const [storedQuarantine] = await quarantineRows.json();
  assert.deepEqual(storedQuarantine.event_payload, invalidEvent);
  assert.deepEqual(storedQuarantine.identity_binding, invalidBundle.records[0].identity_binding);
  assert.deepEqual(storedQuarantine.device_proof, invalidProof);
  assert.equal(storedQuarantine.received_by_user_id, fixture.warehouseUser.id);
  assert.equal(storedQuarantine.review_status, "review_required");

  const outsider = await login(fixture.outsiderUser);
  const deniedSync = await postJson(receiveUrl, invalidBundle, outsider.cookie);
  assert.equal(deniedSync.status, 403);
  assert.equal(deniedSync.body.error, "OFFLINE_RECEIPT_FORBIDDEN");
  const outsiderAccessToken = await supabaseAccessToken(fixture.outsiderUser);
  const hiddenQuarantine = await fetch(
    new URL(
      `/rest/v1/offline_collection_quarantine?event_id=eq.${fixture.quarantinedEventId}&select=event_id`,
      local.API_URL,
    ),
    {
      headers: {
        apikey: local.PUBLISHABLE_KEY ?? local.ANON_KEY,
        authorization: `Bearer ${outsiderAccessToken}`,
      },
    },
  );
  assert.equal(hiddenQuarantine.status, 200);
  assert.deepEqual(await hiddenQuarantine.json(), []);
});

async function createFixtures() {
  await expectStatus(
    await adminFetch("/rest/v1/companies", {
      method: "POST",
      body: {
        id: fixture.companyId,
        code: `TEST-OFFLINE-${randomUUID().slice(0, 8).toUpperCase()}`,
        legal_name: "Empresa ficticia recepción offline",
      },
      prefer: "return=minimal",
    }),
    201,
  );
  await expectStatus(
    await adminFetch("/rest/v1/sites", {
      method: "POST",
      body: { id: fixture.siteId, company_id: fixture.companyId, code: "SITE-OFF", name: "Sede ficticia offline" },
      prefer: "return=minimal",
    }),
    201,
  );
  await expectStatus(
    await adminFetch("/rest/v1/houses", {
      method: "POST",
      body: {
        id: fixture.houseId,
        company_id: fixture.companyId,
        site_id: fixture.siteId,
        code: "HOUSE-OFF",
        name: "Galpón ficticio offline",
      },
      prefer: "return=minimal",
    }),
    201,
  );
  await expectStatus(
    await adminFetch("/rest/v1/lots", {
      method: "POST",
      body: {
        id: fixture.lotId,
        company_id: fixture.companyId,
        site_id: fixture.siteId,
        house_id: fixture.houseId,
        code: "LOT-OFF",
        status: "active",
      },
      prefer: "return=minimal",
    }),
    201,
  );
  fixture.captureMembershipId = await createMembership(fixture.captureUser.id);
  fixture.warehouseMembershipId = await createMembership(fixture.warehouseUser.id);
  await createRole(fixture.captureMembershipId, "capture");
  await createRole(fixture.warehouseMembershipId, "warehouse");
}

async function createUser(label) {
  const email = `${label}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = `synthetic-${randomUUID()}-Password!`;
  const response = await adminFetch("/auth/v1/admin/users", {
    method: "POST",
    body: { email, password, email_confirm: true },
  });
  const user = await response.json();
  assert.equal(response.status, 200, JSON.stringify(user));
  return { id: user.id, email, password };
}

async function createMembership(userId) {
  const response = await adminFetch("/rest/v1/company_memberships", {
    method: "POST",
    body: { company_id: fixture.companyId, user_id: userId, status: "active" },
    prefer: "return=representation",
  });
  const body = await response.text();
  assert.equal(response.status, 201, body);
  const [membership] = JSON.parse(body);
  return membership.id;
}

async function createRole(membershipId, role) {
  await expectStatus(
    await adminFetch("/rest/v1/role_assignments", {
      method: "POST",
      body: {
        company_id: fixture.companyId,
        membership_id: membershipId,
        role_key: role,
        site_id: fixture.siteId,
        house_id: fixture.houseId,
        lot_id: fixture.lotId,
      },
      prefer: "return=minimal",
    }),
    201,
  );
}

async function login(user) {
  const response = await fetch(`${baseUrl}/v1/auth/login`, {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  assert.equal(response.status, 200, await response.text());
  return { cookie: response.headers.get("set-cookie").split(";")[0] };
}

async function supabaseAccessToken(user) {
  const response = await fetch(`${local.API_URL}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: {
      apikey: local.PUBLISHABLE_KEY ?? local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  const session = await response.json();
  assert.equal(response.status, 200, JSON.stringify(session));
  return session.access_token;
}

async function postJson(url, body, cookie) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      origin: APP_ORIGIN,
      cookie,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function createEvent(eventId, occurrence) {
  const now = new Date();
  const businessDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const timestamp = now.toISOString();
  return {
    schema_version: 2,
    event_id: eventId,
    company_id: fixture.companyId,
    site_id: fixture.siteId,
    house_id: fixture.houseId,
    lot_id: fixture.lotId,
    business_date: businessDate,
    occurrence,
    quantity_eggs: 300,
    occurred_at: timestamp,
    captured_at: timestamp,
    actor_declared_id: fixture.captureUser.id,
    device_id: fixture.deviceId,
  };
}

function createBundle(event, grantId, subjectId, deviceProof) {
  return {
    format: "tamago.offline-collection-bundle",
    schema_version: 1,
    records: [
      {
        event,
        identity_binding: {
          grant_id: grantId,
          subject_user_id: subjectId,
          attribution_status: "pending_server_verification",
        },
        device_proof: deviceProof,
        delivery: { status: "pending" },
      },
    ],
  };
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

async function deleteFixtureUser(userId) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await adminFetch(`/auth/v1/admin/users/${userId}`, {
        method: "DELETE",
      });
      if (response.ok || response.status === 404) return;
      throw new Error(`Fixture user cleanup failed: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError;
}

function cleanupFixturesWithLocalDatabase() {
  const uuid = (value) => {
    if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error("Invalid fixture UUID");
    return `'${value}'::uuid`;
  };
  const sql = `DO $$ BEGIN
    delete from public.offline_collection_quarantine where company_id = ${uuid(fixture.companyId)};
    delete from public.collection_events where company_id = ${uuid(fixture.companyId)};
    delete from public.offline_capture_grants where company_id = ${uuid(fixture.companyId)};
    delete from public.role_assignments where company_id = ${uuid(fixture.companyId)};
    delete from public.company_memberships where company_id = ${uuid(fixture.companyId)};
    delete from public.lots where company_id = ${uuid(fixture.companyId)};
    delete from public.houses where company_id = ${uuid(fixture.companyId)};
    delete from public.sites where company_id = ${uuid(fixture.companyId)};
    delete from public.companies where id = ${uuid(fixture.companyId)};
  END $$;`;
  execFileSync(
    "pnpm",
    ["--silent", "supabase", "db", "query", "--local", sql, "--output-format", "json"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SUPABASE_HOME:
          process.env.SUPABASE_HOME ?? "/private/tmp/tamago-dev007b-supabase-home",
        SUPABASE_TELEMETRY_DISABLED: "1",
        SUPABASE_NO_UPDATE_NOTIFIER: "1",
      },
      stdio: "pipe",
    },
  );
}

async function expectStatus(response, expected) {
  assert.equal(response.status, expected, await response.text());
}

function validateLocalSupabaseEnvironment(environment) {
  for (const key of ["API_URL", "REST_URL", "PUBLISHABLE_KEY", "SERVICE_ROLE_KEY"])
    if (!environment[key]) throw new Error(`Missing local Supabase value: ${key}`);
  return environment;
}
