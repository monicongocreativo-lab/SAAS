import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { chromium } from "playwright";
import { validateCollectionEventV2 } from "../../src/auth-prototype/collection-contract.mjs";
import { assertOfflineCaptureBindings } from "../../src/offline/capture-envelope.mjs";
import { verifyOfflineDeviceEventProof } from "../../src/offline/device-event-proof.mjs";
import {
  fixtureIds,
  fixtureUsers,
  startPasswordIdentityFixture,
} from "../fixtures/password-identity-server.mjs";

test("password UI confirms the account, prepares signed scope, locks races and switches A/B after offline browser restart", async () => {
  const fixture = await startPasswordIdentityFixture({ hostname: "127.0.0.1" });
  const directory = await mkdtemp(
    join(tmpdir(), "tamago-password-identity-browser-"),
  );
  const options = {
    headless: true,
    viewport: { width: 390, height: 844 },
    ...(process.env.TAMAGO_BROWSER_CHANNEL
      ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
      : {}),
  };
  let context;
  try {
    context = await chromium.launchPersistentContext(directory, options);
    let page = await context.newPage();
    const url = `${fixture.origin}/experimental/recogidas/`;
    await page.goto(url);
    await page
      .locator("#offlineState")
      .filter({ hasText: "Pantalla preparada" })
      .waitFor();
    const login = async (user) => {
      await page.locator("#loginForm [name=email]").fill(user.email);
      await page.locator("#loginForm [name=password]").fill(user.password);
      await page.locator("#loginForm button").click();
      await page
        .locator("#authStatus")
        .filter({ hasText: "Sesión verificada" })
        .waitFor();
      await page.locator("#catalogCompany").selectOption(fixtureIds.company);
      await page.locator("#catalogSite").selectOption(fixtureIds.site);
      await page.locator("#catalogHouse").selectOption(fixtureIds.house);
      await page.locator("#catalogLot").selectOption(fixtureIds.lot);
    };
    const prepare = async (password) => {
      await page.locator("#prepareIdentityForm input").fill(password);
      await page.locator("#prepareIdentityForm button").click();
    };
    const businessDay = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
    }).format(new Date());
    const capture = async (occurrence, quantity, day = businessDay) => {
      await page.locator("[name=protected_business_date]").fill(day);
      await page.locator("[name=protected_time]").fill("12:00");
      await page
        .locator("[name=protected_occurrence]")
        .selectOption(String(occurrence));
      await page
        .locator("[name=protected_quantity_eggs]")
        .fill(String(quantity));
      await page.locator("#saveIdentityCollection").click();
    };
    const download = async () => {
      const pending = page.waitForEvent("download");
      await page.locator("#exportIdentityCollections").click();
      return JSON.parse(await readFile(await (await pending).path(), "utf8"));
    };
    const localProfiles = () =>
      page.evaluate(async () => {
        const request = indexedDB.open(
          "tamago-password-offline-identity-lab-v1",
          1,
        );
        const db = await new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const read = db
              .transaction("profiles")
              .objectStore("profiles")
              .getAll();
            read.onsuccess = () => resolve(read.result);
            read.onerror = () => reject(read.error);
          });
        } finally {
          db.close();
        }
      });
    await login(fixtureUsers[0]);
    await prepare("Incorrecta-personal-2026");
    await page
      .locator("#identityError")
      .filter({ hasText: "no coincide" })
      .waitFor();
    assert.equal((await localProfiles()).length, 0);
    await prepare(fixtureUsers[0].password);
    await page.waitForFunction(
      () =>
        document
          .querySelector("#identityStatus")
          .textContent.includes("Identidad local abierta") ||
        !document.querySelector("#identityError").hidden,
    );
    assert.equal(
      await page.locator("#identityError").isHidden(),
      true,
      await page.locator("#identityError").textContent(),
    );
    await page
      .locator("#identityStatus")
      .filter({
        hasText: `Identidad local abierta · usuario ${fixtureUsers[0].id}`,
      })
      .waitFor();
    const original = (await localProfiles())[0];
    assert.equal(original.subject_user_id, fixtureUsers[0].id);
    await capture(1, 413);
    await page
      .locator("#identityCaptureStatus")
      .filter({ hasText: "Recogida firmada guardada localmente" })
      .waitFor();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "413 huevos" })
      .waitFor();
    const firstExport = await download();
    assert.deepEqual(await download(), firstExport);
    assertOfflineCaptureBindings(firstExport);
    const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
    ajv.addSchema(
      JSON.parse(
        await readFile(
          new URL(
            "../../contracts/collection-event.v2.schema.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    const validateBundle = ajv.compile(
      JSON.parse(
        await readFile(
          new URL(
            "../../contracts/offline-collection-bundle.v1.schema.json",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );
    assert.equal(
      validateBundle(firstExport),
      true,
      JSON.stringify(validateBundle.errors),
    );
    assert.equal(firstExport.records.length, 1);
    assert.equal(firstExport.records[0].event.quantity_eggs, 413);
    assert.equal(
      validateCollectionEventV2(
        firstExport.records[0].event,
        fixtureIds.company,
      ),
      true,
    );
    const registry = [...fixture.state.grants.values()].find(
      (row) =>
        row.grant_id === firstExport.records[0].identity_binding.grant_id,
    );
    assert.equal(
      (
        await verifyOfflineDeviceEventProof(
          firstExport.records[0].device_proof,
          firstExport.records[0].event,
          { ...registry, signature_verified: true, grant_state: "current" },
        )
      ).proof_verified,
      true,
    );
    await page.screenshot({
      path: "evidence/dev008a-protected-queue.png",
      fullPage: true,
    });
    fixture.state.deny = true;
    await prepare(fixtureUsers[0].password);
    await page
      .locator("#identityError")
      .filter({ hasText: "no permite preparar" })
      .waitFor();
    assert.equal(
      (await localProfiles())[0].token,
      original.token,
      "denied renewal preserves the previous signed profile",
    );
    fixture.state.deny = false;

    let entered;
    let release;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    fixture.state.hold = () =>
      new Promise((resolve) => {
        release = resolve;
        entered();
      });
    await prepare(fixtureUsers[0].password);
    await started;
    await page.locator("#lockIdentity").click();
    fixture.state.hold = null;
    release();
    await page
      .locator("#identityError")
      .filter({ hasText: "cancelada" })
      .waitFor();
    assert.match(
      await page.locator("#identityStatus").textContent(),
      /bloqueada/u,
    );

    await page.locator("#logout").click();
    await page.locator("#loginForm").waitFor({ state: "visible" });
    await login(fixtureUsers[1]);
    await prepare(fixtureUsers[1].password);
    await page
      .locator("#identityStatus")
      .filter({ hasText: fixtureUsers[1].id })
      .waitFor();
    const profiles = await localProfiles();
    assert.equal(profiles.length, 2);
    assert.equal(
      JSON.stringify(profiles).includes(fixtureUsers[0].password),
      false,
    );
    assert.equal(JSON.stringify(profiles).includes("access-"), false);
    assert.equal(
      (await page.locator("#identityRecords").textContent()).includes(
        "413 huevos",
      ),
      false,
    );
    await capture(1, 27);
    await page
      .locator("#identityError")
      .filter({ hasText: "ya existe en esta tableta" })
      .waitFor();
    await capture(2, 0);
    await page
      .locator("#identityRecords")
      .filter({ hasText: "0 huevos" })
      .waitFor();
    await context.close();
    context = await chromium.launchPersistentContext(directory, {
      ...options,
      offline: true,
    });
    page = await context.newPage();
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector("#offlineProfile").options.length === 3,
    );
    assert.match(
      await page.locator("#identityStatus").textContent(),
      /bloqueada/u,
    );
    const profileA = profiles.find(
      (value) => value.subject_user_id === fixtureUsers[0].id,
    );
    const profileB = profiles.find(
      (value) => value.subject_user_id === fixtureUsers[1].id,
    );
    await page.locator("#offlineProfile").selectOption(profileA.profile_id);
    await page
      .locator("#unlockIdentityForm input")
      .fill(fixtureUsers[1].password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityError")
      .filter({ hasText: "No se pudo abrir la clave local" })
      .waitFor();
    await page
      .locator("#unlockIdentityForm input")
      .fill(fixtureUsers[0].password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityStatus")
      .filter({
        hasText: `Identidad local abierta · usuario ${fixtureUsers[0].id}`,
      })
      .waitFor();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "413 huevos" })
      .waitFor();
    assert.deepEqual(await download(), firstExport);
    await page.locator("#offlineProfile").selectOption(profileB.profile_id);
    assert.equal(await page.locator("#identityRecords").textContent(), "");
    assert.match(
      await page.locator("#identityStatus").textContent(),
      /bloqueada/u,
    );
    await page
      .locator("#unlockIdentityForm input")
      .fill(fixtureUsers[1].password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityStatus")
      .filter({
        hasText: `Identidad local abierta · usuario ${fixtureUsers[1].id}`,
      })
      .waitFor();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "0 huevos" })
      .waitFor();
    assert.equal(
      (await page.locator("#identityRecords").textContent()).includes(
        "413 huevos",
      ),
      false,
    );
    await page.evaluate(() => {
      const add = IDBObjectStore.prototype.add;
      globalThis.restoreProtectedFailure = () => {
        IDBObjectStore.prototype.add = add;
      };
      IDBObjectStore.prototype.add = function (...args) {
        if (
          this.name === "outbox" &&
          this.transaction.db.name === "tamago-protected-collections-lab-v1"
        )
          throw new DOMException("Synthetic failure", "QuotaExceededError");
        return add.apply(this, args);
      };
    });
    await capture(3, 42);
    await page
      .locator("#identityError")
      .filter({ hasText: "No se pudo guardar la recogida" })
      .waitFor();
    assert.equal(
      await page.locator("[name=protected_quantity_eggs]").inputValue(),
      "42",
    );
    assert.equal((await download()).records.length, 1);
    await page.evaluate(() => globalThis.restoreProtectedFailure());
    await page.locator("#saveIdentityCollection").click();
    await page
      .locator("#identityRecords")
      .filter({ hasText: "42 huevos" })
      .waitFor();
    const secondExport = await download();
    assert.equal(
      validateBundle(secondExport),
      true,
      JSON.stringify(validateBundle.errors),
    );
    assert.deepEqual(await download(), secondExport);
    assert.deepEqual(
      secondExport.records.map((row) => row.event.quantity_eggs),
      [0, 42],
    );
    assert.equal(
      secondExport.records.every(
        (row) =>
          row.event.actor_declared_id === fixtureUsers[1].id &&
          row.delivery.status === "pending",
      ),
      true,
    );
    const rawQueue = await page.evaluate(async () => {
      const request = indexedDB.open("tamago-protected-collections-lab-v1");
      const db = await new Promise((resolve) => {
        request.onsuccess = () => resolve(request.result);
      });
      try {
        return await new Promise((resolve) => {
          const read = db.transaction("events").objectStore("events").getAll();
          read.onsuccess = () => resolve(read.result);
        });
      } finally {
        db.close();
      }
    });
    assert.equal(rawQueue.length, 3);
    assert.equal(
      rawQueue.every(
        (row) => !row.event && row.sealed.ciphertext && !row.quantity_eggs,
      ),
      true,
    );
    assert.equal(
      await page.locator("#unlockIdentityForm input").inputValue(),
      "",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
    await page.evaluate(() =>
      dispatchEvent(new PageTransitionEvent("pagehide")),
    );
    assert.match(
      await page.locator("#identityStatus").textContent(),
      /bloqueada/u,
    );
    await page.clock.install({
      time: new Date(Date.now() + 25 * 60 * 60 * 1000),
    });
    await page
      .locator("#unlockIdentityForm input")
      .fill(fixtureUsers[1].password);
    await page.locator("#unlockIdentityForm button").click();
    await page
      .locator("#identityStatus")
      .filter({ hasText: "Capacidad vencida: solo uso provisional" })
      .waitFor();
    const futureDay = await page.evaluate(() =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(
        new Date(),
      ),
    );
    await capture(1, 5, futureDay);
    await page
      .locator("#identityRecords")
      .filter({ hasText: "5 huevos" })
      .waitFor();
    assert.equal(
      (await download()).records.every(
        (row) => row.delivery.status === "pending",
      ),
      true,
    );
  } finally {
    await context?.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  }
});
