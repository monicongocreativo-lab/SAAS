import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyDeviceRegistrationProof } from "../src/auth-prototype/device-registration-proof.mjs";
import { verifyOfflineDeviceEventProof } from "../src/offline/device-event-proof.mjs";
import {
  createPasswordVault,
  unlockPasswordVault,
} from "../src/offline/password-key-vault.mjs";

const context = {
  subject_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  device_id: "22222222-2222-4222-8222-222222222222",
};
const password = "Ficticia-personal-A-2026";
const now = new Date("2026-10-27T12:00:00Z");
const event = {
  schema_version: 2,
  event_id: "66666666-6666-4666-8666-666666666666",
  company_id: "11111111-1111-4111-8111-111111111111",
  site_id: "33333333-3333-4333-8333-333333333333",
  house_id: "44444444-4444-4444-8444-444444444444",
  lot_id: "55555555-5555-4555-8555-555555555555",
  business_date: "2026-10-27",
  occurrence: 1,
  quantity_eggs: 300,
  occurred_at: "2026-10-27T11:00:00.000Z",
  captured_at: "2026-10-27T11:01:00.000Z",
  actor_declared_id: context.subject_user_id,
  device_id: context.device_id,
};

test("password-encrypted vault signs the existing event proof, binds identity, locks and preserves event content", async () => {
  const vault = await createPasswordVault(context, password);
  const serialized = JSON.stringify(vault);
  assert.equal(serialized.includes(password), false);
  assert.equal("d" in vault.public_jwk, false);
  assert.equal("privateKey" in vault, false);
  const grant = {
    grant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    subject_user_id: context.subject_user_id,
    company_id: event.company_id,
    device_id: context.device_id,
    site_id: event.site_id,
    house_id: event.house_id,
    lot_id: event.lot_id,
    permission: "collection.capture",
    grant_state: "current",
    signature_verified: true,
    device_key_thumbprint: vault.thumbprint,
  };
  const opened = await unlockPasswordVault(
    JSON.parse(serialized),
    context,
    password,
  );
  assert.equal(opened.locked, false);
  assert.equal("privateKey" in opened, false);
  const before = JSON.stringify(event);
  const proof = await opened.createEventProof(event, grant, { now });
  const payload = { event, device_proof: proof };
  const sealed = await opened.sealLocalPayload(payload, {
    event_id: event.event_id,
    company_id: event.company_id,
  });
  assert.deepEqual(
    await opened.openLocalPayload(JSON.parse(JSON.stringify(sealed))),
    payload,
  );
  assert.equal("event" in sealed, false);
  const tampered = structuredClone(sealed);
  tampered.metadata.company_id = "99999999-9999-4999-8999-999999999999";
  await assert.rejects(opened.openLocalPayload(tampered), {
    code: "VAULT_LOCAL_PAYLOAD_INVALID",
  });
  const requestId = "77777777-7777-4777-8777-777777777777";
  const registrationProof = await opened.createRegistrationProof(
    { ...event, request_id: requestId },
    { now },
  );
  assert.equal(
    (
      await verifyDeviceRegistrationProof(registrationProof, {
        now,
        expected: {
          sub: context.subject_user_id,
          jti: requestId,
          company_id: event.company_id,
          device_id: context.device_id,
          site_id: event.site_id,
          house_id: event.house_id,
          lot_id: event.lot_id,
          permission: "collection.capture",
        },
      })
    ).device_key_thumbprint,
    vault.thumbprint,
  );
  assert.equal(
    (await verifyOfflineDeviceEventProof(proof, event, grant, { now }))
      .proof_verified,
    true,
  );
  assert.equal(JSON.stringify(event), before);
  await assert.rejects(
    opened.createEventProof(
      { ...event, actor_declared_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      grant,
    ),
    { code: "VAULT_CONTEXT_MISMATCH" },
  );
  const inFlight = opened.createEventProof(event, grant, { now });
  opened.lock();
  await assert.rejects(inFlight, { code: "VAULT_LOCKED" });
  await assert.rejects(opened.createEventProof(event, grant), {
    code: "VAULT_LOCKED",
  });
  await assert.rejects(opened.openLocalPayload(sealed), {
    code: "VAULT_LOCKED",
  });
});

test("wrong password, changed ciphertext or identity cannot open a vault; invalid KDF/version are rejected", async () => {
  const vault = await createPasswordVault(context, password);
  await assert.rejects(
    unlockPasswordVault(vault, context, "Ficticia-personal-B-2026"),
    { code: "VAULT_UNLOCK_FAILED" },
  );
  await assert.rejects(
    unlockPasswordVault(
      vault,
      { ...context, subject_user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
      password,
    ),
    { code: "VAULT_CONTEXT_MISMATCH" },
  );
  const corrupted = structuredClone(vault);
  const bytes = Buffer.from(corrupted.ciphertext, "base64url");
  bytes[30] ^= 1;
  corrupted.ciphertext = bytes.toString("base64url");
  await assert.rejects(unlockPasswordVault(corrupted, context, password), {
    code: "VAULT_UNLOCK_FAILED",
  });
  const swapped = {
    ...vault,
    subject_user_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  };
  await assert.rejects(
    unlockPasswordVault(
      swapped,
      { ...context, subject_user_id: swapped.subject_user_id },
      password,
    ),
    { code: "VAULT_UNLOCK_FAILED" },
  );
  await assert.rejects(
    unlockPasswordVault({ ...vault, schema_version: 99 }, context, password),
    { code: "VAULT_INVALID_RECORD" },
  );
  await assert.rejects(
    unlockPasswordVault(
      { ...vault, kdf: { ...vault.kdf, iterations: 1 } },
      context,
      password,
    ),
    { code: "VAULT_INVALID_RECORD" },
  );
  await assert.rejects(createPasswordVault(context, "1234"), {
    code: "VAULT_INVALID_PASSWORD_LENGTH",
  });
});
