import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { SharedSessionStore } from "../src/auth-prototype/shared-session-store.mjs";

const hash = "a".repeat(64),
  key = randomBytes(32),
  now = Date.now();
const options = {
  restUrl: "http://localhost/rest/v1/",
  publishableKey: "synthetic-public",
  serviceRoleKey: "synthetic-service",
  encryptionKeys: { v1: key },
  activeKeyId: "v1",
  now: () => now,
};
const session = {
  userId: randomUUID(),
  expiresAt: now + 3600000,
  accessExpiresAt: now + 600000,
  accessToken: "synthetic-access",
  refreshToken: "synthetic-refresh",
};
function fixture() {
  let stored;
  const store = new SharedSessionStore({
    ...options,
    fetchImpl: async (url, request) => {
      assert.equal(url.pathname, "/rest/v1/rpc/gateway_session_command");
      assert.equal(request.headers.authorization, "Bearer synthetic-service");
      const body = JSON.parse(request.body).p_command;
      if (body.operation === "create") {
        assert.equal(JSON.stringify(body).includes("synthetic-access"), false);
        assert.equal(JSON.stringify(body).includes("synthetic-refresh"), false);
        stored = {
          session_hash: body.session_hash,
          user_id: body.user_id,
          envelope: body.envelope,
          expires_at: body.expires_at,
          access_expires_at: body.access_expires_at,
          created_at: new Date(now).toISOString(),
          revision: 1,
        };
        return Response.json({ status: "created", revision: 1 });
      }
      return Response.json({ status: "present", session: stored });
    },
  });
  return { store, row: () => stored };
}
test("shared session encryption keeps tokens out of storage RPC and survives adapter restart", async () => {
  const { store, row } = fixture();
  await store.create(hash, session);
  assert.equal((await store.get(hash)).userId, session.userId);
  const other = new SharedSessionStore({
    ...options,
    fetchImpl: async () => Response.json({ status: "present", session: row() }),
  });
  assert.equal(
    (await other.get(hash)).refreshToken === session.refreshToken,
    true,
  );
  store.close();
  assert.equal(
    (await other.get(hash)).accessToken === session.accessToken,
    true,
  );
  other.close();
});
test("shared session ciphertext rejects changed hash, owner, expiry, version, key or payload without deleting original", async () => {
  const { store, row } = fixture();
  await store.create(hash, session);
  for (const change of [
    (r) => (r.session_hash = "b".repeat(64)),
    (r) => (r.user_id = randomUUID()),
    (r) => (r.expires_at = new Date(now + 7200000).toISOString()),
    (r) => (r.envelope.version = 2),
    (r) => (r.envelope.key_id = "missing"),
    (r) => (r.envelope.tag = "A".repeat(22)),
    (r) => (r.envelope.ciphertext = "AA"),
  ]) {
    const altered = structuredClone(row());
    change(altered);
    const other = new SharedSessionStore({
      ...options,
      fetchImpl: async () =>
        Response.json({ status: "present", session: altered }),
    });
    await assert.rejects(other.get(hash), /SHARED_SESSION_UNAVAILABLE/);
    other.close();
  }
  assert.equal((await store.get(hash)).userId, session.userId);
  store.close();
});
test("shared session adapter rejects insecure endpoints, unavailable storage and malformed receipts without leaking provider details", async () => {
  assert.throws(
    () =>
      new SharedSessionStore({
        ...options,
        restUrl: "http://external.invalid/rest/v1",
      }),
  );
  assert.throws(
    () =>
      new SharedSessionStore({
        ...options,
        encryptionKeys: { v1: Buffer.alloc(1) },
      }),
  );
  const store = new SharedSessionStore({
    ...options,
    fetchImpl: async () =>
      Response.json({ message: "private detail" }, { status: 503 }),
  });
  await assert.rejects(
    store.get(hash),
    (e) => e.message === "SHARED_SESSION_UNAVAILABLE",
  );
  store.close();
  await assert.rejects(store.get(hash), /SHARED_SESSION_UNAVAILABLE/);
});
