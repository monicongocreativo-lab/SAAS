import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";

test("local checkpoint demo: generated credentials are fictitious, scoped auth and reviewed opening persist", {
  skip:
    process.env.TAMAGO_DEMO_URL &&
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1"
      ? false
      : "Requires explicit running local fictitious demo",
  timeout: 60000,
}, async () => {
  const url = new URL(process.env.TAMAGO_DEMO_URL);
  assert.equal(url.protocol, "http:");
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.equal(url.pathname, "/demo/");
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.TAMAGO_BROWSER_CHANNEL
      ? { channel: process.env.TAMAGO_BROWSER_CHANNEL }
      : {}),
  });
  try {
    const p = await (
      await browser.newContext({
        viewport: { width: 390, height: 844 },
        timezoneId: "Europe/Lisbon",
      })
    ).newPage();
    await p.goto(url.href);
    const director = p.locator("section").filter({
      has: p.getByRole("heading", { name: "Dirección · cuenta ficticia" }),
    });
    const email = await director.locator("input").nth(0).inputValue();
    const password = await director.locator("input").nth(1).inputValue();
    assert.match(email, /@example\.invalid$/);
    assert.match(password, /^Ficticia-/);
    const opening = await p
      .locator("label")
      .filter({ hasText: "ID de apertura" })
      .locator("input")
      .inputValue();
    const env = JSON.parse(
      await readFile(process.env.TAMAGO_CUSTODY_TEST_ENV_FILE, "utf8"),
    );
    assert.equal((await p.content()).includes(env.SERVICE_ROLE_KEY), false);
    await p
      .getByRole("link", { name: "Inventario de alimento", exact: true })
      .click();
    await p.locator("#loginPanel").waitFor({ state: "visible" });
    await p.locator("#loginForm [name=email]").fill(email);
    await p.locator("#loginForm [name=password]").fill(password);
    await p.locator("#loginForm button").click();
    await p.locator("#workspace").waitFor({ state: "visible" });
    const ready = () =>
      p.waitForFunction(
        () => !document.querySelector("#refreshAccount").disabled,
      );
    await ready();
    const options = await p
      .locator("#lot option")
      .evaluateAll((all) => all.filter((o) => o.value).map((o) => o.value));
    assert.equal(options.length, 1);
    await p.locator("#lot").selectOption(options[0]);
    await ready();
    async function lookup() {
      await p.locator("#bookLookup [name=id]").fill(opening);
      await p.locator("#bookLookup [name=date]").fill("2026-10-27");
      await p.locator("#bookLookup [name=time]").fill("12:00");
      await p.locator("#bookLookup button").click();
      await ready();
    }
    await lookup();
    assert.match(await p.locator("#bookState").textContent(), /Falta activar/);
    assert.match(await p.locator("#bookProposal").textContent(), /13 bultos/);
    await p
      .locator("#bookForm [name=reason]")
      .fill("SYN-Verificación del arranque demostrable");
    await p.locator("#reviewBook").click();
    await ready();
    await p.locator("#confirm").click();
    await ready();
    await p.locator("#intentPanel").waitFor({ state: "hidden" });
    assert.match(
      await p.locator("#bookBalance").textContent(),
      /13 bultos.*versión 1/,
    );
    await p.reload();
    await ready();
    await p.locator("#lot").selectOption(options[0]);
    await ready();
    await lookup();
    assert.match(
      await p.locator("#bookBalance").textContent(),
      /13 bultos.*versión 1/,
    );
    assert.equal(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await p.locator("#logout").click();
    await p.locator("#loginPanel").waitFor({ state: "visible" });
    assert.equal(await p.locator("#bookContext").isVisible(), false);
  } finally {
    await browser.close();
  }
});
