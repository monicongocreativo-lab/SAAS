import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  decodeProtectedHeader,
  exportJWK,
} from "jose";
import proofSchema from "../contracts/offline-device-event-proof.v1.schema.json" with {
  type: "json",
};
import {
  createOfflineDeviceEventProof,
  generateOfflineDeviceKeyPair,
  OfflineDeviceProofError,
  verifyOfflineDeviceEventProof,
} from "../src/offline/device-event-proof.mjs";

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
const validateProofSchema = new Ajv2020({ allErrors: true }).compile(proofSchema);

function makeEvent(overrides = {}) {
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
    occurred_at: "2026-10-25T11:00:00.000Z",
    captured_at: "2026-10-25T11:01:00.000Z",
    actor_declared_id: ids.user,
    device_id: ids.device,
    ...overrides,
  };
}

async function makeGrant(keyPair, overrides = {}) {
  return {
    grant_id: ids.grant,
    subject_user_id: ids.user,
    company_id: ids.company,
    device_id: ids.device,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    permission: "collection.capture",
    grant_state: "current",
    signature_verified: true,
    device_key_thumbprint: keyPair.thumbprint,
    ...overrides,
  };
}

test("device key is non-extractable and proof schema contains only a compact JWS", async () => {
  const keyPair = await generateOfflineDeviceKeyPair();
  assert.equal(keyPair.privateKey.extractable, false);
  assert.equal(keyPair.publicKey.extractable, true);
  assert.equal("d" in keyPair.publicJwk, false);
  await assert.rejects(exportJWK(keyPair.privateKey));

  const grant = await makeGrant(keyPair);
  const proof = await createOfflineDeviceEventProof(
    makeEvent(),
    grant,
    keyPair,
    { now, jti: "77777777-7777-4777-8777-777777777777" },
  );
  assert.equal(validateProofSchema(proof), true);
  assert.deepEqual(Object.keys(proof).sort(), [
    "format",
    "jws",
    "schema_version",
  ]);
  assert.deepEqual(Object.keys(decodeProtectedHeader(proof.jws).jwk).sort(), [
    "crv",
    "kty",
    "x",
    "y",
  ]);
});

test("proof verifies exact event, grant, worker, device and server-bound key", async () => {
  const keyPair = await generateOfflineDeviceKeyPair();
  const event = makeEvent();
  const grant = await makeGrant(keyPair);
  const proof = await createOfflineDeviceEventProof(event, grant, keyPair, {
    now,
    jti: "77777777-7777-4777-8777-777777777777",
  });

  const verified = await verifyOfflineDeviceEventProof(proof, event, grant, {
    now,
  });
  assert.match(verified.event_hash, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(
    { ...verified, event_hash: "<sha256>" },
    {
      proof_verified: true,
      grant_id: grant.grant_id,
      subject_user_id: grant.subject_user_id,
      device_id: grant.device_id,
      event_id: event.event_id,
      event_hash: "<sha256>",
      key_thumbprint: keyPair.thumbprint,
      authorization_status: "requires_server_check",
      receipt_status: "not_received",
      review_status: "pending",
    },
  );
});

test("proof rejects changed event values and changed event identity", async () => {
  const keyPair = await generateOfflineDeviceKeyPair();
  const event = makeEvent();
  const grant = await makeGrant(keyPair);
  const proof = await createOfflineDeviceEventProof(event, grant, keyPair, {
    now,
    jti: "77777777-7777-4777-8777-777777777777",
  });

  await assert.rejects(
    verifyOfflineDeviceEventProof(
      proof,
      makeEvent({ quantity_eggs: 301 }),
      grant,
      { now },
    ),
    (error) => error.code === "OFFLINE_DEVICE_PROOF_BINDING_MISMATCH",
  );
  await assert.rejects(
    verifyOfflineDeviceEventProof(
      proof,
      makeEvent({ event_id: "88888888-8888-4888-8888-888888888888" }),
      grant,
      { now },
    ),
    (error) => error.code === "OFFLINE_DEVICE_PROOF_BINDING_MISMATCH",
  );
});

test("proof rejects a different grant, key, user or scope", async () => {
  const keyPair = await generateOfflineDeviceKeyPair();
  const event = makeEvent();
  const grant = await makeGrant(keyPair);
  const proof = await createOfflineDeviceEventProof(event, grant, keyPair, {
    now,
    jti: "77777777-7777-4777-8777-777777777777",
  });
  const otherKey = await generateOfflineDeviceKeyPair();

  for (const alteredGrant of [
    { ...grant, grant_id: "88888888-8888-4888-8888-888888888888" },
    { ...grant, device_key_thumbprint: otherKey.thumbprint },
    { ...grant, subject_user_id: "99999999-9999-4999-8999-999999999999" },
    { ...grant, lot_id: "88888888-8888-4888-8888-888888888888" },
  ]) {
    await assert.rejects(
      verifyOfflineDeviceEventProof(proof, event, alteredGrant, { now }),
      OfflineDeviceProofError,
    );
  }
});

test("expired verified grant can carry a provisional proof without acceptance", async () => {
  const keyPair = await generateOfflineDeviceKeyPair();
  const event = makeEvent();
  const grant = await makeGrant(keyPair, { grant_state: "expired" });
  const proof = await createOfflineDeviceEventProof(event, grant, keyPair, {
    now,
    jti: "77777777-7777-4777-8777-777777777777",
  });
  const verified = await verifyOfflineDeviceEventProof(proof, event, grant, {
    now,
  });

  assert.equal(verified.proof_verified, true);
  assert.equal(verified.authorization_status, "requires_server_check");
  assert.equal(verified.receipt_status, "not_received");
  assert.equal(verified.review_status, "pending");
});

test("v1 grant without a key binding and malformed proofs fail closed", async () => {
  const keyPair = await generateOfflineDeviceKeyPair();
  const event = makeEvent();
  const unboundGrant = await makeGrant(keyPair, {
    device_key_thumbprint: undefined,
  });

  await assert.rejects(
    createOfflineDeviceEventProof(event, unboundGrant, keyPair, { now }),
    (error) => error.code === "OFFLINE_DEVICE_GRANT_NOT_BOUND_TO_KEY",
  );
  const malformedProof = {
    format: "tamago.offline-device-event-proof",
    schema_version: 1,
    jws: "bad",
  };
  assert.equal(validateProofSchema(malformedProof), false);
  await assert.rejects(
    verifyOfflineDeviceEventProof(
      malformedProof,
      event,
      await makeGrant(keyPair),
      { now },
    ),
    (error) => error.code === "OFFLINE_DEVICE_PROOF_SIGNATURE_OR_KEY_INVALID",
  );
});
