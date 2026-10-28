import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SharedSessionStore } from "../../src/auth-prototype/shared-session-store.mjs";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("shared sessions / real Supabase: restart, encryption rotation, concurrent refresh, stale writes and revocation", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local DEV-011A",
  timeout: 120000,
}, async () => {
  const env = JSON.parse(
    await readFile(process.env.TAMAGO_CUSTODY_TEST_ENV_FILE, "utf8"),
  );
  assert.equal(env.TEST_STACK, "tamago-dev011a");
  const f = await startRealCustodyFixture({ seedTransfers: false });
  const key1 = randomBytes(32),
    key2 = randomBytes(32),
    stores = [];
  let releaseContention;
  let contentionObserved = false;
  const contention = new Promise((resolve) => {
    releaseContention = resolve;
  });
  const tracedFetch = async (url, request) => {
    const response = await fetch(url, request);
    if (
      JSON.parse(request.body).p_command.operation === "claim" &&
      response.ok
    ) {
      const result = await response.clone().json();
      if (["busy", "conflict"].includes(result.status)) {
        contentionObserved = true;
        releaseContention();
      }
    }
    return response;
  };
  const config = {
    restUrl: env.REST_URL,
    publishableKey: env.PUBLISHABLE_KEY ?? env.ANON_KEY,
    serviceRoleKey: env.SERVICE_ROLE_KEY,
    encryptionKeys: { v1: key1, v2: key2 },
    activeKeyId: "v1",
    fetchImpl: tracedFetch,
  };
  const make = (extra = {}) => {
    const x = new SharedSessionStore({ ...config, ...extra });
    stores.push(x);
    return x;
  };
  const hash = () => createHash("sha256").update(randomBytes(32)).digest("hex");
  const session = (tokens = {}) => ({
    userId: f.users.warehouse.id,
    expiresAt: Date.now() + 3600000,
    accessExpiresAt: Date.now() + 600000,
    accessToken: tokens.access_token ?? "fictitious-access",
    refreshToken: tokens.refresh_token ?? "fictitious-refresh",
  });
  try {
    let a = make(),
      b = make();
    const id = hash();
    await a.create(id, session());
    const childProbe = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            fileURLToPath(
              new URL("../fixtures/shared-session-probe.mjs", import.meta.url),
            ),
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        let output = "";
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error("Child probe timed out"));
        }, 10000);
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.resume();
        child.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) reject(new Error("Child probe failed"));
          else
            try {
              resolve(JSON.parse(output));
            } catch {
              reject(new Error("Invalid probe output"));
            }
        });
        child.stdin.end(
          JSON.stringify({
            configuration: {
              restUrl: config.restUrl,
              publishableKey: config.publishableKey,
              serviceRoleKey: config.serviceRoleKey,
              encryptionKeys: { v1: key1.toString("base64") },
              activeKeyId: "v1",
            },
            sessionHash: id,
            accessDigest: createHash("sha256")
              .update("fictitious-access")
              .digest("hex"),
          }),
        );
      });
    for (let index = 0; index < 2; index++) {
      const probe = await childProbe();
      assert.equal(probe.userId, f.users.warehouse.id);
      assert.equal(probe.revision, 1);
      assert.equal(probe.contentMatches, true);
    }

    assert.equal((await b.get(id)).userId, f.users.warehouse.id);
    a.close();
    a = make();
    assert.equal((await a.get(id)).userId, f.users.warehouse.id);
    const before = await b.get(id);
    const newer = { ...before, accessToken: "updated-fictitious" };
    assert.equal(await a.saveTokens(newer), true);
    assert.equal(
      await b.saveTokens({ ...before, accessToken: "stale-fictitious" }),
      false,
    );
    assert.equal((await b.get(id)).accessToken === "updated-fictitious", true);
    const v2 = make({ activeKeyId: "v2" });
    assert.equal(await v2.saveTokens(await v2.get(id)), true);
    const onlyNew = make({ encryptionKeys: { v2: key2 }, activeKeyId: "v2" });
    assert.equal((await onlyNew.get(id)).userId, f.users.warehouse.id);
    const wrong = make({
      encryptionKeys: { v2: randomBytes(32) },
      activeKeyId: "v2",
    });
    await assert.rejects(wrong.get(id), /SHARED_SESSION_UNAVAILABLE/);
    assert.ok(await a.get(id));
    const oldId = hash();
    await a.create(oldId, session());
    await assert.rejects(onlyNew.get(oldId), /SHARED_SESSION_UNAVAILABLE/);
    // Real Auth tokens; only the adapter's local access-expiry hint is forced near
    // expiry. The provider refresh and actor verification remain genuine.
    const user = f.users.warehouse;
    const auth = await f.provider("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email: user.email, password: user.password },
      token: null,
    });
    const refreshingId = hash();
    await a.create(refreshingId, {
      ...session(auth),
      accessExpiresAt: Date.now() - 1000,
    });
    let calls = 0;
    const refresh = async (current, signal) => {
      calls++;
      let timer;
      try {
        await Promise.race([
          contention,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("No competing claim observed")),
              5000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      const response = await fetch(
        new URL("/auth/v1/token?grant_type=refresh_token", env.API_URL),
        {
          method: "POST",
          headers: {
            apikey: config.publishableKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ refresh_token: current.refreshToken }),
          signal,
        },
      );
      assert.equal(response.ok, true, "genuine provider refresh must succeed");
      const result = await response.json();
      assert.equal(result.user.id, current.userId);
      return {
        userId: result.user.id,
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        accessExpiresAt: Date.now() + result.expires_in * 1000,
      };
    };
    const [first, second] = await Promise.all([
      a.getFresh(refreshingId, refresh),
      b.getFresh(refreshingId, refresh),
    ]);
    assert.equal(calls, 1);
    assert.equal(contentionObserved, true);
    assert.ok(first && second);
    assert.equal(first.revision, second.revision);
    assert.equal(first.accessToken === second.accessToken, true);
    const confirm = await fetch(new URL("/auth/v1/user", env.API_URL), {
      headers: {
        apikey: config.publishableKey,
        authorization: `Bearer ${first.accessToken}`,
      },
    });
    assert.equal(confirm.ok, true);
    assert.equal((await confirm.json()).id, user.id);
    // A revoked session cannot be recreated or written by an in-flight refresh.
    const revId = hash();
    await a.create(revId, { ...session(), accessExpiresAt: Date.now() - 1 });
    let release, entered;
    const started = new Promise((r) => {
      entered = r;
    });
    const held = new Promise((r) => {
      release = r;
    });
    const late = a.getFresh(revId, async (current) => {
      entered();
      await held;
      return {
        ...current,
        accessToken: "late",
        refreshToken: "late-refresh",
        accessExpiresAt: Date.now() + 600000,
      };
    });
    await started;
    await b.revoke(revId);
    release();
    assert.equal(await late, null);
    assert.equal(await b.get(revId), null);
    await assert.rejects(
      a.create(revId, session()),
      /SHARED_SESSION_UNAVAILABLE/,
    );
    // Lost store response after a committed save cannot undo the new generation.
    const lostId = hash();
    await a.create(lostId, { ...session(), accessExpiresAt: Date.now() - 1 });
    let dropped = false;
    const lossy = make({
      fetchImpl: async (url, request) => {
        const response = await fetch(url, request);
        if (
          JSON.parse(request.body).p_command.operation === "save" &&
          !dropped
        ) {
          dropped = true;
          assert.equal(response.ok, true);
          throw new Error("response intentionally discarded");
        }
        return response;
      },
    });
    await assert.rejects(
      lossy.getFresh(lostId, async (current) => ({
        ...current,
        accessToken: "committed",
        refreshToken: "committed-refresh",
        accessExpiresAt: Date.now() + 600000,
      })),
      /SHARED_SESSION_UNAVAILABLE/,
    );
    assert.equal((await b.get(lostId)).accessToken === "committed", true);
    const failId = hash();
    await a.create(failId, { ...session(), accessExpiresAt: Date.now() - 1 });
    await assert.rejects(
      a.getFresh(failId, async () => {
        throw new Error("provider unavailable");
      }),
      /SHARED_SESSION_UNAVAILABLE/,
    );
    assert.equal(await b.get(failId), null);
    await b.revoke(id);
    assert.equal(await a.get(id), null);
  } finally {
    for (const store of stores) store.close();
    key1.fill(0);
    key2.fill(0);
    await f.close();
  }
});
