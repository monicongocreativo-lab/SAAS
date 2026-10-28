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
let authenticator;
let url;

before(async () => {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  url = `http://localhost:${server.address().port}/experimental/security-key-check/`;
  profileDirectory = await mkdtemp(join(tmpdir(), "tamago-dev007f-webauthn-"));
  context = await chromium.launchPersistentContext(profileDirectory, {
    ...options,
    viewport: { width: 390, height: 844 },
  });
  page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const result = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "usb",
      hasResidentKey: false,
      hasUserVerification: false,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  authenticator = { cdp, id: result.authenticatorId };
});

after(async () => {
  if (authenticator) {
    await authenticator.cdp
      .send("WebAuthn.removeVirtualAuthenticator", {
        authenticatorId: authenticator.id,
      })
      .catch(() => {});
    await authenticator.cdp.send("WebAuthn.disable").catch(() => {});
  }
  await context?.close();
  if (server.listening) {
    server.close();
    await new Promise((resolve) => server.once("close", resolve));
  }
  if (profileDirectory)
    await rm(profileDirectory, { recursive: true, force: true });
});

test("WebAuthn test key registers, persists, and signs an event-bound offline challenge", async () => {
  await page.goto(url);
  await page
    .locator("#offline-shell")
    .filter({ hasText: "Lista y recursos almacenados" })
    .waitFor();
  assert.equal(await page.locator("#secure").textContent(), "Sí");
  assert.equal(await page.locator("#webauthn").textContent(), "Disponible");

  await page.locator("#register").click();
  await page
    .locator("#credential-state")
    .filter({ hasText: "Credencial de prueba registrada" })
    .waitFor();
  const firstCredential = await page.evaluate(async () => {
    const request = indexedDB.open("tamago-dev007f-security-key-check-v1");
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const get = db
          .transaction("credential")
          .objectStore("credential")
          .get("active");
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
    } finally {
      db.close();
    }
  });

  await context.setOffline(true);
  await page.reload();
  await page
    .locator("#credential-state")
    .filter({ hasText: "Credencial de prueba recuperada" })
    .waitFor();
  await page.locator("#sign").click();
  await page
    .locator("#proof-state")
    .filter({ hasText: "El autenticador produjo una aserción local" })
    .waitFor();

  const proof = JSON.parse(await page.locator("#proof-output").textContent());
  assert.equal(proof.format, "tamago-dev007f-webauthn-proof-lab-v1");
  assert.equal(proof.credential_id, firstCredential.id);
  assert.equal(proof.assertion.signature.length > 20, true);
  assert.equal(
    proof.event.content,
    "DEV-007F · recogida ficticia · 300 huevos",
  );
  assert.equal(proof.warning.includes("no hay validación de servidor"), true);
  assert.equal(
    await page.evaluate(async () => {
      try {
        await fetch(`./network-only-probe-${crypto.randomUUID()}`);
        return false;
      } catch {
        return true;
      }
    }),
    true,
    "a non-cached network request must fail while the browser context is offline",
  );

  const expectedChallenge = await page.evaluate(async (proofValue) => {
    const decode = (value) => {
      const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
      return Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
        (c) => c.charCodeAt(0),
      );
    };
    const nonce = decode(proofValue.nonce);
    const event = new TextEncoder().encode(JSON.stringify(proofValue.event));
    const joined = new Uint8Array(nonce.length + event.length);
    joined.set(nonce);
    joined.set(event, nonce.length);
    return btoa(
      String.fromCharCode(
        ...new Uint8Array(await crypto.subtle.digest("SHA-256", joined)),
      ),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  }, proof);
  assert.equal(proof.challenge, expectedChallenge);
  const clientData = JSON.parse(
    Buffer.from(proof.assertion.client_data_json, "base64url").toString("utf8"),
  );
  assert.equal(clientData.challenge, proof.challenge);
  assert.equal(clientData.origin, new URL(url).origin);
});
