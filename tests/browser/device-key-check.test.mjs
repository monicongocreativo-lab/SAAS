import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { makeServer } from "../../scripts/serve.mjs";

const options = {
  headless: true,
  ...(process.env.TAMAGO_BROWSER_CHANNEL
    ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
    : {}),
};
const server = makeServer();
let profileDirectory;
let context;
let page;
let url;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://127.0.0.1:${server.address().port}/experimental/device-key-check/`;
  profileDirectory = await mkdtemp(join(tmpdir(), "tamago-dev007-device-check-"));
  context = await chromium.launchPersistentContext(profileDirectory, {
    ...options,
    viewport: { width: 390, height: 844 },
  });
  page = await context.newPage();
});

after(async () => {
  await context?.close();
  if (server.listening) {
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
  }
  if (profileDirectory) await rm(profileDirectory, { recursive: true, force: true });
});

test("device-key POC persists two non-exportable keys and signs offline after process restart", async () => {
  await page.goto(url);
  await page.locator("#offline-shell").filter({ hasText: "Preparada y almacenada" }).waitFor();
  assert.equal(await page.locator("#secure").getAttribute("data-result"), "pass");
  assert.equal(await page.locator("#webcrypto").getAttribute("data-result"), "pass");
  assert.equal(await page.locator("#indexeddb").getAttribute("data-result"), "pass");

  await page.locator("#create-a").click();
  await page.locator("#profile-a-state").filter({ hasText: "firmas verificadas: 1" }).waitFor();
  await page.locator("#create-b").click();
  await page.locator("#profile-b-state").filter({ hasText: "firmas verificadas: 1" }).waitFor();
  const profileA = await page.locator("#profile-a-state").textContent();
  const profileB = await page.locator("#profile-b-state").textContent();
  assert.notEqual(profileA, profileB, "the separate test profiles have distinct public-key thumbprints");

  await context.setOffline(true);
  await page.reload();
  await page.locator("#offline-shell").filter({ hasText: "Preparada y almacenada" }).waitFor();
  await page.locator("#profile-a-state").filter({ hasText: "firmas verificadas: 1" }).waitFor();
  await page.locator("#profile-b-state").filter({ hasText: "firmas verificadas: 1" }).waitFor();
  await page.locator("#sign-a").click();
  await page.locator("#profile-a-state").filter({ hasText: "firmas verificadas: 2" }).waitFor();

  await context.close();
  context = await chromium.launchPersistentContext(profileDirectory, {
    ...options,
    viewport: { width: 390, height: 844 },
    offline: true,
  });
  page = await context.newPage();
  await page.goto(url);
  await page.locator("#offline-shell").filter({ hasText: "Preparada y almacenada" }).waitFor();
  await page.locator("#profile-a-state").filter({ hasText: "firmas verificadas: 2" }).waitFor();
  await page.locator("#profile-b-state").filter({ hasText: "firmas verificadas: 1" }).waitFor();
  await page.locator("#sign-b").click();
  await page.locator("#profile-b-state").filter({ hasText: "firmas verificadas: 2" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.onLine), false);
});
