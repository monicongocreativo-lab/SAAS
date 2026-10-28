import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { makeServer } from "../../scripts/serve.mjs";

test("password vaults persist encrypted, isolate A/B unlock, reject overwrite, and recover after offline browser restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tamago-password-vault-"));
  const server = makeServer();
  let context;
  try {
    const bundle = await build({
      entryPoints: ["src/offline/password-key-vault.mjs"],
      bundle: true,
      format: "iife",
      globalName: "passwordVaultLab",
      write: false,
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/experimental/recogidas/`;
    const options = {
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    };
    context = await chromium.launchPersistentContext(directory, options);
    let page = await context.newPage();
    await page.goto(url);
    await page
      .locator("#offlineState")
      .filter({ hasText: "Pantalla preparada" })
      .waitFor();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const before = await page.evaluate(async () => {
      const a = {
        subject_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        device_id: "22222222-2222-4222-8222-222222222222",
      };
      const b = {
        ...a,
        subject_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      };
      const store = await passwordVaultLab.openPasswordVaultStore();
      try {
        localStorage.setItem(
          "tamago:password-vault-test:v1-sentinel",
          "preserved",
        );
        const va = await store.provision(a, "Ficticia-personal-A-2026");
        const vb = await store.provision(b, "Ficticia-personal-B-2026");
        let duplicate;
        try {
          await store.provision(a, "Ficticia-distinta-2026");
        } catch (error) {
          duplicate = error.code;
        }
        return { a, b, va, vb, duplicate, current: await store.read(a) };
      } finally {
        store.close();
      }
    });
    assert.equal(before.duplicate, "VAULT_NOT_SAVED");
    assert.deepEqual(before.current, before.va);
    assert.notEqual(before.va.thumbprint, before.vb.thumbprint);
    assert.equal(JSON.stringify(before).includes("Ficticia-personal"), false);
    await context.close();
    context = await chromium.launchPersistentContext(directory, {
      ...options,
      offline: true,
    });
    page = await context.newPage();
    await page.goto(url);
    // Test-only component injection: this checks IndexedDB/WebCrypto recovery,
    // not production caching or UI integration of this new module.
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const after = await page.evaluate(async ({ a, b }) => {
      const store = await passwordVaultLab.openPasswordVaultStore();
      try {
        let wrong;
        try {
          await store.unlock(a, "Ficticia-personal-B-2026");
        } catch (error) {
          wrong = error.code;
        }
        const sessionA = await store.unlock(a, "Ficticia-personal-A-2026");
        const sessionB = await store.unlock(b, "Ficticia-personal-B-2026");
        sessionA.lock();
        const rawDb = await new Promise((resolve, reject) => {
          const request = indexedDB.open("tamago-password-key-vault-lab-v1", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const rawRecords = await new Promise((resolve, reject) => {
          const request = rawDb
            .transaction("vaults")
            .objectStore("vaults")
            .getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        rawDb.close();
        sessionB.lock();
        return {
          va: await store.read(a),
          vb: await store.read(b),
          wrong,
          aLocked: sessionA.locked,
          bLocked: sessionB.locked,
          rawRecords,
          sentinel: localStorage.getItem(
            "tamago:password-vault-test:v1-sentinel",
          ),
        };
      } finally {
        store.close();
      }
    }, before);
    assert.deepEqual(after.va, before.va);
    assert.deepEqual(after.vb, before.vb);
    assert.equal(after.wrong, "VAULT_UNLOCK_FAILED");
    assert.equal(after.aLocked && after.bLocked, true);
    assert.equal(after.sentinel, "preserved");
    assert.equal(after.rawRecords.length, 2);
    assert.equal(
      after.rawRecords.every(
        (record) =>
          !record.privateKey &&
          !record.password &&
          typeof record.ciphertext === "string",
      ),
      true,
    );
  } finally {
    await context?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
