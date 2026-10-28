import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { decodeJwt, generateKeyPair } from "jose";
import grantSchema from "../contracts/offline-identity-grant.v2.schema.json" with {
  type: "json",
};
import {
  OfflineGrantIssuanceError,
  issueOfflineCaptureGrant,
} from "../src/auth-prototype/offline-grant-issuer.mjs";
import {
  createOfflineDeviceEventProof,
  generateOfflineDeviceKeyPair,
  verifyOfflineDeviceEventProof,
} from "../src/offline/device-event-proof.mjs";
import { verifyOfflineGrant } from "../src/offline/identity-grant.mjs";

const ids = {
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  grant: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  company: "11111111-1111-4111-8111-111111111111",
  device: "22222222-2222-4222-8222-222222222222",
  site: "33333333-3333-4333-8333-333333333333",
  house: "44444444-4444-4444-8444-444444444444",
  lot: "55555555-5555-4555-8555-555555555555",
  event: "66666666-6666-4666-8666-666666666666",
};
const now = new Date("2026-10-25T12:00:00.000Z");
const validateGrantSchema = new Ajv2020({ allErrors: true }).compile(grantSchema);
const issuerKeys = await generateKeyPair("ES256", { extractable: false });

function registration(deviceKeyThumbprint, overrides = {}) {
  return {
    registry_status: "registered",
    signed_capability_issued: false,
    grant_id: ids.grant,
    subject_user_id: ids.user,
    company_id: ids.company,
    device_id: ids.device,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    permission: "collection.capture",
    device_key_thumbprint: deviceKeyThumbprint,
    issued_at: "2026-10-25T11:59:00.000Z",
    not_before: "2026-10-25T11:59:00.000Z",
    expires_at: "2026-10-26T11:59:00.000Z",
    ...overrides,
  };
}

function event() {
  return {
    schema_version: 2,
    event_id: ids.event,
    company_id: ids.company,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    business_date: "2026-10-25",
    occurrence: 1,
    quantity_eggs: 300,
    occurred_at: "2026-10-25T11:58:00.000Z",
    captured_at: "2026-10-25T11:59:00.000Z",
    actor_declared_id: ids.user,
    device_id: ids.device,
  };
}

test("server issuer signs v2 with device thumbprint and proof works end to end", async () => {
  const deviceKeys = await generateOfflineDeviceKeyPair();
  const row = registration(deviceKeys.thumbprint);
  const issued = await issueOfflineCaptureGrant(row, {
    privateKey: issuerKeys.privateKey,
    keyId: "tamago-test-2026-01",
    now,
  });
  const payload = decodeJwt(issued.token);
  assert.equal(validateGrantSchema(payload), true);
  assert.deepEqual(payload.cnf, { jkt: deviceKeys.thumbprint });
  assert.equal(issued.key_id, "tamago-test-2026-01");
  assert.equal(issued.delivery_status, "not_received");

  const verifiedGrant = await verifyOfflineGrant(issued.token, {
    publicKey: issuerKeys.publicKey,
    expected: {
      sub: ids.user,
      company_id: ids.company,
      device_id: ids.device,
      site_id: ids.site,
      house_id: ids.house,
      lot_id: ids.lot,
      permission: "collection.capture",
      device_key_thumbprint: deviceKeys.thumbprint,
    },
    now,
  });
  assert.equal(verifiedGrant.signature_verified, true);
  assert.equal(verifiedGrant.device_key_thumbprint, deviceKeys.thumbprint);

  const capturedEvent = event();
  const proof = await createOfflineDeviceEventProof(
    capturedEvent,
    verifiedGrant,
    deviceKeys,
    { now },
  );
  const verifiedProof = await verifyOfflineDeviceEventProof(
    proof,
    capturedEvent,
    verifiedGrant,
    { now },
  );
  assert.equal(verifiedProof.proof_verified, true);
  assert.equal(verifiedProof.key_thumbprint, deviceKeys.thumbprint);
  assert.equal(verifiedProof.receipt_status, "not_received");
});

test("issuer rejects a non-registered, already-signed or key-unbound grant", async () => {
  const deviceKeys = await generateOfflineDeviceKeyPair();
  for (const invalid of [
    registration(deviceKeys.thumbprint, { registry_status: "revoked" }),
    registration(deviceKeys.thumbprint, { signed_capability_issued: true }),
    registration(undefined),
  ]) {
    await assert.rejects(
      issueOfflineCaptureGrant(invalid, {
        privateKey: issuerKeys.privateKey,
        keyId: "tamago-test-2026-01",
        now,
      }),
      OfflineGrantIssuanceError,
    );
  }
});

test("issuer rejects expired and overlong registry windows and invalid signer IDs", async () => {
  const deviceKeys = await generateOfflineDeviceKeyPair();
  const cases = [
    registration(deviceKeys.thumbprint, {
      expires_at: "2026-10-25T11:59:59.000Z",
    }),
    registration(deviceKeys.thumbprint, {
      expires_at: "2026-10-26T12:00:00.000Z",
    }),
  ];
  for (const row of cases) {
    await assert.rejects(
      issueOfflineCaptureGrant(row, {
        privateKey: issuerKeys.privateKey,
        keyId: "tamago-test-2026-01",
        now,
      }),
      OfflineGrantIssuanceError,
    );
  }
  await assert.rejects(
    issueOfflineCaptureGrant(registration(deviceKeys.thumbprint), {
      privateKey: issuerKeys.privateKey,
      keyId: "bad key id",
      now,
    }),
    /OFFLINE_GRANT_SIGNER_UNAVAILABLE/,
  );
});

test("v2 token cannot bind the event proof to another public key", async () => {
  const deviceKeys = await generateOfflineDeviceKeyPair();
  const otherKeys = await generateOfflineDeviceKeyPair();
  const issued = await issueOfflineCaptureGrant(
    registration(deviceKeys.thumbprint),
    {
      privateKey: issuerKeys.privateKey,
      keyId: "tamago-test-2026-01",
      now,
    },
  );
  const verifiedGrant = await verifyOfflineGrant(issued.token, {
    publicKey: issuerKeys.publicKey,
    expected: {
      sub: ids.user,
      company_id: ids.company,
      device_id: ids.device,
      site_id: ids.site,
      house_id: ids.house,
      lot_id: ids.lot,
      permission: "collection.capture",
      device_key_thumbprint: deviceKeys.thumbprint,
    },
    now,
  });
  await assert.rejects(
    createOfflineDeviceEventProof(event(), verifiedGrant, otherKeys, { now }),
    /OFFLINE_DEVICE_PROOF_SIGNING_FAILED/,
  );
});
