import {
  calculateJwkThumbprint,
  compactVerify,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  SignJWT,
} from "jose";

const PROOF_FORMAT = "tamago.offline-device-event-proof";
const PROOF_TYPE = "tamago-offline-device-event-proof+jwt";
const PROOF_ISSUER = "urn:tamago:offline-device-key";
const PROOF_AUDIENCE = "tamago.offline.collection-event";
const MAX_PROOF_LENGTH = 8192;
const SHA256_THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_FIELDS = [
  "schema_version",
  "event_id",
  "company_id",
  "site_id",
  "house_id",
  "lot_id",
  "business_date",
  "occurrence",
  "quantity_eggs",
  "occurred_at",
  "captured_at",
  "actor_declared_id",
  "device_id",
].sort();
const CLAIMS = new Set([
  "iss",
  "aud",
  "sub",
  "jti",
  "iat",
  "schema_version",
  "grant_id",
  "device_id",
  "event_id",
  "event_hash",
]);

export class OfflineDeviceProofError extends Error {
  constructor(code) {
    super(code);
    this.name = "OfflineDeviceProofError";
    this.code = code;
  }
}

/**
 * Generate a P-256 signing key pair for an experimental browser/device proof.
 * The private CryptoKey is non-extractable at the Web Crypto API boundary.
 * This does not prove hardware-backed storage or device attestation.
 */
export async function generateOfflineDeviceKeyPair() {
  try {
    const { privateKey, publicKey } = await generateKeyPair("ES256", {
      extractable: false,
    });
    if (privateKey.extractable !== false || publicKey.extractable !== true)
      throw new Error("key extractability is not supported as expected");
    const publicJwk = await exportJWK(publicKey);
    return Object.freeze({
      privateKey,
      publicKey,
      publicJwk: Object.freeze(publicJwk),
      thumbprint: await calculateJwkThumbprint(publicJwk, "sha256"),
    });
  } catch {
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_KEY_GENERATION_FAILED");
  }
}

/**
 * Sign a canonical, schema-bounded collection event and grant reference.
 * `grant` must come from a trusted grant verifier and include the key thumbprint
 * bound by a future server-issued grant version. A v1 grant has no such binding.
 */
export async function createOfflineDeviceEventProof(
  event,
  grant,
  keyPair,
  { now = new Date(), jti = crypto.randomUUID() } = {},
) {
  validateGrantEventContext(event, grant);
  if (
    keyPair?.privateKey?.extractable !== false ||
    !keyPair?.publicJwk ||
    !Number.isFinite(now?.getTime?.()) ||
    !UUID.test(jti)
  )
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_PROOF_INVALID_INPUT");

  let thumbprint;
  let jws;
  try {
    const publicJwk = await exportJWK(keyPair.publicKey);
    assertPublicP256Jwk(publicJwk);
    thumbprint = await calculateJwkThumbprint(publicJwk, "sha256");
    if (
      thumbprint !== keyPair.thumbprint ||
      thumbprint !== grant.device_key_thumbprint
    )
      throw new Error("device key not bound to the verified grant");

    jws = await new SignJWT({
      schema_version: 1,
      grant_id: grant.grant_id,
      device_id: grant.device_id,
      event_id: event.event_id,
      event_hash: await hashCanonicalEvent(event),
    })
      .setProtectedHeader({
        alg: "ES256",
        kid: thumbprint,
        typ: PROOF_TYPE,
        jwk: publicJwk,
      })
      .setIssuer(PROOF_ISSUER)
      .setAudience(PROOF_AUDIENCE)
      .setSubject(grant.subject_user_id)
      .setJti(jti)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .sign(keyPair.privateKey);
  } catch {
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_PROOF_SIGNING_FAILED");
  }

  if (jws.length > MAX_PROOF_LENGTH)
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_PROOF_TOO_LARGE");
  return Object.freeze({
    format: PROOF_FORMAT,
    schema_version: 1,
    jws,
  });
}

/**
 * Verify possession proof, exact event bytes, grant context, and bound key.
 * A successful result is not current authorization, device attestation, receipt,
 * review, or acceptance; the server must still check grant state and deduplicate.
 */
export async function verifyOfflineDeviceEventProof(
  proof,
  event,
  grant,
  { now = new Date() } = {},
) {
  validateGrantEventContext(event, grant);
  if (
    proof?.format !== PROOF_FORMAT ||
    proof.schema_version !== 1 ||
    typeof proof.jws !== "string" ||
    proof.jws.length === 0 ||
    proof.jws.length > MAX_PROOF_LENGTH ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_PROOF_INVALID_INPUT");

  let verified;
  let thumbprint;
  try {
    const header = decodeProtectedHeader(proof.jws);
    if (
      !isRecord(header) ||
      Object.keys(header).sort().join(",") !== "alg,jwk,kid,typ" ||
      header.alg !== "ES256" ||
      header.typ !== PROOF_TYPE ||
      typeof header.kid !== "string"
    )
      throw new Error("invalid proof protected header");
    assertPublicP256Jwk(header.jwk);
    thumbprint = await calculateJwkThumbprint(header.jwk, "sha256");
    if (
      !SHA256_THUMBPRINT.test(header.kid) ||
      header.kid !== thumbprint ||
      thumbprint !== grant.device_key_thumbprint
    )
      throw new Error("proof key does not match grant key binding");
    const publicKey = await importJWK(header.jwk, "ES256");
    verified = await compactVerify(proof.jws, publicKey, {
      algorithms: ["ES256"],
    });
  } catch {
    throw new OfflineDeviceProofError(
      "OFFLINE_DEVICE_PROOF_SIGNATURE_OR_KEY_INVALID",
    );
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(verified.payload));
  } catch {
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_PROOF_CLAIMS_INVALID");
  }

  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== CLAIMS.size ||
    Object.keys(payload).some((claim) => !CLAIMS.has(claim)) ||
    payload.iss !== PROOF_ISSUER ||
    payload.aud !== PROOF_AUDIENCE ||
    payload.sub !== grant.subject_user_id ||
    payload.jti === undefined ||
    !UUID.test(payload.jti) ||
    payload.iat === undefined ||
    !Number.isSafeInteger(payload.iat) ||
    payload.iat < 0 ||
    payload.schema_version !== 1 ||
    payload.grant_id !== grant.grant_id ||
    payload.device_id !== grant.device_id ||
    payload.event_id !== event.event_id ||
    payload.event_hash !== (await hashCanonicalEvent(event))
  )
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_PROOF_BINDING_MISMATCH");

  return Object.freeze({
    proof_verified: true,
    grant_id: payload.grant_id,
    subject_user_id: payload.sub,
    device_id: payload.device_id,
    event_id: payload.event_id,
    event_hash: payload.event_hash,
    key_thumbprint: thumbprint,
    authorization_status: "requires_server_check",
    receipt_status: "not_received",
    review_status: "pending",
  });
}

function validateGrantEventContext(event, grant) {
  if (
    !isRecord(event) ||
    Object.keys(event).sort().join(",") !== EVENT_FIELDS.join(",") ||
    event.schema_version !== 2 ||
    ![
      "event_id",
      "company_id",
      "site_id",
      "house_id",
      "lot_id",
      "device_id",
    ].every(
      (field) => typeof event[field] === "string" && UUID.test(event[field]),
    ) ||
    typeof event.actor_declared_id !== "string" ||
    !UUID.test(event.actor_declared_id) ||
    typeof event.business_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(event.business_date) ||
    !Number.isInteger(event.occurrence) ||
    event.occurrence < 1 ||
    event.occurrence > 3 ||
    !Number.isSafeInteger(event.quantity_eggs) ||
    event.quantity_eggs < 0 ||
    !isUtcDateTime(event.occurred_at) ||
    !isUtcDateTime(event.captured_at)
  )
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_EVENT_INVALID");

  if (
    !isRecord(grant) ||
    grant.signature_verified !== true ||
    ![
      "grant_id",
      "subject_user_id",
      "company_id",
      "device_id",
      "site_id",
      "house_id",
      "lot_id",
    ].every(
      (field) => typeof grant[field] === "string" && UUID.test(grant[field]),
    ) ||
    grant.permission !== "collection.capture" ||
    !["current", "expired"].includes(grant.grant_state) ||
    typeof grant.device_key_thumbprint !== "string" ||
    !SHA256_THUMBPRINT.test(grant.device_key_thumbprint)
  )
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_GRANT_NOT_BOUND_TO_KEY");

  if (
    event.company_id !== grant.company_id ||
    event.site_id !== grant.site_id ||
    event.house_id !== grant.house_id ||
    event.lot_id !== grant.lot_id ||
    event.device_id !== grant.device_id ||
    event.actor_declared_id !== grant.subject_user_id
  )
    throw new OfflineDeviceProofError("OFFLINE_DEVICE_PROOF_SCOPE_MISMATCH");
  return true;
}

async function hashCanonicalEvent(event) {
  const canonical = JSON.stringify(
    Object.fromEntries(EVENT_FIELDS.map((field) => [field, event[field]])),
  );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return toBase64Url(new Uint8Array(digest));
}

function assertPublicP256Jwk(jwk) {
  if (
    !isRecord(jwk) ||
    Object.keys(jwk).sort().join(",") !== "crv,kty,x,y" ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(jwk.x) ||
    typeof jwk.y !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(jwk.y)
  )
    throw new Error("expected a public P-256 JWK");
}

function isUtcDateTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  )
    return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
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
