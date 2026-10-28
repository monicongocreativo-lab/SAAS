import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { decodeJwt, generateKeyPair, SignJWT } from "jose";
import grantSchema from "../contracts/offline-identity-grant.v1.schema.json" with {
  type: "json",
};
import {
  OfflineGrantError,
  verifyOfflineGrant,
} from "../src/offline/identity-grant.mjs";

const ids = {
  user: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  grant: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  company: "11111111-1111-4111-8111-111111111111",
  device: "22222222-2222-4222-8222-222222222222",
  site: "33333333-3333-4333-8333-333333333333",
  house: "44444444-4444-4444-8444-444444444444",
  lot: "55555555-5555-4555-8555-555555555555",
};
const now = new Date("2026-10-25T12:00:00.000Z");
const validate = new Ajv2020({ allErrors: true }).compile(grantSchema);
const { privateKey, publicKey } = await generateKeyPair("ES256");

async function signedGrant(overrides = {}, signingKey = privateKey) {
  const issued = Math.floor(now.getTime() / 1000);
  return new SignJWT({
    schema_version: 1,
    company_id: ids.company,
    device_id: ids.device,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    permission: "collection.capture",
    ...overrides,
  })
    .setProtectedHeader({
      alg: "ES256",
      kid: "test-issuer-key",
      typ: "tamago-offline-grant+jwt",
    })
    .setIssuer("https://tamago.invalid/offline-grants")
    .setAudience("tamago.offline.capture")
    .setSubject(ids.user)
    .setJti(ids.grant)
    .setIssuedAt(issued)
    .setNotBefore(issued)
    .setExpirationTime(issued + 24 * 60 * 60)
    .sign(signingKey);
}

const expected = {
  sub: ids.user,
  company_id: ids.company,
  device_id: ids.device,
  site_id: ids.site,
  house_id: ids.house,
  lot_id: ids.lot,
  permission: "collection.capture",
};

test("invalid verifier inputs fail closed with a stable error code", async () => {
  await assert.rejects(
    verifyOfflineGrant("not-a-token"),
    (error) =>
      error instanceof OfflineGrantError &&
      error.code === "OFFLINE_GRANT_INVALID_INPUT",
  );
});

test("DEV-007 grant verifies issuer signature and exact user, company, device, scope and permission", async () => {
  const token = await signedGrant();
  const payload = decodeJwt(token);
  assert.equal(validate(payload), true);

  const result = await verifyOfflineGrant(token, { publicKey, expected, now });
  assert.deepEqual(result, {
    grant_id: ids.grant,
    subject_user_id: ids.user,
    company_id: ids.company,
    device_id: ids.device,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    permission: "collection.capture",
    device_key_thumbprint: null,
    grant_state: "current",
    signature_verified: true,
  });
  assert.equal("receipt" in result, false);
  assert.equal("accepted" in result, false);
});

test("changed grant claims, unknown claims and another device cannot verify", async () => {
  const changedKey = await generateKeyPair("ES256");
  const tokenWithWrongIssuerKey = await signedGrant({}, changedKey.privateKey);
  await assert.rejects(
    verifyOfflineGrant(tokenWithWrongIssuerKey, { publicKey, expected, now }),
    (error) =>
      error instanceof OfflineGrantError &&
      error.code === "OFFLINE_GRANT_SIGNATURE_OR_PAYLOAD_INVALID",
  );

  const wrongCompany = await signedGrant({ company_id: ids.device });
  await assert.rejects(
    verifyOfflineGrant(wrongCompany, { publicKey, expected, now }),
    /OFFLINE_GRANT_SCOPE_MISMATCH/,
  );

  const extraClaim = await signedGrant({ role: "director" });
  await assert.rejects(
    verifyOfflineGrant(extraClaim, { publicKey, expected, now }),
    /OFFLINE_GRANT_CLAIMS_INVALID/,
  );
  assert.equal(validate(decodeJwt(extraClaim)), false);
});

test("a correctly signed expired capability remains verifiable as expired, not current", async () => {
  const issued = Math.floor(now.getTime() / 1000) - 25 * 60 * 60;
  const token = await new SignJWT({
    schema_version: 1,
    company_id: ids.company,
    device_id: ids.device,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    permission: "collection.capture",
  })
    .setProtectedHeader({
      alg: "ES256",
      kid: "test-issuer-key",
      typ: "tamago-offline-grant+jwt",
    })
    .setIssuer("https://tamago.invalid/offline-grants")
    .setAudience("tamago.offline.capture")
    .setSubject(ids.user)
    .setJti(ids.grant)
    .setIssuedAt(issued)
    .setNotBefore(issued)
    .setExpirationTime(issued + 24 * 60 * 60)
    .sign(privateKey);

  const result = await verifyOfflineGrant(token, { publicKey, expected, now });
  assert.equal(result.signature_verified, true);
  assert.equal(result.grant_state, "expired");
});
