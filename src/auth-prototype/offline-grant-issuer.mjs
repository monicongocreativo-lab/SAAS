import { SignJWT } from "jose";

const ISSUER = "https://tamago.invalid/offline-grants";
const AUDIENCE = "tamago.offline.capture";
const TYPE = "tamago-offline-grant+jwt";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;

export class OfflineGrantIssuanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "OfflineGrantIssuanceError";
    this.code = code;
  }
}

/**
 * Sign v2 only from a row returned by the authorized server-side registration
 * RPC. Keep the issuer private key in the server process/HSM boundary; never
 * pass it to browser code. This function does not perform that DB authorization.
 */
export async function issueOfflineCaptureGrant(
  registration,
  { privateKey, keyId, now = new Date() } = {},
) {
  const validated = validateRegistration(registration, now);
  if (
    privateKey?.type !== "private" ||
    privateKey.algorithm?.name !== "ECDSA" ||
    privateKey.algorithm?.namedCurve !== "P-256" ||
    typeof keyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)
  )
    throw new OfflineGrantIssuanceError("OFFLINE_GRANT_SIGNER_UNAVAILABLE");

  try {
    const token = await new SignJWT({
      schema_version: 2,
      company_id: registration.company_id,
      device_id: registration.device_id,
      site_id: registration.site_id,
      house_id: registration.house_id,
      lot_id: registration.lot_id,
      permission: "collection.capture",
      cnf: { jkt: registration.device_key_thumbprint },
    })
      .setProtectedHeader({ alg: "ES256", kid: keyId, typ: TYPE })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(registration.subject_user_id)
      .setJti(registration.grant_id)
      .setIssuedAt(validated.issuedAt)
      .setNotBefore(validated.notBefore)
      .setExpirationTime(validated.expiresAt)
      .sign(privateKey);
    return Object.freeze({
      token,
      grant_id: registration.grant_id,
      device_key_thumbprint: registration.device_key_thumbprint,
      key_id: keyId,
      schema_version: 2,
      expires_at: registration.expires_at,
      delivery_status: "not_received",
    });
  } catch {
    throw new OfflineGrantIssuanceError("OFFLINE_GRANT_SIGNING_FAILED");
  }
}

function validateRegistration(registration, now) {
  if (
    !isRecord(registration) ||
    registration.registry_status !== "registered" ||
    registration.signed_capability_issued !== false ||
    ![
      "grant_id",
      "subject_user_id",
      "company_id",
      "device_id",
      "site_id",
      "house_id",
      "lot_id",
    ].every(
      (field) =>
        typeof registration[field] === "string" &&
        UUID.test(registration[field]),
    ) ||
    registration.permission !== "collection.capture" ||
    typeof registration.device_key_thumbprint !== "string" ||
    !THUMBPRINT.test(registration.device_key_thumbprint) ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime())
  )
    throw new OfflineGrantIssuanceError("OFFLINE_GRANT_REGISTRATION_INVALID");

  const issuedAt = toNumericDate(registration.issued_at);
  const notBefore = toNumericDate(registration.not_before);
  const expiresAt = toNumericDate(registration.expires_at);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (
    issuedAt === null ||
    notBefore === null ||
    expiresAt === null ||
    issuedAt > nowSeconds ||
    notBefore < issuedAt ||
    notBefore > nowSeconds ||
    expiresAt <= nowSeconds ||
    expiresAt <= notBefore ||
    expiresAt - issuedAt > 24 * 60 * 60
  )
    throw new OfflineGrantIssuanceError("OFFLINE_GRANT_REGISTRATION_EXPIRED");
  return { issuedAt, notBefore, expiresAt };
}

function toNumericDate(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.floor(milliseconds / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
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
