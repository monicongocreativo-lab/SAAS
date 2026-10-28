import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import proofSchema from "../contracts/device-registration-proof.v1.schema.json" with {
  type: "json",
};
import {
  DeviceRegistrationProofError,
  verifyDeviceRegistrationProof,
} from "../src/auth-prototype/device-registration-proof.mjs";
import Ajv2020 from "ajv/dist/2020.js";

const now = new Date("2026-10-25T12:00:00.000Z");
const context = {
  sub: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  jti: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  company_id: "11111111-1111-4111-8111-111111111111",
  device_id: "22222222-2222-4222-8222-222222222222",
  site_id: "33333333-3333-4333-8333-333333333333",
  house_id: "44444444-4444-4444-8444-444444444444",
  lot_id: "55555555-5555-4555-8555-555555555555",
  permission: "collection.capture",
};

async function signedProof(overrides = {}) {
  const keys = await generateKeyPair("ES256", { extractable: false });
  const jwk = await exportJWK(keys.publicKey);
  const jws = await new SignJWT({
    ...context,
    iat: Math.floor(now.getTime() / 1000),
    ...overrides,
  })
    .setProtectedHeader({ alg: "ES256", typ: "tamago-device-registration+jwt", jwk })
    .sign(keys.privateKey);
  return { proof: { jws }, jwk, thumbprint: await calculateJwkThumbprint(jwk) };
}

test("registration proof schema is bounded and rejects extra input", () => {
  const validate = new Ajv2020({ allErrors: true }).compile(proofSchema);
  assert.equal(validate({ jws: "compact-jws" }), true);
  assert.equal(validate({ jws: "compact-jws", user_id: context.sub }), false);
});

test("verifies device possession and returns RFC 7638 key thumbprint", async () => {
  const { proof, thumbprint } = await signedProof();
  assert.deepEqual(
    await verifyDeviceRegistrationProof(proof, { expected: context, now }),
    { request_id: context.jti, device_key_thumbprint: thumbprint },
  );
});

test("rejects mismatched context, stale proof, and altered signature", async () => {
  const { proof } = await signedProof();
  await assert.rejects(
    verifyDeviceRegistrationProof(proof, {
      expected: { ...context, lot_id: "66666666-6666-4666-8666-666666666666" },
      now,
    }),
    (error) => error instanceof DeviceRegistrationProofError && error.code === "DEVICE_PROOF_SCOPE_MISMATCH",
  );
  await assert.rejects(
    verifyDeviceRegistrationProof(proof, {
      expected: context,
      now: new Date(now.getTime() + 6 * 60 * 1000),
    }),
    (error) => error.code === "DEVICE_PROOF_CLAIMS_INVALID",
  );
  const parts = proof.jws.split(".");
  parts[2] = `${parts[2].startsWith("A") ? "B" : "A"}${parts[2].slice(1)}`;
  await assert.rejects(
    verifyDeviceRegistrationProof({ jws: parts.join(".") }, { expected: context, now }),
    (error) => error.code === "DEVICE_PROOF_SIGNATURE_INVALID",
  );
});

test("rejects a proof that includes private key material", async () => {
  const keys = await generateKeyPair("ES256", { extractable: true });
  const jwk = await exportJWK(keys.privateKey);
  const jws = await new SignJWT({ ...context, iat: Math.floor(now.getTime() / 1000) })
    .setProtectedHeader({ alg: "ES256", typ: "tamago-device-registration+jwt", jwk })
    .sign(keys.privateKey);
  await assert.rejects(
    verifyDeviceRegistrationProof({ jws }, { expected: context, now }),
    (error) => error.code === "DEVICE_PROOF_SIGNATURE_INVALID",
  );
});
