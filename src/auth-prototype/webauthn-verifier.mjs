import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
  decodeAttestationObject,
  decodeClientDataJSON,
} from "@simplewebauthn/server/helpers";

export class WebAuthnPrototypeError extends Error {
  constructor(code) {
    super(code);
    this.name = "WebAuthnPrototypeError";
    this.code = code;
  }
}

function requireValue(value, minimum = 1) {
  if (typeof value !== "string" || value.length < minimum || value.length > 256)
    throw new WebAuthnPrototypeError("INVALID_CONTEXT");
  return value;
}

function sessionHash(value) {
  return createHash("sha256").update(requireValue(value, 16)).digest("hex");
}

function checkResponse(response) {
  if (
    !response ||
    typeof response !== "object" ||
    Array.isArray(response) ||
    JSON.stringify(response).length > 65_536
  )
    throw new WebAuthnPrototypeError("INVALID_PROOF");
}

function requireSameOriginContext(response) {
  let data;
  try {
    data = decodeClientDataJSON(response.response.clientDataJSON);
  } catch {
    throw new WebAuthnPrototypeError("INVALID_PROOF");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new WebAuthnPrototypeError("INVALID_PROOF");
  if (
    (data.crossOrigin !== undefined && data.crossOrigin !== false) ||
    data.topOrigin !== undefined
  )
    throw new WebAuthnPrototypeError("CROSS_ORIGIN_NOT_ALLOWED");
}

// Optional future factor; not required by the password-first delivery (27/10).
// Server-side experiment only. The caller must derive subjectId/sessionBinding
// from an authenticated session. This class neither creates a login nor accepts
// the client-generated challenges from the static DEV-007F harness.
export class WebAuthnPrototypeVerifier {
  constructor({ databasePath, rpId, origin, now = () => Date.now() }) {
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      url.hostname !== rpId ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" && rpId === "localhost")
      )
    )
      throw new WebAuthnPrototypeError("INVALID_RP_CONFIGURATION");
    this.rpId = rpId;
    this.origin = origin;
    this.now = now;
    this.db = new DatabaseSync(databasePath);
    const tables = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    if (
      tables.length &&
      !tables.some((table) => table.name === "webauthn_lab_meta")
    ) {
      this.db.close();
      throw new WebAuthnPrototypeError("UNRELATED_DATABASE");
    }
    if (
      tables.length &&
      this.db.prepare("SELECT version FROM webauthn_lab_meta").get()
        ?.version !== 1
    ) {
      this.db.close();
      throw new WebAuthnPrototypeError("UNSUPPORTED_DATABASE_VERSION");
    }
    this.db.exec(`
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS webauthn_lab_meta (version INTEGER NOT NULL);
      INSERT INTO webauthn_lab_meta SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM webauthn_lab_meta);
      CREATE TABLE IF NOT EXISTS webauthn_lab_ceremonies (
        id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, session_hash TEXT NOT NULL,
        purpose TEXT NOT NULL CHECK(purpose IN ('register','authenticate')),
        challenge TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS webauthn_lab_credentials (
        id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, public_key BLOB NOT NULL,
        counter INTEGER NOT NULL, device_type TEXT NOT NULL, backed_up INTEGER NOT NULL,
        created_at INTEGER NOT NULL, revoked_at INTEGER
      );
    `);
    if (
      this.db.prepare("SELECT version FROM webauthn_lab_meta").get().version !==
      1
    ) {
      this.db.close();
      throw new WebAuthnPrototypeError("UNSUPPORTED_DATABASE_VERSION");
    }
  }

  close() {
    this.db.close();
  }

  issue(subjectId, sessionBinding, purpose, challenge) {
    const subject = requireValue(subjectId);
    const binding = sessionHash(sessionBinding);
    const now = this.now();
    this.db
      .prepare("DELETE FROM webauthn_lab_ceremonies WHERE expires_at <= ?")
      .run(now);
    const ceremonyId = randomUUID();
    this.db
      .prepare(`INSERT INTO webauthn_lab_ceremonies
      (id,subject_id,session_hash,purpose,challenge,expires_at) VALUES (?,?,?,?,?,?)`)
      .run(ceremonyId, subject, binding, purpose, challenge, now + 300_000);
    return ceremonyId;
  }

  consume({ subjectId, sessionBinding, ceremonyId }, purpose) {
    const now = this.now();
    // One atomic write claims the challenge before async crypto verification.
    // Wrong subject/session cannot consume someone else's ceremony.
    const row = this.db
      .prepare(`UPDATE webauthn_lab_ceremonies SET consumed_at = ?
      WHERE id = ? AND subject_id = ? AND session_hash = ? AND purpose = ?
      AND expires_at > ? AND consumed_at IS NULL RETURNING challenge`)
      .get(
        now,
        requireValue(ceremonyId),
        requireValue(subjectId),
        sessionHash(sessionBinding),
        purpose,
        now,
      );
    if (!row) throw new WebAuthnPrototypeError("CHALLENGE_UNAVAILABLE");
    return row.challenge;
  }

  async beginRegistration({ subjectId, sessionBinding, displayName }) {
    requireValue(subjectId);
    sessionHash(sessionBinding);
    requireValue(displayName);
    const options = await generateRegistrationOptions({
      rpName: "Tamago DEV-007G laboratorio",
      rpID: this.rpId,
      userID: new Uint8Array(createHash("sha256").update(subjectId).digest()),
      userName: subjectId,
      userDisplayName: displayName,
      attestationType: "none",
      supportedAlgorithmIDs: [-7],
      authenticatorSelection: {
        authenticatorAttachment: "cross-platform",
        residentKey: "discouraged",
        userVerification: "discouraged",
      },
      excludeCredentials: this.db
        .prepare("SELECT id FROM webauthn_lab_credentials WHERE subject_id = ?")
        .all(subjectId),
    });
    return {
      ceremonyId: this.issue(
        subjectId,
        sessionBinding,
        "register",
        options.challenge,
      ),
      options,
    };
  }

  async finishRegistration(context, response) {
    const challenge = this.consume(context, "register");
    checkResponse(response);
    let format;
    try {
      format = decodeAttestationObject(
        Buffer.from(response.response.attestationObject, "base64url"),
      ).get("fmt");
    } catch {
      throw new WebAuthnPrototypeError("INVALID_PROOF");
    }
    // This cut does not evaluate hardware trust anchors or fetch certificate CRLs.
    if (format !== "none")
      throw new WebAuthnPrototypeError("UNSUPPORTED_ATTESTATION");
    requireSameOriginContext(response);
    let result;
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: false,
        supportedAlgorithmIDs: [-7],
      });
    } catch {
      throw new WebAuthnPrototypeError("INVALID_PROOF");
    }
    if (
      !result.verified ||
      result.registrationInfo.credentialDeviceType !== "singleDevice" ||
      result.registrationInfo.credentialBackedUp
    )
      throw new WebAuthnPrototypeError("UNSUPPORTED_CREDENTIAL");
    const info = result.registrationInfo;
    const { credential } = info;
    if (
      this.db
        .prepare("SELECT id FROM webauthn_lab_credentials WHERE id = ?")
        .get(credential.id)
    )
      throw new WebAuthnPrototypeError("CREDENTIAL_ALREADY_REGISTERED");
    this.db
      .prepare(`INSERT INTO webauthn_lab_credentials
      (id,subject_id,public_key,counter,device_type,backed_up,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(
        credential.id,
        context.subjectId,
        credential.publicKey,
        credential.counter,
        info.credentialDeviceType,
        Number(info.credentialBackedUp),
        this.now(),
      );
    return {
      status: "credential_registered",
      credentialId: credential.id,
      hardwareAttested: false,
      userVerified: info.userVerified,
    };
  }

  async beginAuthentication({ subjectId, sessionBinding }) {
    requireValue(subjectId);
    sessionHash(sessionBinding);
    const credentials = this.db
      .prepare(
        "SELECT id FROM webauthn_lab_credentials WHERE subject_id = ? AND revoked_at IS NULL",
      )
      .all(subjectId);
    if (!credentials.length)
      throw new WebAuthnPrototypeError("NO_ACTIVE_CREDENTIAL");
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: credentials,
      userVerification: "discouraged",
    });
    return {
      ceremonyId: this.issue(
        subjectId,
        sessionBinding,
        "authenticate",
        options.challenge,
      ),
      options,
    };
  }

  async finishAuthentication(context, response) {
    const challenge = this.consume(context, "authenticate");
    checkResponse(response);
    requireSameOriginContext(response);
    const credential = this.db
      .prepare(
        "SELECT * FROM webauthn_lab_credentials WHERE id = ? AND subject_id = ? AND revoked_at IS NULL",
      )
      .get(
        typeof response.id === "string" ? response.id : "",
        context.subjectId,
      );
    if (!credential) throw new WebAuthnPrototypeError("CREDENTIAL_UNAVAILABLE");
    const expectedHandle = createHash("sha256")
      .update(context.subjectId)
      .digest("base64url");
    if (
      response.response?.userHandle != null &&
      response.response.userHandle !== expectedHandle
    )
      throw new WebAuthnPrototypeError("INVALID_PROOF");
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: false,
        credential: {
          id: credential.id,
          publicKey: credential.public_key,
          counter: credential.counter,
        },
      });
    } catch {
      throw new WebAuthnPrototypeError("INVALID_PROOF");
    }
    if (
      !result.verified ||
      result.authenticationInfo.credentialBackedUp ||
      result.authenticationInfo.credentialDeviceType !== "singleDevice"
    )
      throw new WebAuthnPrototypeError("INVALID_PROOF");
    const changed = this.db
      .prepare(`UPDATE webauthn_lab_credentials SET counter = ?
      WHERE id = ? AND subject_id = ? AND counter = ? AND revoked_at IS NULL`)
      .run(
        result.authenticationInfo.newCounter,
        credential.id,
        context.subjectId,
        credential.counter,
      );
    if (changed.changes !== 1)
      throw new WebAuthnPrototypeError("CREDENTIAL_CHANGED_RETRY");
    return {
      status: "key_possession_verified",
      subjectId: context.subjectId,
      credentialId: credential.id,
      userVerified: result.authenticationInfo.userVerified,
      hardwareAttested: false,
    };
  }

  // Trusted server caller only; business authorization belongs to the gateway.
  revokeCredential({ subjectId, credentialId }) {
    const result = this.db
      .prepare(
        "UPDATE webauthn_lab_credentials SET revoked_at = ? WHERE id = ? AND subject_id = ? AND revoked_at IS NULL",
      )
      .run(this.now(), requireValue(credentialId), requireValue(subjectId));
    return result.changes === 1;
  }
}
