import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const HASH = /^[0-9a-f]{64}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const failure = () => new Error("SHARED_SESSION_UNAVAILABLE");
// Experimental backend-only adapter. Never instantiate with secrets in a browser.
// This is not wired into the existing gateway until all local state is adapted.
export class SharedSessionStore {
  constructor({
    restUrl,
    publishableKey,
    serviceRoleKey,
    encryptionKeys,
    activeKeyId,
    fetchImpl = fetch,
    now = () => Date.now(),
  }) {
    const base = new URL(restUrl);
    if (
      base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
      )
    )
      throw failure();
    if (
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !publishableKey ||
      !serviceRoleKey ||
      !encryptionKeys ||
      !/^[A-Za-z0-9._-]{1,64}$/.test(activeKeyId ?? "")
    )
      throw failure();
    this.keys = new Map();
    for (const [id, key] of Object.entries(encryptionKeys)) {
      if (
        !/^[A-Za-z0-9._-]{1,64}$/.test(id) ||
        !Buffer.isBuffer(key) ||
        key.length !== 32
      )
        throw failure();
      this.keys.set(id, Buffer.from(key));
    }
    if (!this.keys.has(activeKeyId)) throw failure();
    this.activeKeyId = activeKeyId;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.url = new URL(
      "rpc/gateway_session_command",
      base.href.endsWith("/") ? base : new URL(`${base.href}/`),
    );
    this.headers = {
      apikey: publishableKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
    };
    this.closed = false;
  }
  async command(body) {
    if (this.closed || !HASH.test(body.session_hash ?? "")) throw failure();
    try {
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({ p_command: body }),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw failure();
      const value = await response.json();
      if (!value || typeof value.status !== "string") throw failure();
      return value;
    } catch {
      throw failure();
    }
  }
  context(sessionHash, userId, expiresAt) {
    return Buffer.from(
      `tamago.gateway-session.v1:${sessionHash}:${userId}:${expiresAt}`,
    );
  }
  encrypt(sessionHash, session) {
    if (
      !UUID.test(session.userId ?? "") ||
      !Number.isSafeInteger(session.expiresAt) ||
      !Number.isSafeInteger(session.accessExpiresAt) ||
      typeof session.accessToken !== "string" ||
      !session.accessToken ||
      typeof session.refreshToken !== "string" ||
      !session.refreshToken ||
      session.accessToken.length > 8192 ||
      session.refreshToken.length > 8192
    )
      throw failure();
    const nonce = randomBytes(12),
      cipher = createCipheriv(
        "aes-256-gcm",
        this.keys.get(this.activeKeyId),
        nonce,
      );
    cipher.setAAD(this.context(sessionHash, session.userId, session.expiresAt));
    const content = Buffer.from(
      JSON.stringify({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      }),
    );
    if (content.length > 16000) throw failure();
    const ciphertext = Buffer.concat([cipher.update(content), cipher.final()]);
    content.fill(0);
    return {
      version: 1,
      key_id: this.activeKeyId,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    };
  }
  decode(hash, row) {
    try {
      if (
        row?.session_hash !== hash ||
        !UUID.test(row.user_id ?? "") ||
        !Number.isSafeInteger(row.revision) ||
        row.revision < 1
      )
        throw failure();
      const expiresAt = Date.parse(row.expires_at),
        createdAt = Date.parse(row.created_at),
        accessExpiresAt = Date.parse(row.access_expires_at);
      if (
        !Number.isSafeInteger(expiresAt) ||
        !Number.isSafeInteger(createdAt) ||
        !Number.isSafeInteger(accessExpiresAt) ||
        expiresAt <= createdAt ||
        expiresAt <= this.now()
      )
        throw failure();
      const envelope = row.envelope,
        key = this.keys.get(envelope?.key_id);
      if (
        !key ||
        envelope.version !== 1 ||
        !/^[A-Za-z0-9_-]{16}$/.test(envelope.nonce ?? "") ||
        !/^[A-Za-z0-9_-]{22}$/.test(envelope.tag ?? "") ||
        !/^[A-Za-z0-9_-]{1,22000}$/.test(envelope.ciphertext ?? "")
      )
        throw failure();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(envelope.nonce, "base64url"),
      );
      decipher.setAAD(this.context(hash, row.user_id, expiresAt));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
        decipher.final(),
      ]);
      let tokens;
      try {
        tokens = JSON.parse(plain.toString("utf8"));
      } finally {
        plain.fill(0);
      }
      if (
        Object.keys(tokens).sort().join() !== "accessToken,refreshToken" ||
        typeof tokens.accessToken !== "string" ||
        !tokens.accessToken ||
        typeof tokens.refreshToken !== "string" ||
        !tokens.refreshToken
      )
        throw failure();
      return {
        sessionHash: hash,
        userId: row.user_id,
        createdAt,
        expiresAt,
        accessExpiresAt,
        revision: row.revision,
        ...tokens,
      };
    } catch {
      throw failure();
    }
  }
  async create(sessionHash, session) {
    const envelope = this.encrypt(sessionHash, session);
    const result = await this.command({
      operation: "create",
      session_hash: sessionHash,
      user_id: session.userId,
      expires_at: new Date(session.expiresAt).toISOString(),
      access_expires_at: new Date(session.accessExpiresAt).toISOString(),
      envelope,
    });
    if (result.status !== "created" || result.revision !== 1) throw failure();
  }
  async get(sessionHash) {
    const result = await this.command({
      operation: "read",
      session_hash: sessionHash,
    });
    if (result.status === "absent") return null;
    if (result.status !== "present") throw failure();
    return this.decode(sessionHash, result.session);
  }
  async revoke(sessionHash) {
    const result = await this.command({
      operation: "revoke",
      session_hash: sessionHash,
    });
    if (!["revoked", "absent"].includes(result.status)) throw failure();
  }
  async claim(session) {
    const leaseId = randomUUID();
    const result = await this.command({
      operation: "claim",
      session_hash: session.sessionHash,
      expected_revision: session.revision,
      lease_id: leaseId,
    });
    if (["absent", "conflict", "busy"].includes(result.status))
      return { status: result.status };
    if (result.status !== "claimed" || result.lease_id !== leaseId)
      throw failure();
    return {
      status: "claimed",
      leaseId,
      session: this.decode(session.sessionHash, result.session),
    };
  }
  async saveTokens(session, { leaseId = null } = {}) {
    const result = await this.command({
      operation: "save",
      session_hash: session.sessionHash,
      expected_revision: session.revision,
      lease_id: leaseId,
      access_expires_at: new Date(session.accessExpiresAt).toISOString(),
      envelope: this.encrypt(session.sessionHash, session),
    });
    if (["absent", "conflict", "busy"].includes(result.status)) return false;
    if (result.status !== "saved" || result.revision !== session.revision + 1)
      throw failure();
    return true;
  }
  async invalidateClaim(session, leaseId) {
    const result = await this.command({
      operation: "invalidate",
      session_hash: session.sessionHash,
      expected_revision: session.revision,
      lease_id: leaseId,
    });
    if (!["revoked", "absent", "conflict"].includes(result.status))
      throw failure();
  }
  // refresh receives genuine provider tokens and an AbortSignal; caller must verify
  // provider response, actor and duration. This adapter never manufactures identity.
  async getFresh(
    sessionHash,
    refresh,
    { marginMs = 60000, waitMs = 2000 } = {},
  ) {
    if (
      !Number.isFinite(marginMs) ||
      marginMs < 0 ||
      marginMs > 3600000 ||
      !Number.isFinite(waitMs) ||
      waitMs < 0 ||
      waitMs > 5000
    )
      throw failure();
    const deadline = Date.now() + waitMs;
    while (true) {
      const session = await this.get(sessionHash);
      if (!session) return null;
      if (session.accessExpiresAt - this.now() > marginMs) return session;
      const claim = await this.claim(session);
      if (claim.status === "absent") return null;
      if (claim.status === "claimed") {
        const current = claim.session;
        try {
          const renewed = await refresh(
            { ...current },
            AbortSignal.timeout(20000),
          );
          if (
            !renewed ||
            renewed.userId !== current.userId ||
            !Number.isSafeInteger(renewed.accessExpiresAt) ||
            renewed.accessExpiresAt <= this.now()
          )
            throw failure();
          const next = {
            ...current,
            accessToken: renewed.accessToken,
            refreshToken: renewed.refreshToken,
            accessExpiresAt: renewed.accessExpiresAt,
          };
          if (!(await this.saveTokens(next, { leaseId: claim.leaseId })))
            return null;
          return await this.get(sessionHash);
        } catch {
          // Conservatively end only our own generation after an uncertain refresh.
          // A newer owner or a successful save is never invalidated by this callback.
          await this.invalidateClaim(current, claim.leaseId).catch(() => {});
          throw failure();
        }
      }
      if (Date.now() >= deadline) throw new Error("SHARED_SESSION_BUSY");
      await delay(25);
    }
  }
  close() {
    this.closed = true;
    for (const key of this.keys.values()) key.fill(0);
    this.keys.clear();
    this.headers = {};
  }
}
