import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { chromium } from "playwright";
import { makeServer } from "../../scripts/serve.mjs";

test("encrypted queue is atomic, retry-safe, scope isolated and rejects altered ciphertext without losing originals", async () => {
  const server = makeServer();
  let browser;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    browser = await chromium.launch({
      headless: true,
      ...(process.env.TAMAGO_BROWSER_CHANNEL
        ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
        : {}),
    });
    const page = await browser.newPage();
    await page.goto(
      `http://127.0.0.1:${server.address().port}/experimental/recogidas/collection-export.v1.schema.json`,
    );
    const bundle = await build({
      entryPoints: ["tests/fixtures/protected-queue-harness.mjs"],
      bundle: true,
      format: "iife",
      globalName: "protectedQueueHarness",
      write: false,
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const result = await page.evaluate(async () => {
      const h = protectedQueueHarness;
      const contextA = {
        subject_user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        device_id: "22222222-2222-4222-8222-222222222222",
      };
      const contextB = {
        ...contextA,
        subject_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      };
      const a = await h.createPasswordVault(
        contextA,
        "Ficticia-personal-A-2026",
      );
      const b = await h.createPasswordVault(
        contextB,
        "Ficticia-personal-B-2026",
      );
      const sessionA = await h.unlockPasswordVault(
        a,
        contextA,
        "Ficticia-personal-A-2026",
      );
      const sessionB = await h.unlockPasswordVault(
        b,
        contextB,
        "Ficticia-personal-B-2026",
      );
      let queue = await h.openProtectedCollectionQueue();
      const grantA = {
        ...contextA,
        company_id: "11111111-1111-4111-8111-111111111111",
        site_id: "33333333-3333-4333-8333-333333333333",
        house_id: "44444444-4444-4444-8444-444444444444",
        lot_id: "55555555-5555-4555-8555-555555555555",
        grant_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        permission: "collection.capture",
        signature_verified: true,
        grant_state: "current",
        device_key_thumbprint: a.thumbprint,
      };
      const grantB = {
        ...grantA,
        ...contextB,
        grant_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        device_key_thumbprint: b.thumbprint,
      };
      const occurred = new Date().toISOString();
      const event = {
        schema_version: 2,
        event_id: crypto.randomUUID(),
        company_id: grantA.company_id,
        site_id: grantA.site_id,
        house_id: grantA.house_id,
        lot_id: grantA.lot_id,
        business_date: new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Bogota",
        }).format(new Date(occurred)),
        occurrence: 1,
        quantity_eggs: 413,
        occurred_at: occurred,
        captured_at: occurred,
        actor_declared_id: contextA.subject_user_id,
        device_id: contextA.device_id,
      };
      const makeRecord = async (value, grant = grantA, session = sessionA) => ({
        event: value,
        identity_binding: {
          grant_id: grant.grant_id,
          subject_user_id: grant.subject_user_id,
          attribution_status: "pending_server_verification",
        },
        device_proof: await session.createEventProof(value, grant),
        delivery: { status: "pending" },
      });
      const record = await makeRecord(event);
      const saved = await Promise.all([
        queue.save(record, grantA, sessionA),
        queue.save(record, grantA, sessionA),
      ]);
      const errorCode = async (action) => {
        try {
          await action();
          return "NO_ERROR";
        } catch (failure) {
          return failure.code ?? failure.message;
        }
      };
      const changed = await makeRecord({ ...event, quantity_eggs: 999 });
      const conflict = await errorCode(() =>
        queue.save(changed, grantA, sessionA),
      );
      const duplicate = await makeRecord({
        ...event,
        event_id: crypto.randomUUID(),
      });
      const occurrence = await errorCode(() =>
        queue.save(duplicate, grantA, sessionA),
      );
      const other = await queue.export(grantB, sessionB);
      const otherCompany = await queue.export(
        { ...grantA, company_id: "99999999-9999-4999-8999-999999999999" },
        sessionA,
      );
      const renewedRecord = await makeRecord(event, {
        ...grantA,
        grant_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      });
      const replay = await queue.save(
        renewedRecord,
        { ...grantA, grant_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
        sessionA,
      );
      const before = await queue.export(grantA, sessionA);
      queue.close();
      queue = await h.openProtectedCollectionQueue();
      const reopened = await queue.export(grantA, sessionA);
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("tamago-protected-collections-lab-v1");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = (store, callback) =>
        new Promise((resolve, reject) => {
          const tx = database.transaction(store, "readwrite");
          callback(tx.objectStore(store));
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
      const get = () =>
        new Promise((resolve, reject) => {
          const request = database
            .transaction("events")
            .objectStore("events")
            .get(event.event_id);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const original = await get();
      const corrupted = structuredClone(original);
      corrupted.sealed.metadata.occurrence = 3;
      await transaction("events", (store) => store.put(corrupted));
      const tampered = await errorCode(() => queue.export(grantA, sessionA));
      await transaction("events", (store) => store.put(original));
      const originalAdd = IDBObjectStore.prototype.add;
      const second = await makeRecord({
        ...event,
        event_id: crypto.randomUUID(),
        occurrence: 2,
      });
      let storageFailure;
      try {
        IDBObjectStore.prototype.add = function (...args) {
          if (
            this.name === "outbox" &&
            this.transaction.db.name === "tamago-protected-collections-lab-v1"
          )
            throw new DOMException(
              "Synthetic disk failure",
              "QuotaExceededError",
            );
          return originalAdd.apply(this, args);
        };
        storageFailure = await errorCode(() =>
          queue.save(second, grantA, sessionA),
        );
      } finally {
        IDBObjectStore.prototype.add = originalAdd;
      }
      const afterFailure = await queue.export(grantA, sessionA);
      const counts = await Promise.all(
        ["events", "outbox"].map(
          (name) =>
            new Promise((resolve) => {
              const request = database
                .transaction(name)
                .objectStore(name)
                .count();
              request.onsuccess = () => resolve(request.result);
            }),
        ),
      );
      const raw = await get();
      database.close();
      queue.close();
      await new Promise((resolve, reject) => {
        const deletion = indexedDB.deleteDatabase(
          "tamago-protected-collections-lab-v1",
        );
        deletion.onsuccess = resolve;
        deletion.onerror = () => reject(deletion.error);
      });
      await new Promise((resolve, reject) => {
        const request = indexedDB.open(
          "tamago-protected-collections-lab-v1",
          1,
        );
        request.onupgradeneeded = () => {
          const database = request.result;
          const events = database.createObjectStore("events", {
            keyPath: "event_id",
          });
          events.createIndex(
            "occurrence",
            ["company_id", "lot_id", "house_id", "business_date", "occurrence"],
            { unique: true },
          );
          events.createIndex("actor_scope", [
            "subject_user_id",
            "device_id",
            "company_id",
            "site_id",
            "house_id",
            "lot_id",
          ]);
          events.add(raw);
          database
            .createObjectStore("outbox", { keyPath: "event_id" })
            .add({ event_id: raw.event_id, status: "pending" });
        };
        request.onsuccess = () => {
          request.result.close();
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
      queue = await h.openProtectedCollectionQueue();
      const migrated = await queue.export(grantA, sessionA);
      const migratedDelivery = await queue.deliveries(grantA, sessionA);
      queue.close();
      sessionA.lock();
      sessionB.lock();
      return {
        savedSame: JSON.stringify(saved[0]) === JSON.stringify(saved[1]),
        conflict,
        occurrence,
        otherCount: other.records.length,
        otherCompanyCount: otherCompany.records.length,
        replay,
        before,
        migrated,
        migratedStatus: migratedDelivery[0].status,
        reopened,
        tampered,
        storageFailure,
        afterFailure,
        counts,
        rawHasNoEvent:
          !raw.event &&
          !raw.quantity_eggs &&
          typeof raw.sealed.ciphertext === "string",
      };
    });
    assert.equal(result.savedSame, true);
    assert.equal(result.conflict, "PROTECTED_QUEUE_EVENT_CONFLICT");
    assert.equal(result.occurrence, "PROTECTED_QUEUE_OCCURRENCE_CONFLICT");
    assert.equal(result.otherCount, 0);
    assert.equal(result.otherCompanyCount, 0);
    assert.deepEqual(result.replay, result.before.records[0]);
    assert.deepEqual(result.reopened, result.before);
    assert.deepEqual(result.migrated, result.before);
    assert.equal(result.migratedStatus, "pending");
    assert.equal(result.tampered, "VAULT_LOCAL_PAYLOAD_INVALID");
    assert.equal(result.storageFailure, "PROTECTED_QUEUE_NOT_SAVED");
    assert.deepEqual(result.afterFailure, result.before);
    assert.deepEqual(result.counts, [1, 1]);
    assert.equal(result.rawHasNoEvent, true);
  } finally {
    await browser?.close();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
});
