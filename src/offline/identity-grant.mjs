import { compactVerify } from "jose";

const ISSUER = "https://tamago.invalid/offline-grants";
const AUDIENCE = "tamago.offline.capture";
const TYPE = "tamago-offline-grant+jwt";
const MAX_TOKEN_LENGTH = 8192;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE_CLAIMS = [
  "iss",
  "aud",
  "sub",
  "jti",
  "iat",
  "nbf",
  "exp",
  "schema_version",
  "company_id",
  "device_id",
  "site_id",
  "house_id",
  "lot_id",
  "permission",
];
const CLAIMS_V1 = new Set(BASE_CLAIMS);
const CLAIMS_V2 = new Set([...BASE_CLAIMS, "cnf"]);
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

export class OfflineGrantError extends Error {
  constructor(code) {
    super(code);
    this.name = "OfflineGrantError";
    this.code = code;
  }
}

/**
 * Verify an issuer-signed grant for one expected local identity context.
 * This verifies a server-issued authorization snapshot, not a worker's local
 * unlock method, physical-device attestation, current membership, or receipt.
 */
export async function verifyOfflineGrant(
  token,
  { publicKey, expected, now = new Date() } = {},
) {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > MAX_TOKEN_LENGTH ||
    !publicKey ||
    !expected ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    throw new OfflineGrantError("OFFLINE_GRANT_INVALID_INPUT");

  let verified;
  let payload;
  try {
    verified = await compactVerify(token, publicKey, {
      algorithms: ["ES256"],
    });
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    throw new OfflineGrantError("OFFLINE_GRANT_SIGNATURE_OR_PAYLOAD_INVALID");
  }

  const { protectedHeader } = verified;
  const versionClaims =
    payload.schema_version === 1
      ? CLAIMS_V1
      : payload.schema_version === 2
        ? CLAIMS_V2
        : null;
  if (
    protectedHeader.alg !== "ES256" ||
    protectedHeader.typ !== TYPE ||
    typeof protectedHeader.kid !== "string" ||
    protectedHeader.kid.length === 0 ||
    Object.keys(protectedHeader).sort().join(",") !== "alg,kid,typ" ||
    !versionClaims ||
    Object.keys(payload).length !== versionClaims.size ||
    Object.keys(payload).some((claim) => !versionClaims.has(claim)) ||
    payload.iss !== ISSUER ||
    payload.aud !== AUDIENCE ||
    typeof payload.permission !== "string" ||
    payload.permission !== "collection.capture" ||
    ![
      "sub",
      "jti",
      "company_id",
      "device_id",
      "site_id",
      "house_id",
      "lot_id",
    ].every(
      (claim) =>
        typeof payload[claim] === "string" && UUID.test(payload[claim]),
    ) ||
    !["iat", "nbf", "exp"].every(
      (claim) => Number.isSafeInteger(payload[claim]) && payload[claim] >= 0,
    ) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > 24 * 60 * 60 ||
    payload.nbf < payload.iat ||
    payload.nbf >= payload.exp ||
    payload.iat > Math.floor(now.getTime() / 1000) ||
    payload.nbf > Math.floor(now.getTime() / 1000)
  )
    throw new OfflineGrantError("OFFLINE_GRANT_CLAIMS_INVALID");

  if (
    payload.schema_version === 2 &&
    (!isRecord(payload.cnf) ||
      Object.keys(payload.cnf).length !== 1 ||
      typeof payload.cnf.jkt !== "string" ||
      !THUMBPRINT.test(payload.cnf.jkt))
  )
    throw new OfflineGrantError("OFFLINE_GRANT_CLAIMS_INVALID");

  for (const claim of [
    "sub",
    "company_id",
    "device_id",
    "site_id",
    "house_id",
    "lot_id",
    "permission",
  ]) {
    if (expected[claim] !== payload[claim])
      throw new OfflineGrantError("OFFLINE_GRANT_SCOPE_MISMATCH");
  }
  if (
    payload.schema_version === 2 &&
    expected.device_key_thumbprint !== undefined &&
    expected.device_key_thumbprint !== payload.cnf.jkt
  )
    throw new OfflineGrantError("OFFLINE_GRANT_SCOPE_MISMATCH");

  return Object.freeze({
    grant_id: payload.jti,
    subject_user_id: payload.sub,
    company_id: payload.company_id,
    device_id: payload.device_id,
    site_id: payload.site_id,
    house_id: payload.house_id,
    lot_id: payload.lot_id,
    permission: payload.permission,
    device_key_thumbprint:
      payload.schema_version === 2 ? payload.cnf.jkt : null,
    grant_state: now.getTime() >= payload.exp * 1000 ? "expired" : "current",
    signature_verified: true,
  });
}

function isRecord(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}
