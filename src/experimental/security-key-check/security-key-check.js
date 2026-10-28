const DB_NAME = "tamago-dev007f-security-key-check-v1";
const STORE = "credential";
const SHELL = [
  "./",
  "./index.html",
  "./security-key-check.css",
  "./security-key-check.js",
];
const $ = (selector) => document.querySelector(selector);

function base64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("No se pudo abrir IndexedDB"));
  });
}

async function readCredential() {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE).objectStore(STORE).get("active");
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () =>
        reject(request.error ?? new Error("No se pudo leer la credencial"));
    });
  } finally {
    db.close();
  }
}

async function writeCredential(value) {
  const db = await openDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, "active");
      tx.oncomplete = resolve;
      tx.onerror = () =>
        reject(tx.error ?? new Error("No se pudo guardar la credencial"));
      tx.onabort = () =>
        reject(tx.error ?? new Error("Se canceló el guardado"));
    });
  } finally {
    db.close();
  }
}

function setState(id, text) {
  $(id).textContent = text;
}

async function challengeFor(eventBytes, nonce) {
  const joined = new Uint8Array(nonce.length + eventBytes.length);
  joined.set(nonce);
  joined.set(eventBytes, nonce.length);
  return crypto.subtle.digest("SHA-256", joined);
}

async function registerCredential() {
  const existing = await readCredential();
  if (existing)
    throw new Error(
      "Ya existe una credencial local; borra el laboratorio para repetir.",
    );
  if (
    !window.isSecureContext ||
    !navigator.credentials ||
    !window.PublicKeyCredential
  )
    throw new Error("Este navegador no ofrece WebAuthn en un origen seguro.");

  const name = $("#worker-name").value.trim();
  if (!name) throw new Error("Escribe un nombre sintético de laboratorio.");
  const userId = crypto.getRandomValues(new Uint8Array(16));
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { id: location.hostname, name: "Tamago laboratorio DEV-007F" },
      user: { id: userId, name: "operario-demo", displayName: name },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      authenticatorSelection: {
        authenticatorAttachment: "cross-platform",
        residentKey: "discouraged",
        userVerification: "discouraged",
      },
      timeout: 60_000,
      attestation: "none",
    },
  });
  if (!credential) throw new Error("El autenticador canceló el registro.");
  const row = {
    id: base64url(credential.rawId),
    userId: base64url(userId),
    displayName: name,
    registeredAt: new Date().toISOString(),
  };
  await writeCredential(row);
  setState(
    "#credential-state",
    `Credencial de prueba registrada: ${row.id.slice(0, 18)}… (${name}).`,
  );
  $("#register").disabled = true;
  $("#sign").disabled = false;
}

async function signProof() {
  const row = await readCredential();
  if (!row) throw new Error("Primero registra una llave.");
  const event = {
    id: crypto.randomUUID(),
    content: $("#event-text").value.trim(),
    occurred_at: new Date().toISOString(),
  };
  if (!event.content)
    throw new Error("Escribe contenido ficticio antes de firmar.");
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const eventJson = JSON.stringify(event);
  const eventBytes = new TextEncoder().encode(eventJson);
  const challenge = await challengeFor(eventBytes, nonce);
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge,
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: fromBase64url(row.id) }],
      userVerification: "discouraged",
      timeout: 60_000,
    },
  });
  if (!assertion) throw new Error("El autenticador canceló la firma.");
  const packageValue = {
    format: "tamago-dev007f-webauthn-proof-lab-v1",
    warning:
      "Laboratorio local: no hay validación de servidor, autorización ni estado de sincronización.",
    credential_id: base64url(assertion.rawId),
    event,
    nonce: base64url(nonce),
    challenge: base64url(challenge),
    assertion: {
      client_data_json: base64url(assertion.response.clientDataJSON),
      authenticator_data: base64url(assertion.response.authenticatorData),
      signature: base64url(assertion.response.signature),
      user_handle: assertion.response.userHandle
        ? base64url(assertion.response.userHandle)
        : null,
    },
  };
  $("#proof-output").textContent = JSON.stringify(packageValue, null, 2);
  setState(
    "#proof-state",
    "El autenticador produjo una aserción local. El servidor no la verificó.",
  );
}

async function prepareShell() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    setState("#offline-shell", "Requiere HTTPS confiable o localhost.");
    return;
  }
  try {
    await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    const cache = await caches.open("tamago-dev007f-security-key-shell-v1");
    const missing = [];
    for (const file of SHELL)
      if (!(await cache.match(new URL(file, location.href))))
        missing.push(file);
    if (missing.length)
      await cache.addAll(missing.map((file) => new URL(file, location.href)));
    setState("#offline-shell", "Lista y recursos almacenados");
  } catch (error) {
    setState("#offline-shell", `No se pudo preparar: ${error.message}`);
  }
}

async function clearLocal() {
  if (
    !confirm(
      "¿Borrar únicamente el identificador local de esta prueba? La credencial del dispositivo/llave no se borra.",
    )
  )
    return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () =>
      reject(request.error ?? new Error("No se borraron los datos locales"));
    request.onblocked = () =>
      reject(new Error("Cierra las otras pestañas de la prueba y reintenta."));
  });
  $("#register").disabled = false;
  $("#sign").disabled = true;
  $("#proof-output").textContent = "Todavía no hay paquete.";
  setState("#credential-state", "Sin credencial local de prueba.");
  setState("#proof-state", "Registra una credencial para habilitar la prueba.");
}

async function start() {
  setState("#secure", window.isSecureContext ? "Sí" : "No");
  setState(
    "#webauthn",
    window.PublicKeyCredential ? "Disponible" : "No disponible",
  );
  setState("#network", navigator.onLine ? "Con red" : "Sin red");
  addEventListener("online", () => setState("#network", "Con red"));
  addEventListener("offline", () => setState("#network", "Sin red"));
  const row = await readCredential();
  if (row) {
    setState(
      "#credential-state",
      `Credencial de prueba recuperada: ${row.id.slice(0, 18)}… (${row.displayName}).`,
    );
    $("#register").disabled = true;
    $("#sign").disabled = false;
  }
  $("#register").addEventListener("click", () =>
    registerCredential().catch((error) =>
      setState("#credential-state", `No se registró: ${error.message}`),
    ),
  );
  $("#sign").addEventListener("click", () =>
    signProof().catch((error) =>
      setState("#proof-state", `No se firmó: ${error.message}`),
    ),
  );
  $("#clear").addEventListener("click", () =>
    clearLocal().catch((error) =>
      setState("#credential-state", `No se borró: ${error.message}`),
    ),
  );
  await prepareShell();
}

start().catch((error) =>
  setState(
    "#proof-state",
    `No se pudo preparar el laboratorio: ${error.message}`,
  ),
);
