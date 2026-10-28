import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DurableSessionStore } from "../../src/auth-prototype/session-store.mjs";

const directory = mkdtempSync(join(tmpdir(), "tamago-session-store-"));
chmodSync(directory, 0o700);
const databasePath = join(directory, "sessions.sqlite");
const encryptionKey = randomBytes(32);
const sessionHash = "a".repeat(64);
const fixture = {
  userId: "10000000-0000-4000-8000-000000000001",
  accessToken: "synthetic-access-token-do-not-store-in-plaintext",
  refreshToken: "synthetic-refresh-token-do-not-store-in-plaintext",
  accessExpiresAt: 10_000,
  createdAt: 100,
  expiresAt: 9_000,
};

after(() => {
  encryptionKey.fill(0);
  rmSync(directory, { recursive: true, force: true });
});

test("encrypted sessions survive store reopen and remain private on disk", () => {
  const first = new DurableSessionStore({
    databasePath,
    encryptionKey,
    now: () => 200,
  });
  first.create(sessionHash, fixture);
  first.close();

  assert.equal(statSync(databasePath).mode & 0o777, 0o600);
  const persisted = readFileSync(databasePath);
  assert.equal(persisted.includes(Buffer.from(fixture.accessToken)), false);
  assert.equal(persisted.includes(Buffer.from(fixture.refreshToken)), false);

  const reopened = new DurableSessionStore({
    databasePath,
    encryptionKey,
    now: () => 300,
  });
  assert.deepEqual(reopened.get(sessionHash), {
    sessionHash,
    userId: fixture.userId,
    createdAt: fixture.createdAt,
    expiresAt: fixture.expiresAt,
    accessExpiresAt: fixture.accessExpiresAt,
    accessToken: fixture.accessToken,
    refreshToken: fixture.refreshToken,
    refreshing: null,
  });
  reopened.close();
});

test("an unavailable encryption key makes a durable session unusable", () => {
  const wrongKey = randomBytes(32);
  const store = new DurableSessionStore({
    databasePath,
    encryptionKey: wrongKey,
    now: () => 400,
  });
  assert.throws(() => store.get(sessionHash), /Unable to decrypt durable session/);
  assert.equal(store.get(sessionHash), null);
  store.close();
  wrongKey.fill(0);
});

test("expired durable sessions are deleted when read and on pruning", () => {
  const store = new DurableSessionStore({
    databasePath,
    encryptionKey,
    now: () => 1_000,
  });
  store.create(sessionHash, { ...fixture, expiresAt: 900 });
  assert.equal(store.get(sessionHash), null);
  store.create(sessionHash, { ...fixture, expiresAt: 950 });
  store.pruneExpired();
  assert.equal(store.get(sessionHash), null);
  store.close();
});

test("temporary credentials survive restart encrypted and are deleted after handoff acknowledgement", () => {
  const operationId = "70000000-0000-4000-8000-000000000007";
  const actorUserId = "10000000-0000-4000-8000-000000000001";
  const temporaryPassword = "synthetic-temporary-password-never-log";
  const first = new DurableSessionStore({
    databasePath,
    encryptionKey,
    now: () => 2_000,
  });
  first.createProvisioning({
    operationId,
    actorUserId,
    companyId: "a0000000-0000-4000-8000-000000000001",
    email: "field@example.invalid",
    roleKey: "capture",
    temporaryPassword,
  });
  first.updateProvisioning(operationId, {
    status: "complete",
    userId: "20000000-0000-4000-8000-000000000002",
    membershipId: "30000000-0000-4000-8000-000000000003",
  });
  first.close();

  assert.equal(readFileSync(databasePath).includes(Buffer.from(temporaryPassword)), false);
  const reopened = new DurableSessionStore({
    databasePath,
    encryptionKey,
    now: () => 3_000,
  });
  assert.deepEqual(reopened.getProvisioning(operationId, actorUserId), {
    operationId,
    actorUserId,
    companyId: "a0000000-0000-4000-8000-000000000001",
    email: "field@example.invalid",
    roleKey: "capture",
    status: "complete",
    userId: "20000000-0000-4000-8000-000000000002",
    membershipId: "30000000-0000-4000-8000-000000000003",
    temporaryPassword,
  });
  assert.equal(reopened.consumeProvisioning(operationId, "40000000-0000-4000-8000-000000000004"), false);
  assert.equal(reopened.consumeProvisioning(operationId, actorUserId), true);
  assert.equal(reopened.getProvisioning(operationId, actorUserId).temporaryPassword, null);
  assert.equal(reopened.consumeProvisioning(operationId, actorUserId), false);
  reopened.close();
});
