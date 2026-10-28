const DB_NAME = "tamago-dev007-key-check-v1";
const STORE_NAME = "profiles";
const CACHE_NAME = "tamago-dev007-key-check-shell-v1";
const SHELL_FILES = ["./", "./index.html", "./device-key-check.css", "./device-key-check.js"];
const profileNames = { a: "Trabajador de prueba A", b: "Trabajador de prueba B" };
const $ = (selector) => document.querySelector(selector);

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME, { keyPath: "profile" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB no disponible"));
    request.onblocked = () => reject(new Error("Cierra otra pestaña de esta prueba y vuelve a intentar."));
  });
}

async function readProfile(profile) {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(profile);
      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error ?? new Error("No se pudo leer la clave"));
    });
  } finally {
    db.close();
  }
}

async function writeProfile(value) {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      transaction.objectStore(STORE_NAME).put(value);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error ?? new Error("No se guardó la clave"));
      transaction.onabort = () => reject(transaction.error ?? new Error("Se canceló el guardado"));
    });
  } finally {
    db.close();
  }
}

function setCheck(id, passed, success, failure) {
  const element = $(`#${id}`);
  element.textContent = passed ? success : failure;
  element.dataset.result = passed ? "pass" : "fail";
}

function log(message) {
  const item = document.createElement("li");
  item.textContent = `${new Date().toLocaleTimeString()} · ${message}`;
  $("#history").prepend(item);
  $("#result").textContent = message;
}

async function refreshProfiles() {
  for (const id of ["a", "b"]) {
    const profile = await readProfile(id);
    $(`#profile-${id}-state`).textContent = profile
      ? `Clave guardada · ${profile.thumbprint.slice(0, 16)}… · firmas verificadas: ${profile.proofCount}`
      : "Sin clave de prueba";
    $(`#create-${id}`).disabled = Boolean(profile) || !crypto.subtle || !indexedDB;
    $(`#sign-${id}`).disabled = !profile || !crypto.subtle;
  }
}

async function prepareOfflineShell() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) {
    setCheck("offline-shell", false, "Preparada", "Requiere origen seguro y Service Worker");
    return;
  }
  try {
    const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    const cache = await caches.open(CACHE_NAME);
    const missing = [];
    for (const file of SHELL_FILES) {
      if (!(await cache.match(new URL(file, location.href)))) missing.push(file);
    }
    if (missing.length) await cache.addAll(missing.map((file) => new URL(file, location.href)));
    setCheck("offline-shell", true, "Preparada y almacenada", "No se pudo almacenar la pantalla");
    if (!navigator.serviceWorker.controller && registration.active)
      log("El navegador activó el Service Worker; recarga una vez para probar navegación offline.");
  } catch (error) {
    setCheck("offline-shell", false, "Preparada", `No se pudo preparar: ${error.message}`);
  }
}

async function createProfile(profileId) {
  const existing = await readProfile(profileId);
  if (existing) throw new Error("Ya existe una clave para este perfil de prueba.");
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const thumbprint = await calculateThumbprint(publicJwk);
  const profile = {
    profile: profileId,
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
    thumbprint,
    createdAt: new Date().toISOString(),
    proofCount: 0,
  };
  await writeProfile(profile);
  const recovered = await readProfile(profileId);
  if (!recovered || recovered.privateKey.extractable)
    throw new Error("La clave recuperada no conserva la condición no exportable.");
  await signProfile(profileId);
  log(`${profileNames[profileId]}: clave no exportable guardada y recuperada desde IndexedDB; thumbprint ${thumbprint}.`);
  await refreshProfiles();
}

async function signProfile(profileId) {
  const profile = await readProfile(profileId);
  if (!profile) throw new Error("Primero crea la clave de este perfil.");
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    profile.privateKey,
    challenge,
  );
  const verified = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    profile.publicKey,
    signature,
    challenge,
  );
  if (!verified) throw new Error("La firma local no verificó.");
  let privateKeyExported = true;
  try {
    await crypto.subtle.exportKey("pkcs8", profile.privateKey);
  } catch {
    privateKeyExported = false;
  }
  if (privateKeyExported) throw new Error("La API permitió exportar la clave privada de prueba.");
  await writeProfile({ ...profile, proofCount: profile.proofCount + 1 });
  log(`${profileNames[profileId]}: firma local verificada; clave privada no exportable.`);
  await refreshProfiles();
  return true;
}

async function calculateThumbprint(jwk) {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function deleteTestData() {
  if (!window.confirm("¿Borrar únicamente las dos claves de la prueba DEV-007 en este navegador?")) return;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error ?? new Error("No se borraron las claves de la prueba"));
    request.onblocked = () => reject(new Error("Cierra las otras pestañas de esta prueba y vuelve a intentar."));
  });
  await refreshProfiles();
  log("Se borraron solo las claves de esta prueba DEV-007.");
}

async function start() {
  setCheck("secure", window.isSecureContext, "Sí", "No: abre por HTTPS confiable o localhost");
  setCheck("webcrypto", Boolean(crypto?.subtle), "Disponible", "No disponible en este origen");
  setCheck("indexeddb", Boolean(indexedDB), "Disponible", "No disponible");
  setCheck("network", navigator.onLine, "Con red", "Sin red (según el navegador)");
  addEventListener("online", () => setCheck("network", true, "Con red", "Sin red (según el navegador)"));
  addEventListener("offline", () => setCheck("network", false, "Con red", "Sin red (según el navegador)"));

  for (const id of ["a", "b"]) {
    $(`#create-${id}`).addEventListener("click", async () => {
      try {
        await createProfile(id);
      } catch (error) {
        log(`No se creó la clave: ${error.message}`);
      }
    });
    $(`#sign-${id}`).addEventListener("click", async () => {
      try {
        await signProfile(id);
      } catch (error) {
        log(`No se pudo firmar con el perfil ${id.toUpperCase()}: ${error.message}`);
      }
    });
  }
  $("#delete-test-data").addEventListener("click", async () => {
    try {
      await deleteTestData();
    } catch (error) {
      log(`No se borraron los datos de prueba: ${error.message}`);
    }
  });

  await refreshProfiles();
  await prepareOfflineShell();
  if (!window.isSecureContext || !crypto?.subtle) {
    $("#create-a").disabled = true;
    $("#create-b").disabled = true;
    log("La prueba de claves requiere HTTPS confiable; la página informativa sigue disponible.");
  }
}

start().catch((error) => log(`Prueba no preparada: ${error.message}`));
