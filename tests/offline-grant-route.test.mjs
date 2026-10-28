import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  decodeJwt,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import { createAuthPrototypeServer } from "../src/auth-prototype/server.mjs";
import {
  createOfflineDeviceEventProof,
  generateOfflineDeviceKeyPair,
} from "../src/offline/device-event-proof.mjs";
import { verifyOfflineGrant } from "../src/offline/identity-grant.mjs";

const APP_ORIGIN = "http://127.0.0.1:8765";
const now = new Date("2026-10-25T12:00:00.000Z");
const ids = {
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  company: "11111111-1111-4111-8111-111111111111",
  device: "22222222-2222-4222-8222-222222222222",
  site: "33333333-3333-4333-8333-333333333333",
  house: "44444444-4444-4444-8444-444444444444",
  lot: "55555555-5555-4555-8555-555555555555",
};
const issuerKeys = await generateKeyPair("ES256", { extractable: false });
const issuerPublicJwk = await exportJWK(issuerKeys.publicKey);
const registration = new Map();
const quarantineRows = new Map();
const directory = mkdtempSync(join(tmpdir(), "tamago-offline-grant-route-"));
const encryptionKey = randomBytes(32);
let rpcCalls = 0;
let registryStatus = "registry_current_unverified";
let grantThumbprint = "A".repeat(43);
let server;
let gatewayUrl;
let cookie;

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function fakeFetch(input, init = {}) {
  const url = new URL(input);
  if (url.pathname === "/auth/v1/token")
    return response(200, {
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      expires_in: 3600,
      user: { id: ids.user, app_metadata: {} },
    });
  if (url.pathname === "/auth/v1/user")
    return response(200, { id: ids.user, email: "field@example.invalid", app_metadata: {} });
  if (url.pathname === "/rest/v1/rpc/register_offline_capture_grant_v2") {
    rpcCalls += 1;
    const request = JSON.parse(init.body);
    const prior = registration.get(request.p_request_id);
    if (prior) {
      const same =
        prior.device_key_thumbprint === request.p_device_key_thumbprint &&
        prior.device_id === request.p_device_id &&
        prior.site_id === request.p_site_id &&
        prior.house_id === request.p_house_id &&
        prior.lot_id === request.p_lot_id;
      if (!same) return response(400, { code: "22023" });
      return response(200, prior);
    }
    const row = {
      grant_id: randomUUID(),
      subject_user_id: ids.user,
      company_id: request.p_company_id,
      device_id: request.p_device_id,
      site_id: request.p_site_id,
      house_id: request.p_house_id,
      lot_id: request.p_lot_id,
      permission: "collection.capture",
      device_key_thumbprint: request.p_device_key_thumbprint,
      issued_at: now.toISOString(),
      not_before: now.toISOString(),
      expires_at: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      registry_status: "registered",
      signed_capability_issued: false,
    };
    registration.set(request.p_request_id, row);
    return response(200, row);
  }
  if (url.pathname === "/rest/v1/rpc/resolve_offline_capture_grant_v2") {
    const request = JSON.parse(init.body);
    return response(200, {
      grant_id: request.p_grant_id,
      registry_status: registryStatus,
      subject_user_id: request.p_subject_user_id,
      company_id: request.p_company_id,
      device_id: request.p_device_id,
      site_id: request.p_site_id,
      house_id: request.p_house_id,
      lot_id: request.p_lot_id,
      permission: "collection.capture",
      device_key_thumbprint: grantThumbprint,
      expires_at:
        registryStatus === "expired"
          ? new Date(now.getTime() - 1000).toISOString()
          : new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  if (url.pathname === "/rest/v1/rpc/receive_offline_collection_event") {
    const {
      p_event: event,
      p_grant_id: grantId,
      p_subject_user_id: subjectId,
    } = JSON.parse(init.body);
    return response(200, {
      event_id: event.event_id,
      receipt_status: "received",
      review_status: "pending",
      identity_status: "verified",
      synchronization_user_id: ids.user,
      capture_subject_id: subjectId,
      grant_id: grantId,
      received_at: now.toISOString(),
      duplicate: false,
    });
  }
  if (url.pathname === "/rest/v1/rpc/quarantine_offline_collection_event") {
    const request = JSON.parse(init.body);
    const eventId = request.p_event.event_id;
    const prior = quarantineRows.get(eventId);
    if (prior) {
      if (JSON.stringify(prior.event_payload) !== JSON.stringify(request.p_event))
        return response(400, { code: "22023" });
      return response(200, { ...prior.receipt, duplicate: true });
    }
    const receipt = {
      event_id: eventId,
      receipt_status: "received",
      review_status: "review_required",
      registry_status: request.p_grant_status,
      proof_status: request.p_proof_status,
      quarantine_reason: request.p_quarantine_reason,
      received_at: now.toISOString(),
      duplicate: false,
    };
    quarantineRows.set(eventId, { event_payload: request.p_event, receipt });
    return response(200, receipt);
  }
  throw new Error(`unexpected fake Supabase request ${url.pathname}`);
}

server = createAuthPrototypeServer({
  apiUrl: "http://127.0.0.1:54321",
  restUrl: "http://127.0.0.1:54321/rest/v1/",
  publishableKey: "synthetic-publishable-key",
  serviceRoleKey: "synthetic-service-role",
  allowedOrigins: [APP_ORIGIN],
  sessionDbPath: join(directory, "sessions.sqlite"),
  sessionEncryptionKey: encryptionKey,
  offlineGrantSigningKey: issuerKeys.privateKey,
  offlineGrantKeyId: "tamago-offline-test-key-v1",
  offlineGrantPublicJwk: issuerPublicJwk,
  fetchImpl: fakeFetch,
  now: () => now.getTime(),
});

async function mutate(url, body, { origin = APP_ORIGIN, sessionCookie = cookie } = {}) {
  const result = await fetch(url, {
    method: "POST",
    headers: {
      origin,
      cookie: sessionCookie ?? "",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response: result, body: await result.json().catch(() => null) };
}

async function createProof(keys, request, overrides = {}) {
  const jwk = await exportJWK(keys.publicKey);
  return new SignJWT({
    company_id: ids.company,
    device_id: request.device_id,
    site_id: request.site_id,
    house_id: request.house_id,
    lot_id: request.lot_id,
    permission: "collection.capture",
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", typ: "tamago-device-registration+jwt", jwk })
    .setSubject(ids.user)
    .setJti(request.request_id)
    .setIssuedAt(Math.floor(now.getTime() / 1000))
    .sign(keys.privateKey);
}

test("authenticated endpoint issues same scoped v2 grant on idempotent retry", async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  gatewayUrl = `http://127.0.0.1:${server.address().port}`;

  const publicKeysResponse = await fetch(`${gatewayUrl}/v1/offline-grant-keys`);
  assert.equal(publicKeysResponse.status, 200);
  const publicKeys = await publicKeysResponse.json();
  assert.deepEqual(publicKeys.keys, [
    {
      ...issuerPublicJwk,
      alg: "ES256",
      use: "sig",
      kid: "tamago-offline-test-key-v1",
    },
  ]);
  assert.equal("d" in publicKeys.keys[0], false);

  const loginResponse = await fetch(`${gatewayUrl}/v1/auth/login`, {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: "field@example.invalid", password: "synthetic" }),
  });
  assert.equal(loginResponse.status, 200);
  cookie = (loginResponse.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie);

  const request = {
    request_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    device_id: ids.device,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
  };
  const deviceKeys = await generateKeyPair("ES256", { extractable: false });
  const proof = await createProof(deviceKeys, request);
  const url = `${gatewayUrl}/v1/companies/${ids.company}/offline-capture-grants`;
  const first = await mutate(url, { ...request, proof: { jws: proof } });
  assert.equal(first.response.status, 201);
  assert.equal(first.body.schema_version, 2);
  assert.equal(first.body.delivery_status, "not_received");
  assert.equal(decodeJwt(first.body.token).sub, ids.user);
  assert.equal(decodeJwt(first.body.token).cnf.jkt, first.body.device_key_thumbprint);
  assert.equal(rpcCalls, 1);

  const checked = await verifyOfflineGrant(first.body.token, {
    publicKey: issuerKeys.publicKey,
    expected: {
      sub: ids.user,
      company_id: ids.company,
      device_id: ids.device,
      site_id: ids.site,
      house_id: ids.house,
      lot_id: ids.lot,
      permission: "collection.capture",
      device_key_thumbprint: first.body.device_key_thumbprint,
    },
    now,
  });
  assert.equal(checked.signature_verified, true);

  const retry = await mutate(url, { ...request, proof: { jws: proof } });
  assert.equal(retry.response.status, 201);
  assert.equal(retry.body.grant_id, first.body.grant_id);
  assert.deepEqual(decodeJwt(retry.body.token), decodeJwt(first.body.token));
  assert.equal(rpcCalls, 2);

  const altered = await mutate(url, {
    ...request,
    proof: { jws: await createProof(await generateKeyPair("ES256"), request) },
  });
  assert.equal(altered.response.status, 409);
  assert.equal(altered.body.error, "OFFLINE_GRANT_REQUEST_CONFLICT");

  const invalidContextProof = await createProof(deviceKeys, request, {
    lot_id: "66666666-6666-4666-8666-666666666666",
  });
  const invalidContext = await mutate(url, {
    ...request,
    proof: { jws: invalidContextProof },
  });
  assert.equal(invalidContext.response.status, 401);
  assert.equal(rpcCalls, 3);

  const wrongOrigin = await mutate(url, { ...request, proof: { jws: proof } }, { origin: "https://attacker.invalid" });
  assert.equal(wrongOrigin.response.status, 403);
});

test("offline bundle receipt preserves valid records and quarantines expiry or bad proof", async () => {
  registryStatus = "registry_current_unverified";
  const deviceKeys = await generateOfflineDeviceKeyPair();
  grantThumbprint = deviceKeys.thumbprint;
  const grant = {
    grant_id: "77777777-7777-4777-8777-777777777777",
    subject_user_id: ids.user,
    company_id: ids.company,
    device_id: ids.device,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    permission: "collection.capture",
    device_key_thumbprint: deviceKeys.thumbprint,
    signature_verified: true,
    grant_state: "current",
  };
  const event = {
    schema_version: 2,
    event_id: "66666666-6666-4666-8666-666666666666",
    company_id: ids.company,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    business_date: "2026-10-25",
    occurrence: 1,
    quantity_eggs: 300,
    occurred_at: "2026-10-25T12:00:00.000Z",
    captured_at: "2026-10-25T12:01:00.000Z",
    actor_declared_id: ids.user,
    device_id: ids.device,
  };
  const proof = await createOfflineDeviceEventProof(event, grant, deviceKeys, { now });
  const makeBundle = (sourceEvent, deviceProof) => ({
    format: "tamago.offline-collection-bundle",
    schema_version: 1,
    records: [
      {
        event: sourceEvent,
        identity_binding: {
          grant_id: grant.grant_id,
          subject_user_id: grant.subject_user_id,
          attribution_status: "pending_server_verification",
        },
        device_proof: deviceProof,
        delivery: { status: "pending" },
      },
    ],
  });
  const url = `${gatewayUrl}/v1/companies/${ids.company}/offline-collection-events`;

  const accepted = await mutate(url, makeBundle(event, proof));
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.event_id, event.event_id);
  assert.equal(accepted.body.identity_status, "verified");
  assert.equal(accepted.body.review_status, "pending");

  const expiredEvent = {
    ...event,
    event_id: "88888888-8888-4888-8888-888888888888",
    occurrence: 2,
  };
  const expiredProof = await createOfflineDeviceEventProof(expiredEvent, grant, deviceKeys, { now });
  registryStatus = "expired";
  const expiredBundle = makeBundle(expiredEvent, expiredProof);
  const expired = await mutate(url, expiredBundle);
  assert.equal(expired.response.status, 202);
  assert.equal(expired.body.review_status, "review_required");
  assert.equal(expired.body.quarantine_reason, "grant_expired");
  assert.equal(expired.body.proof_status, "verified");
  const repeated = await mutate(url, expiredBundle);
  assert.equal(repeated.response.status, 202);
  assert.equal(repeated.body.duplicate, true);

  registryStatus = "registry_current_unverified";
  const invalidEvent = {
    ...event,
    event_id: "99999999-9999-4999-8999-999999999999",
    occurrence: 3,
  };
  const invalidProof = { ...proof, jws: `${proof.jws.slice(0, -1)}A` };
  const invalid = await mutate(url, makeBundle(invalidEvent, invalidProof));
  assert.equal(invalid.response.status, 202);
  assert.equal(invalid.body.review_status, "review_required");
  assert.equal(invalid.body.quarantine_reason, "proof_invalid");
  assert.equal(invalid.body.proof_status, "invalid");
});

test("closes the temporary HTTP server and encrypted session fixture", async () => {
  server.close();
  await once(server, "close");
  encryptionKey.fill(0);
  rmSync(directory, { recursive: true, force: true });
});
