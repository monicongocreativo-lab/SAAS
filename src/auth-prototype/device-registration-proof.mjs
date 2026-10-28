import { calculateJwkThumbprint, compactVerify, importJWK } from "jose";

const TYPE = "tamago-device-registration+jwt";
const MAX_AGE_SECONDS = 5 * 60;
const CLAIMS = new Set([
  "sub",
  "jti",
  "iat",
  "company_id",
  "device_id",
  "site_id",
  "house_id",
  "lot_id",
  "permission",
]);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class DeviceRegistrationProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "DeviceRegistrationProofError";
    this.code = code;
  }
}

/** Verify an online request proof; this authenticates key possession, not hardware. */
export async function verifyDeviceRegistrationProof(
  proof,
  { expected, now = new Date() } = {},
) {
  if (
    !isRecord(proof) ||
    Object.keys(proof).length !== 1 ||
    typeof proof.jws !== "string" ||
    proof.jws.length < 1 ||
    proof.jws.length > 4096 ||
    !isRecord(expected) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    throw new DeviceRegistrationProofError("DEVICE_PROOF_INVALID_INPUT");

  let payload;
  let thumbprint;
  try {
    const [encodedHeader] = proof.jws.split(".");
    const header = JSON.parse(
      Buffer.from(encodedHeader, "base64url").toString(),
    );
    if (
      !isRecord(header) ||
      Object.keys(header).sort().join(",") !== "alg,jwk,typ" ||
      header.alg !== "ES256" ||
      header.typ !== TYPE ||
      !isPublicP256Jwk(header.jwk)
    )
      throw new Error("invalid header");
    const publicKey = await importJWK(header.jwk, "ES256");
    const verified = await compactVerify(proof.jws, publicKey, {
      algorithms: ["ES256"],
    });
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
    thumbprint = await calculateJwkThumbprint(header.jwk, "sha256");
  } catch {
    throw new DeviceRegistrationProofError("DEVICE_PROOF_SIGNATURE_INVALID");
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== CLAIMS.size ||
    Object.keys(payload).some((claim) => !CLAIMS.has(claim)) ||
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
    !Number.isSafeInteger(payload.iat) ||
    payload.iat > nowSeconds ||
    nowSeconds - payload.iat > MAX_AGE_SECONDS ||
    payload.permission !== "collection.capture"
  )
    throw new DeviceRegistrationProofError("DEVICE_PROOF_CLAIMS_INVALID");

  for (const claim of [
    "sub",
    "jti",
    "company_id",
    "device_id",
    "site_id",
    "house_id",
    "lot_id",
    "permission",
  ]) {
    if (payload[claim] !== expected[claim])
      throw new DeviceRegistrationProofError("DEVICE_PROOF_SCOPE_MISMATCH");
  }
  return Object.freeze({
    request_id: payload.jti,
    device_key_thumbprint: thumbprint,
  });
}

function isPublicP256Jwk(jwk) {
  return (
    isRecord(jwk) &&
    Object.keys(jwk).sort().join(",") === "crv,kty,x,y" &&
    jwk.kty === "EC" &&
    jwk.crv === "P-256" &&
    typeof jwk.x === "string" &&
    typeof jwk.y === "string" &&
    !("d" in jwk)
  );
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
