import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { makeServer } from "../../scripts/serve.mjs";

const server = makeServer();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.TAMAGO_BROWSER_CHANNEL
    ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
    : {}),
});

try {
  await test("collection mockup explains offline status without claiming persistence or export", async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await context.newPage();
      await page.goto(
        `http://127.0.0.1:${server.address().port}/maquetas/recogidas/`,
      );
      const initialRecords = await page.locator("#recordList .record").count();

      await page.locator('[data-next="registrar"]').click();
      await page.locator("#networkToggle").click();
      assert.match(
        await page.locator("#networkLabel").textContent(),
        /Sin conexión/,
      );
      await page.locator("#quantity").fill("12345");
      await page.locator('#captureForm button[type="submit"]').click();

      const status = page.locator("#screen-estado");
      await status.waitFor({ state: "visible" });
      assert.match(await status.textContent(), /12\.345/);
      assert.match(await status.textContent(), /Provisional · sin envío/);
      assert.match(
        await page.locator("#feedback").textContent(),
        /no conserva el registro al recargar/,
      );

      await page.locator("#exportButton").click();
      assert.match(
        await page.locator("#feedback").textContent(),
        /no crea un archivo/,
      );
      await page.reload();
      assert.equal(
        await page.locator("#recordList .record").count(),
        initialRecords,
      );
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
    } finally {
      await context.close();
    }
  });
} finally {
  await browser.close();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
