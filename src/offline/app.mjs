import { createRecord, operationalDate, pack } from "./contract.mjs";
import {
  installationId,
  openStore,
  readPackage,
  savePackage,
} from "./store.mjs";

const $ = (selector) => document.querySelector(selector);
const form = $("#capture");
let db;
let deviceId;
let busy = false;
let attempt = null;

function report(error) {
  $("#error").textContent =
    `${error.message || error} No borres datos. Revisa los campos o reintenta; exporta los pendientes cuando el almacenamiento vuelva a estar disponible.`;
  $("#error").hidden = false;
}
function clearMessages() {
  $("#error").hidden = true;
  $("#notice").textContent = "";
}
function network() {
  $("#connection").textContent = navigator.onLine
    ? "Conexión disponible según el dispositivo; no hay servidor de sincronización."
    : "Sin conexión. Puedes guardar localmente; todo permanece pendiente.";
}
function setBusy(value) {
  busy = value;
  $("#fields").disabled = value || !db;
  $("#export").disabled = value || !db;
  $("#restore").disabled = value || !db;
}
async function render() {
  const value = await readPackage(db);
  $("#records").replaceChildren();
  $("#summary").textContent = value.records.length
    ? `${value.records.length} recogida(s) guardada(s) · pendientes de envío.`
    : "Sin información de recogidas. No equivale a cero huevos.";
  let oldest = 0;
  for (const { event } of value.records) {
    oldest = Math.max(oldest, Date.now() - Date.parse(event.captured_at));
    const li = document.createElement("li");
    const title = document.createElement("strong");
    title.textContent = `${event.quantity_eggs} huevos · ${event.business_date} · recogida ${event.occurrence}`;
    const origin = document.createElement("small");
    origin.textContent = `${event.company_id} / ${event.lot_id} / ${event.shed_id}`;
    const identity = document.createElement("small");
    identity.textContent = `ID ${event.event_id} · autor declarado ${event.actor.declared_id}`;
    const status = document.createElement("small");
    status.textContent =
      "Guardado local · provisional · pendiente de envío · sin acuse de servidor";
    li.append(title, origin, identity, status);
    $("#records").append(li);
  }
  $("#age").textContent =
    oldest > 86400000
      ? "Hay pendientes de más de 24 horas según el reloj local. Puedes continuar capturando provisionalmente; exporta respaldo."
      : "Todas las capturas son provisionales: no hay autenticación ni servidor que las acepte.";
}

form.addEventListener("input", () => {
  if (!busy) {
    attempt = null;
    clearMessages();
  }
});
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy || !db || !form.reportValidity()) return;
  clearMessages();
  // Read before disabling the fieldset (disabled fields are absent from FormData).
  const input = Object.fromEntries(new FormData(form));
  setBusy(true);
  let committed = false;
  try {
    attempt ??= createRecord(input, deviceId);
    await savePackage(db, pack([attempt]));
    committed = true;
    $("#notice").textContent =
      `Guardado local confirmado · ID ${attempt.event.event_id} · pendiente de envío. No sincronizado.`;
    attempt = null;
    form.elements.quantity_eggs.value = "";
    await render();
  } catch (error) {
    if (!committed) $("#notice").textContent = "";
    report(error);
  } finally {
    setBusy(false);
  }
});

$("#export").addEventListener("click", async () => {
  if (busy || !db) return;
  clearMessages();
  setBusy(true);
  try {
    const value = await readPackage(db);
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "tamago-dev002-ficticio-v1.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $("#notice").textContent =
      "Respaldo preparado para descarga. Verifica el archivo; la cola permanece pendiente.";
  } catch (error) {
    report(error);
  } finally {
    setBusy(false);
  }
});
$("#restore").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file || busy || !db) return;
  clearMessages();
  setBusy(true);
  try {
    const value = JSON.parse(await file.text());
    const added = await savePackage(db, value);
    $("#notice").textContent =
      `Recuperación local completada: ${added} nuevos. IDs ya presentes no se duplicaron. Todo sigue pendiente.`;
    await render();
  } catch (error) {
    report(error);
  } finally {
    event.target.value = "";
    setBusy(false);
  }
});
$("#protect").addEventListener("click", async () => {
  try {
    const granted = await navigator.storage?.persist?.();
    $("#retention").textContent = granted
      ? "El navegador concedió almacenamiento persistente. Aun así, exporta: borrar datos o perder el equipo elimina esta copia."
      : "El navegador no concedió conservación persistente o no la admite. Exporta respaldos con frecuencia.";
  } catch (error) {
    report(error);
  }
});

async function prepareOffline() {
  try {
    if (!("serviceWorker" in navigator))
      throw new Error(
        "Service Worker no disponible; no se puede asegurar la pantalla sin red.",
      );
    await navigator.serviceWorker.register("./sw.js", {
      scope: "./",
      updateViaCache: "none",
    });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
    await new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => {
        channel.port1.close();
        reject(new Error("No se pudo verificar la caché local."));
      }, 5000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timeout);
        channel.port1.close();
        if (event.data === true) resolve();
        else
          reject(
            new Error(
              "Faltan recursos en la caché; vuelve a preparar con red.",
            ),
          );
      };
      navigator.serviceWorker.controller.postMessage("VERIFY_SHELL", [
        channel.port2,
      ]);
    });
    $("#offlineState").textContent =
      "Pantalla preparada para abrir sin red en este navegador y dirección.";
  } catch (error) {
    $("#offlineState").textContent =
      `Preparación offline fallida: ${error.message}. Mantén la red y vuelve a abrir antes de salir.`;
  }
}

form.elements.business_date.value = operationalDate();
form.elements.time.value = new Intl.DateTimeFormat("en-GB", {
  timeZone: "America/Bogota",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
}).format(new Date());
network();
addEventListener("online", network);
addEventListener("offline", network);
prepareOffline();
try {
  db = await openStore((message) => {
    db = null;
    setBusy(false);
    report(new Error(message));
  });
  deviceId = await installationId(db);
  await render();
  setBusy(false);
} catch (error) {
  db = null;
  setBusy(false);
  report(error);
}
setInterval(() => {
  if (db && !busy) render().catch(report);
}, 60000);
