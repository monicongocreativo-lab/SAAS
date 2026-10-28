import { assertOperationalCatalog } from "./catalog-contract.mjs";
import { createRecord, operationalDate, pack } from "./contract.mjs";
import { mountPasswordIdentity } from "./password-identity-ui.mjs";
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
let authenticatedCompanyList = [];
let operationalCatalog = null;
let authRequestBusy = false;
let authenticatedUserId = null;
let authEpoch = 0;
let identityUi;
function lockLocalIdentity() {
  identityUi?.lock();
}
function selectedIdentityScope() {
  if (
    !authenticatedUserId ||
    !operationalCatalog ||
    !lotSelect.value ||
    !operationalCatalog.lots.some(
      (lot) =>
        lot.id === lotSelect.value &&
        lot.site_id === siteSelect.value &&
        lot.house_id === houseSelect.value,
    )
  )
    return null;
  return {
    company_id: companySelect.value,
    site_id: siteSelect.value,
    house_id: houseSelect.value,
    lot_id: lotSelect.value,
  };
}

const authLoginForm = $("#loginForm");
const passwordChangeForm = $("#passwordChangeForm");
const catalogPanel = $("#catalogPanel");
const companySelect = $("#catalogCompany");
const siteSelect = $("#catalogSite");
const houseSelect = $("#catalogHouse");
const lotSelect = $("#catalogLot");

async function authenticatedRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    signal: AbortSignal.timeout(15_000),
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body =
    response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error ?? `HTTP_${response.status}`);
  return body;
}

function setAuthError(message = "") {
  $("#authError").textContent = message;
  $("#authError").hidden = !message;
}

function resetCatalog(message = "") {
  authenticatedCompanyList = [];
  operationalCatalog = null;
  catalogPanel.hidden = true;
  $("#accountIdentity").textContent = "";
  $("#catalogStatus").textContent = message;
  $("#retryCatalog").hidden = true;
  replaceOptions(companySelect, [], "No hay empresas disponibles");
  replaceOptions(siteSelect, [], "Elige empresa primero");
  replaceOptions(houseSelect, [], "Elige sede primero");
  replaceOptions(lotSelect, [], "Elige galpón primero");
}

function replaceOptions(
  select,
  items,
  emptyLabel,
  label = (item) => item.name,
) {
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = items.length ? "Selecciona…" : emptyLabel;
  select.replaceChildren(placeholder);
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = label(item);
    select.append(option);
  }
  select.disabled = items.length === 0 || authRequestBusy;
}

function showPasswordChange() {
  authLoginForm.hidden = true;
  passwordChangeForm.hidden = false;
  catalogPanel.hidden = true;
  $("#authStatus").textContent =
    "La cuenta requiere cambiar su contraseña temporal.";
}

async function showAuthenticatedContext(userId) {
  lockLocalIdentity();
  authenticatedUserId = userId;
  authLoginForm.hidden = true;
  passwordChangeForm.hidden = true;
  catalogPanel.hidden = false;
  $("#authStatus").textContent = "Sesión verificada por el servidor.";
  setAuthError();
  await loadCompanies();
  if (authenticatedUserId !== userId) return;
  $("#accountIdentity").textContent =
    `Sesión autenticada · usuario ${userId}. Puedes preparar el ámbito seleccionado. El área legado de datos sintéticos sigue separada.`;
  await identityUi?.refresh();
}

async function loadCompanies() {
  const epoch = authEpoch;
  $("#catalogStatus").textContent = "Cargando empresas permitidas…";
  $("#retryCatalog").hidden = true;
  resetCatalog();
  catalogPanel.hidden = false;
  try {
    const values = await authenticatedRequest("/v1/companies");
    if (epoch !== authEpoch) return;
    if (
      !Array.isArray(values) ||
      values.some(
        (item) =>
          !item ||
          !isUuid(item.id) ||
          typeof item.code !== "string" ||
          typeof item.legal_name !== "string",
      )
    )
      throw new Error("INVALID_COMPANY_DIRECTORY");
    authenticatedCompanyList = values;
    replaceOptions(
      companySelect,
      values,
      "No tienes empresas activas asignadas",
      (company) => `${company.legal_name} · ${company.code}`,
    );
    $("#catalogStatus").textContent = values.length
      ? "Elige una empresa para consultar sus ubicaciones autorizadas."
      : "Esta identidad no tiene empresas activas asignadas.";
  } catch (error) {
    if (epoch !== authEpoch) return;
    $("#catalogStatus").textContent =
      "No se pudo cargar el directorio de empresas.";
    $("#retryCatalog").hidden = false;
    setAuthError(authErrorMessage(error.message));
  }
}

async function loadOperationalCatalog(companyId) {
  const epoch = authEpoch;
  operationalCatalog = null;
  replaceOptions(siteSelect, [], "Cargando sedes…");
  replaceOptions(houseSelect, [], "Elige sede primero");
  replaceOptions(lotSelect, [], "Elige galpón primero");
  $("#catalogStatus").textContent = "Consultando ubicaciones autorizadas…";
  $("#retryCatalog").hidden = true;
  try {
    const catalog = await authenticatedRequest(
      `/v1/companies/${encodeURIComponent(companyId)}/operational-catalog`,
    );
    if (epoch !== authEpoch || companyId !== companySelect.value) return;
    operationalCatalog = assertOperationalCatalog(catalog, companyId);
    replaceOptions(siteSelect, operationalCatalog.sites, "Sin sedes activas");
    $("#catalogStatus").textContent =
      `Catálogo del servidor: ${operationalCatalog.sites.length} sede(s), ${operationalCatalog.houses.length} galpón(es), ${operationalCatalog.lots.length} lote(s) visibles. Elige cada nivel para consultar el siguiente.`;
  } catch (error) {
    if (epoch !== authEpoch || companyId !== companySelect.value) return;
    operationalCatalog = null;
    replaceOptions(siteSelect, [], "No fue posible cargar las sedes");
    $("#catalogStatus").textContent = "El catálogo no quedó disponible.";
    $("#retryCatalog").hidden = false;
    setAuthError(authErrorMessage(error.message));
  }
}

function authErrorMessage(code) {
  const known = {
    AUTHENTICATION_REQUIRED: "La sesión venció. Inicia sesión de nuevo.",
    PASSWORD_CHANGE_REQUIRED: "Cambia la contraseña temporal para continuar.",
    INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
    INVALID_COMPANY_DIRECTORY:
      "El servidor devolvió un directorio con formato inválido.",
    INVALID_OPERATIONAL_CATALOG:
      "El catálogo no coincide con su contrato. No se usará.",
    COMPANY_NOT_FOUND: "La empresa ya no está disponible para esta sesión.",
  }[code];
  if (known) return known;
  const suffix =
    typeof code === "string" ? ` (código ${code.slice(0, 80)})` : "";
  return `No se pudo contactar al servicio local. Comprueba la conexión e inténtalo de nuevo.${suffix}`;
}

function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

async function refreshAuthenticatedContext() {
  const epoch = ++authEpoch;
  try {
    const session = await authenticatedRequest("/v1/auth/me");
    if (epoch !== authEpoch) return;
    if (!isUuid(session.user_id)) throw new Error("INVALID_SESSION_RESPONSE");
    if (session.password_change_required) {
      authenticatedUserId = null;
      lockLocalIdentity();
      resetCatalog();
      showPasswordChange();
      return;
    }
    await showAuthenticatedContext(session.user_id);
  } catch (error) {
    if (epoch !== authEpoch) return;
    authenticatedUserId = null;
    lockLocalIdentity();
    resetCatalog();
    passwordChangeForm.hidden = true;
    authLoginForm.hidden = false;
    if (error.message === "AUTHENTICATION_REQUIRED") {
      $("#authStatus").textContent =
        "Inicia sesión para consultar el catálogo autorizado.";
      setAuthError();
    } else {
      $("#authStatus").textContent =
        "No se pudo verificar la sesión en el servidor.";
      setAuthError(authErrorMessage(error.message));
    }
  }
}

function setAuthBusy(value) {
  authRequestBusy = value;
  for (const button of [
    ...authLoginForm.querySelectorAll("button"),
    ...passwordChangeForm.querySelectorAll("button"),
    $("#retryCatalog"),
    $("#refreshSession"),
    $("#logout"),
  ])
    button.disabled = value;
  companySelect.disabled = value || authenticatedCompanyList.length === 0;
  siteSelect.disabled = value || !operationalCatalog?.sites.length;
  houseSelect.disabled =
    value || !houseSelect.options.length || houseSelect.options.length < 2;
  lotSelect.disabled =
    value || !lotSelect.options.length || lotSelect.options.length < 2;
}

authLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (authRequestBusy || !authLoginForm.reportValidity()) return;
  authenticatedUserId = null;
  authEpoch += 1;
  lockLocalIdentity();
  setAuthError();
  setAuthBusy(true);
  const formData = new FormData(authLoginForm);
  try {
    await authenticatedRequest("/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({
        email: formData.get("email"),
        password: formData.get("password"),
      }),
    });
    authLoginForm.querySelector('[name="password"]').value = "";
    await refreshAuthenticatedContext();
  } catch (error) {
    authLoginForm.querySelector('[name="password"]').value = "";
    setAuthError(authErrorMessage(error.message));
  } finally {
    setAuthBusy(false);
  }
});

passwordChangeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (authRequestBusy || !passwordChangeForm.reportValidity()) return;
  const newPassword = passwordChangeForm.querySelector(
    '[name="new_password"]',
  ).value;
  const confirmation = passwordChangeForm.querySelector(
    '[name="confirm_password"]',
  ).value;
  if (newPassword !== confirmation) {
    setAuthError("Las contraseñas no coinciden.");
    return;
  }
  setAuthError();
  setAuthBusy(true);
  try {
    await authenticatedRequest("/v1/auth/change-initial-password", {
      method: "POST",
      body: JSON.stringify({ new_password: newPassword }),
    });
    passwordChangeForm.reset();
    await refreshAuthenticatedContext();
  } catch (error) {
    passwordChangeForm.reset();
    setAuthError(authErrorMessage(error.message));
  } finally {
    setAuthBusy(false);
  }
});

companySelect.addEventListener("change", () => {
  lockLocalIdentity();
  setAuthError();
  if (companySelect.value) void loadOperationalCatalog(companySelect.value);
  else resetCatalog("Elige una empresa.");
});

siteSelect.addEventListener("change", () => {
  lockLocalIdentity();
  const siteId = siteSelect.value;
  const houses =
    operationalCatalog?.houses.filter((house) => house.site_id === siteId) ??
    [];
  replaceOptions(houseSelect, houses, "Sin galpones activos");
  replaceOptions(lotSelect, [], "Elige galpón primero");
  $("#catalogStatus").textContent = houses.length
    ? `${houses.length} galpón(es) autorizados en esta sede.`
    : "No hay galpones activos autorizados en esta sede.";
});

houseSelect.addEventListener("change", () => {
  lockLocalIdentity();
  const siteId = siteSelect.value;
  const houseId = houseSelect.value;
  const lots =
    operationalCatalog?.lots.filter(
      (lot) => lot.site_id === siteId && lot.house_id === houseId,
    ) ?? [];
  replaceOptions(lotSelect, lots, "Sin lotes activos");
  $("#catalogStatus").textContent = lots.length
    ? `${lots.length} lote(s) autorizado(s) en este galpón.`
    : "No hay lotes activos autorizados en este galpón.";
});

$("#refreshSession").addEventListener("click", async () => {
  if (authRequestBusy) return;
  setAuthBusy(true);
  try {
    await refreshAuthenticatedContext();
  } finally {
    setAuthBusy(false);
  }
});

$("#retryCatalog").addEventListener("click", () => {
  setAuthError();
  void refreshAuthenticatedContext();
});

$("#logout").addEventListener("click", async () => {
  if (authRequestBusy) return;
  authenticatedUserId = null;
  authEpoch += 1;
  lockLocalIdentity();
  setAuthError();
  setAuthBusy(true);
  try {
    await authenticatedRequest("/v1/auth/logout", { method: "POST" });
    resetCatalog();
    passwordChangeForm.hidden = true;
    authLoginForm.hidden = false;
    authLoginForm.reset();
    $("#authStatus").textContent = "Sesión cerrada en el servidor.";
  } catch (error) {
    setAuthError(authErrorMessage(error.message));
  } finally {
    resetCatalog();
    passwordChangeForm.hidden = true;
    authLoginForm.hidden = false;
    await identityUi?.refresh();
    setAuthBusy(false);
  }
});

lotSelect.addEventListener("change", () => {
  lockLocalIdentity();
  void identityUi?.refresh();
});
void mountPasswordIdentity({
  request: authenticatedRequest,
  authenticatedUser: () => authenticatedUserId,
  selectedScope: selectedIdentityScope,
})
  .then((ui) => {
    identityUi = ui;
    return ui.refresh();
  })
  .catch((error) => {
    $("#identityError").textContent =
      `No se pudo preparar el acceso local: ${error.message}`;
    $("#identityError").hidden = false;
  });

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
    ? "Conexión disponible según el dispositivo; las recogidas sintéticas todavía no se sincronizan."
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
setAuthBusy(true);
void refreshAuthenticatedContext().finally(() => setAuthBusy(false));
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
