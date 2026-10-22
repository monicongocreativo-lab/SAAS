import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium } from "playwright";
import { makeServer } from "../../scripts/serve.mjs";
import { assertPackage } from "../../src/offline/contract.mjs";

const server = makeServer();
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
const bundle = await build({
  entryPoints: [
    fileURLToPath(new URL("../fixtures/offline-harness.mjs", import.meta.url)),
  ],
  bundle: true,
  format: "iife",
  write: false,
});
const harness = async (page) =>
  page.addScriptTag({ content: bundle.outputFiles[0].text });
const ready = async (page) => {
  await page
    .locator("#offlineState")
    .filter({ hasText: "Pantalla preparada" })
    .waitFor();
  await page.locator("#save").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector("#fields").disabled);
};
const snapshot = (page) =>
  page.evaluate(async () => {
    const h = globalThis.offlineHarness;
    const db = await h.openStore();
    try {
      return await h.readPackage(db);
    } finally {
      db.close();
    }
  });
const fill = async (page) => {
  await page.locator('[name="business_date"]').fill("2026-10-21");
  await page.locator('[name="time"]').fill("17:30");
  await page.locator('[name="quantity_eggs"]').fill("7200");
};
const exportFile = async (page) => {
  const download = page.waitForEvent("download");
  await page.locator("#export").click();
  return JSON.parse(await readFile(await (await download).path(), "utf8"));
};
let browser;
try {
  browser = await chromium.launch(options);
  await test("offline capture, real browser process restart, exact pending recovery and repeatable export; v1 untouched", async () => {
    const profile = await mkdtemp(join(tmpdir(), "tamago-dev002-"));
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        ...options,
        viewport: { width: 1280, height: 1000 },
        timezoneId: "Asia/Tokyo",
        acceptDownloads: true,
      });
      let page = await context.newPage();
      await page.goto(url);
      await ready(page);
      await harness(page);
      const v1 = {
        "tamago:pilot:v1:field":
          '{"schemaVersion":1,"syntheticSentinel":"no-modificar"}',
        "tamago:pilot:v1:demo": "ficticio-byte-a-byte",
      };
      await page.evaluate((values) => {
        for (const [k, v] of Object.entries(values)) localStorage.setItem(k, v);
      }, v1);
      await context.setOffline(true);
      await page.reload();
      await ready(page);
      await harness(page);
      await fill(page);
      await page.evaluate(() => {
        const f = document.querySelector("#capture");
        f.dispatchEvent(new Event("submit", { cancelable: true }));
        f.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      await page
        .locator("#notice")
        .filter({ hasText: "Guardado local confirmado" })
        .waitFor();
      const before = await snapshot(page);
      assertPackage(before);
      assert.equal(before.records.length, 1);
      const first = await exportFile(page);
      const second = await exportFile(page);
      assert.deepEqual(first, before);
      assert.deepEqual(second, before);
      await writeFile(
        "/private/tmp/tamago-dev002-export.json",
        JSON.stringify(first, null, 2),
      );
      assert.deepEqual(await snapshot(page), before);
      await page.screenshot({
        path: "/private/tmp/tamago-dev002-desktop.png",
        fullPage: true,
      });
      await context.close();
      context = null;
      context = await chromium.launchPersistentContext(profile, {
        ...options,
        offline: true,
        viewport: { width: 390, height: 844 },
        acceptDownloads: true,
      });
      page = await context.newPage();
      await page.goto(url);
      await ready(page);
      await harness(page);
      assert.deepEqual(await snapshot(page), before);
      for (const [key, value] of Object.entries(v1))
        assert.equal(
          await page.evaluate((k) => localStorage.getItem(k), key),
          value,
        );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      assert.match(
        await page.locator("#records").textContent(),
        /pendiente de envío/,
      );
      await page.screenshot({
        path: "/private/tmp/tamago-dev002-mobile.png",
        fullPage: true,
      });
      // Re-import into the same storage twice: zero new events.
      for (let i = 0; i < 2; i++) {
        await page.locator("#restore").setInputFiles({
          name: "ficticio.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(first)),
        });
        await page.locator("#notice").filter({ hasText: "0 nuevos" }).waitFor();
      }
      assert.deepEqual(await snapshot(page), before);
      // Restore into a fresh context, then conflict must preserve the existing event.
      const recovery = await browser.newContext();
      try {
        const target = await recovery.newPage();
        await target.goto(url);
        await ready(target);
        await harness(target);
        await target.locator("#restore").setInputFiles({
          name: "ficticio.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(first)),
        });
        await target
          .locator("#notice")
          .filter({ hasText: "1 nuevos" })
          .waitFor();
        assert.deepEqual(await snapshot(target), before);
        const altered = structuredClone(first);
        altered.records[0].event.quantity_eggs++;
        await target.locator("#restore").setInputFiles({
          name: "conflicto.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(altered)),
        });
        await target
          .locator("#error")
          .filter({ hasText: "EVENT_ID_CONFLICT" })
          .waitFor();
        assert.deepEqual(await snapshot(target), before);
        const bad = structuredClone(first);
        bad.schema_version = 999;
        await target.locator("#restore").setInputFiles({
          name: "version.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(bad)),
        });
        await target
          .locator("#error")
          .filter({ hasText: "INVALID_FIELDS" })
          .waitFor();
        assert.deepEqual(await snapshot(target), before);
      } finally {
        await recovery.close();
      }
    } finally {
      await context?.close();
      await rm(profile, { recursive: true, force: true });
    }
  });

  await test("outbox write failure rolls back event; visible error, retained form, successful retry; occurrence conflicts across tabs", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(url);
      await ready(page);
      await harness(page);
      await fill(page);
      await page.evaluate(() => {
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args) {
          if (this.name === "events")
            globalThis.failedAttemptId = args[0].event_id;
          if (this.name === "outbox") {
            IDBObjectStore.prototype.add = original;
            throw new DOMException(
              "Fallo de cuota inyectado solo en contexto temporal",
              "QuotaExceededError",
            );
          }
          return original.apply(this, args);
        };
      });
      await page.locator("#save").click();
      await page
        .locator("#error")
        .filter({ hasText: "Fallo de cuota" })
        .waitFor();
      assert.equal(await page.locator("#notice").textContent(), "");
      assert.equal(
        await page.locator('[name="quantity_eggs"]').inputValue(),
        "7200",
      );
      assert.equal((await snapshot(page)).records.length, 0);
      await page.screenshot({
        path: "/private/tmp/tamago-dev002-storage-error.png",
        fullPage: true,
      });
      await page.locator("#save").click();
      await page
        .locator("#notice")
        .filter({ hasText: "Guardado local confirmado" })
        .waitFor();
      const saved = await snapshot(page);
      assert.equal(saved.records.length, 1);
      assert.equal(
        saved.records[0].event.event_id,
        await page.evaluate(() => globalThis.failedAttemptId),
      );
      const other = await context.newPage();
      await other.goto(url);
      await ready(other);
      await harness(other);
      await fill(other);
      await other.locator("#save").click();
      await other
        .locator("#error")
        .filter({ hasText: "OCCURRENCE_CONFLICT" })
        .waitFor();
      assert.equal(await other.locator("#notice").textContent(), "");
      assert.deepEqual(await snapshot(other), saved);
      await other.screenshot({
        path: "/private/tmp/tamago-dev002-conflict.png",
        fullPage: true,
      });
      // Retry exact same ID is idempotent, concurrent calls serialize at IndexedDB.
      const added = await page.evaluate(async (value) => {
        const h = globalThis.offlineHarness;
        const db = await h.openStore();
        try {
          return await Promise.all([
            h.savePackage(db, value),
            h.savePackage(db, value),
          ]);
        } finally {
          db.close();
        }
      }, saved);
      assert.deepEqual(added, [0, 0]);
      const concurrent = await page.evaluate(async (value) => {
        const h = globalThis.offlineHarness;
        const db = await h.openStore();
        const a = structuredClone(value);
        a.records[0].event.event_id = crypto.randomUUID();
        a.records[0].event.occurrence = 2;
        const b = structuredClone(a);
        b.records[0].event.event_id = crypto.randomUUID();
        try {
          return (
            await Promise.allSettled([
              h.savePackage(db, a),
              h.savePackage(db, b),
            ])
          ).map((result) => result.status);
        } finally {
          db.close();
        }
      }, saved);
      assert.deepEqual(concurrent.sort(), ["fulfilled", "rejected"]);
      assert.equal((await snapshot(page)).records.length, 2);
    } finally {
      await context.close();
    }
  });

  await test("database v1→v2 upgrade preserves queued events; >24h allows provisional captures", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(new URL("../../index.html", url).href);
      await harness(page);
      const seed = await page.evaluate(async () => {
        const h = globalThis.offlineHarness;
        const record = h.createRecord(
          {
            company_id: "SYN-TAMAGO",
            lot_id: "SYN-L1",
            shed_id: "SYN-G1",
            actor_id: "SYN-A1",
            business_date: "2026-10-20",
            time: "12:00",
            occurrence: 1,
            quantity_eggs: 0,
          },
          crypto.randomUUID(),
          new Date(Date.now() - 90000000),
        );
        await new Promise((resolve, reject) => {
          const req = indexedDB.open(h.DB_NAME, 1);
          req.onupgradeneeded = () => {
            const events = req.result.createObjectStore("events", {
              keyPath: "event_id",
            });
            events.createIndex(
              "occurrence",
              [
                "company_id",
                "lot_id",
                "shed_id",
                "business_date",
                "occurrence",
              ],
              { unique: true },
            );
            req.result.createObjectStore("outbox", { keyPath: "event_id" });
          };
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(["events", "outbox"], "readwrite");
            tx.objectStore("events").add(record.event);
            tx.objectStore("outbox").add({
              event_id: record.event.event_id,
              status: "pending",
            });
            tx.oncomplete = () => {
              db.close();
              resolve();
            };
            tx.onabort = () => reject(tx.error);
          };
        });
        return h.pack([record]);
      });
      await page.goto(url);
      await ready(page);
      await harness(page);
      assert.deepEqual(await snapshot(page), seed);
      assert.match(await page.locator("#age").textContent(), /más de 24 horas/);
      await context.setOffline(true);
      await fill(page);
      await page.locator("#save").click();
      await page
        .locator("#notice")
        .filter({ hasText: "Guardado local confirmado" })
        .waitFor();
      assert.equal((await snapshot(page)).records.length, 2);
      assert.deepEqual(
        (await snapshot(page)).records.find(
          (r) => r.event.event_id === seed.records[0].event.event_id,
        ),
        seed.records[0],
      );
      assert.equal(
        await page.evaluate(async () => {
          const db = await globalThis.offlineHarness.openStore();
          const version = db.version;
          db.close();
          return version;
        }),
        2,
      );
    } finally {
      await context.close();
    }
  });
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
