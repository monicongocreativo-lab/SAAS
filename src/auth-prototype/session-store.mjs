import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class DurableSessionStore {
  constructor({ databasePath, encryptionKey, now = () => Date.now() }) {
    if (!databasePath || databasePath === ":memory:")
      throw new Error("A durable session database path is required.");
    if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32)
      throw new Error("Session encryption key must be exactly 32 bytes.");

    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.encryptionKey = Buffer.from(encryptionKey);
    this.now = now;
    this.refreshing = new Map();
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS auth_sessions (
        session_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_nonce BLOB NOT NULL,
        token_tag BLOB NOT NULL,
        token_ciphertext BLOB NOT NULL,
        created_at INTEGER NOT NULL,
        access_expires_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        CHECK (expires_at > created_at)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS auth_sessions_expiration_idx
        ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS identity_provisionings (
        operation_id TEXT PRIMARY KEY,
        actor_user_id TEXT NOT NULL,
        company_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role_key TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('prepared', 'identity_created', 'complete', 'acknowledged', 'failed', 'recovery_required')),
        user_id TEXT,
        membership_id TEXT,
        credential_nonce BLOB,
        credential_tag BLOB,
        credential_ciphertext BLOB,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS identity_provisionings_actor_idx
        ON identity_provisionings(actor_user_id, created_at);
    `);
    this.insert = this.database.prepare(`
      INSERT INTO auth_sessions (
        session_hash, user_id, token_nonce, token_tag, token_ciphertext,
        created_at, access_expires_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.select = this.database.prepare(`
      SELECT session_hash, user_id, token_nonce, token_tag,
        token_ciphertext, created_at, access_expires_at, expires_at
      FROM auth_sessions WHERE session_hash = ?
    `);
    this.update = this.database.prepare(`
      UPDATE auth_sessions SET token_nonce = ?, token_tag = ?,
        token_ciphertext = ?, access_expires_at = ? WHERE session_hash = ?
    `);
    this.delete = this.database.prepare(
      "DELETE FROM auth_sessions WHERE session_hash = ?",
    );
    this.deleteExpired = this.database.prepare(
      "DELETE FROM auth_sessions WHERE expires_at <= ?",
    );
    this.insertProvisioning = this.database.prepare(`
      INSERT INTO identity_provisionings (
        operation_id, actor_user_id, company_id, email, role_key, status,
        credential_nonce, credential_tag, credential_ciphertext,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'prepared', ?, ?, ?, ?, ?)
    `);
    this.selectProvisioning = this.database.prepare(`
      SELECT * FROM identity_provisionings WHERE operation_id = ?
    `);
    this.selectPendingProvisionings = this.database.prepare(`
      SELECT * FROM identity_provisionings
      WHERE actor_user_id = ? AND company_id = ? AND status = 'complete'
      ORDER BY created_at ASC
    `);
    this.updateProvisioningStatement = this.database.prepare(`
      UPDATE identity_provisionings
      SET status = ?, user_id = COALESCE(?, user_id),
          membership_id = COALESCE(?, membership_id),
          updated_at = ?, credential_nonce = COALESCE(?, credential_nonce),
          credential_tag = COALESCE(?, credential_tag),
          credential_ciphertext = COALESCE(?, credential_ciphertext)
      WHERE operation_id = ?
    `);
    this.consumeProvisioningSecret = this.database.prepare(`
      UPDATE identity_provisionings
      SET status = 'acknowledged', credential_nonce = NULL,
          credential_tag = NULL, credential_ciphertext = NULL, updated_at = ?
      WHERE operation_id = ? AND actor_user_id = ? AND status = 'complete'
    `);
    this.failProvisioning = this.database.prepare(`
      UPDATE identity_provisionings
      SET status = ?, credential_nonce = NULL, credential_tag = NULL,
          credential_ciphertext = NULL, updated_at = ?
      WHERE operation_id = ?
    `);
  }

  create(sessionHash, session) {
    const encrypted = this.encryptTokens(
      sessionHash,
      session.userId,
      session.accessToken,
      session.refreshToken,
    );
    this.insert.run(
      sessionHash,
      session.userId,
      encrypted.nonce,
      encrypted.tag,
      encrypted.ciphertext,
      session.createdAt,
      session.accessExpiresAt,
      session.expiresAt,
    );
  }

  get(sessionHash) {
    const row = this.select.get(sessionHash);
    if (!row) return null;
    if (row.expires_at <= this.now()) {
      this.delete.run(sessionHash);
      return null;
    }
    const tokens = this.decryptTokens(row);
    return {
      sessionHash: row.session_hash,
      userId: row.user_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      accessExpiresAt: row.access_expires_at,
      ...tokens,
      refreshing: null,
    };
  }

  saveTokens(session) {
    const encrypted = this.encryptTokens(
      session.sessionHash,
      session.userId,
      session.accessToken,
      session.refreshToken,
    );
    this.update.run(
      encrypted.nonce,
      encrypted.tag,
      encrypted.ciphertext,
      session.accessExpiresAt,
      session.sessionHash,
    );
  }

  revoke(sessionHash) {
    this.delete.run(sessionHash);
  }

  createProvisioning({
    operationId,
    actorUserId,
    companyId,
    email,
    roleKey,
    temporaryPassword,
    now = this.now(),
  }) {
    const encrypted = this.encryptSecret(
      `provisioning:${operationId}:${actorUserId}`,
      temporaryPassword,
    );
    this.insertProvisioning.run(
      operationId,
      actorUserId,
      companyId,
      email,
      roleKey,
      encrypted.nonce,
      encrypted.tag,
      encrypted.ciphertext,
      now,
      now,
    );
  }

  getProvisioning(operationId, actorUserId) {
    const row = this.selectProvisioning.get(operationId);
    if (!row || row.actor_user_id !== actorUserId) return null;
    let temporaryPassword = null;
    if (row.credential_ciphertext) {
      temporaryPassword = this.decryptSecret(
        `provisioning:${operationId}:${actorUserId}`,
        row.credential_nonce,
        row.credential_tag,
        row.credential_ciphertext,
      );
    }
    return {
      operationId: row.operation_id,
      actorUserId: row.actor_user_id,
      companyId: row.company_id,
      email: row.email,
      roleKey: row.role_key,
      status: row.status,
      userId: row.user_id,
      membershipId: row.membership_id,
      temporaryPassword,
    };
  }

  listPendingProvisionings(actorUserId, companyId) {
    return this.selectPendingProvisionings
      .all(actorUserId, companyId)
      .map((row) => ({
        operationId: row.operation_id,
        actorUserId: row.actor_user_id,
        companyId: row.company_id,
        email: row.email,
        roleKey: row.role_key,
        status: row.status,
        userId: row.user_id,
        membershipId: row.membership_id,
        temporaryPassword: this.decryptSecret(
          `provisioning:${row.operation_id}:${actorUserId}`,
          row.credential_nonce,
          row.credential_tag,
          row.credential_ciphertext,
        ),
      }));
  }

  updateProvisioning(
    operationId,
    { status, userId, membershipId, now = this.now() },
  ) {
    this.updateProvisioningStatement.run(
      status,
      userId ?? null,
      membershipId ?? null,
      now,
      null,
      null,
      null,
      operationId,
    );
  }

  consumeProvisioning(operationId, actorUserId) {
    return (
      this.consumeProvisioningSecret.run(this.now(), operationId, actorUserId)
        .changes > 0
    );
  }

  markProvisioningFailed(operationId, status = "failed") {
    if (!["failed", "recovery_required"].includes(status))
      throw new Error("Invalid provisioning failure status.");
    this.failProvisioning.run(status, this.now(), operationId);
  }

  pruneExpired() {
    this.deleteExpired.run(this.now());
  }

  close() {
    this.database.close();
    this.encryptionKey.fill(0);
  }

  encryptTokens(sessionHash, userId, accessToken, refreshToken) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(`${sessionHash}:${userId}`, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ accessToken, refreshToken }), "utf8"),
      cipher.final(),
    ]);
    return { nonce, tag: cipher.getAuthTag(), ciphertext };
  }

  encryptSecret(aad, secret) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    const ciphertext = Buffer.concat([
      cipher.update(secret, "utf8"),
      cipher.final(),
    ]);
    return { nonce, tag: cipher.getAuthTag(), ciphertext };
  }

  decryptSecret(aad, nonce, tag, ciphertext) {
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }

  decryptTokens(row) {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        row.token_nonce,
      );
      decipher.setAAD(
        Buffer.from(`${row.session_hash}:${row.user_id}`, "utf8"),
      );
      decipher.setAuthTag(row.token_tag);
      const plaintext = Buffer.concat([
        decipher.update(row.token_ciphertext),
        decipher.final(),
      ]).toString("utf8");
      const tokens = JSON.parse(plaintext);
      if (
        typeof tokens.accessToken !== "string" ||
        typeof tokens.refreshToken !== "string"
      )
        throw new Error("invalid token record");
      return tokens;
    } catch {
      this.delete.run(row.session_hash);
      throw new Error("Unable to decrypt durable session.");
    }
  }
}
