import { assertOperationalCatalog } from "../offline/catalog-contract.mjs";
import {
  normalizeFeedQuantity,
  validateFeedReceipt,
  validateFeedSupply,
} from "../shared/feed-supply-contract.mjs";

const $ = (s) => document.querySelector(s);
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const timeNow = () =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date());
let user = null,
  company = "",
  generation = 0,
  busy = false,
  directory = null,
  scope = [],
  review = null,
  pending = null,
  next = null;
const base = () => `/v1/companies/${company}`;
const text = (tag, value) => {
  const el = document.createElement(tag);
  el.textContent = value;
  return el;
};
function say(value) {
  $("#message").textContent = value;
}
function fail(code) {
  throw new Error(code);
}
function explain(code) {
  return (
    {
      INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
      INVALID_FEED_SUPPLY:
        "Revisa la cantidad, el producto y la fecha/hora Colombia.",
      FEED_SUPPLY_FORBIDDEN:
        "Tu permiso actual no permite registrar este suministro. Conserva la solicitud y comprueba tus permisos.",
      FEED_SUPPLY_CONFLICT:
        "El ID entró en conflicto. No cambies el ID ni registres otra vez; consulta el registro y solicita revisión.",
      FEED_SUPPLY_NOT_FOUND: "El registro no está disponible en tu ámbito.",
      INVALID_RECEIPT:
        "La respuesta no coincide con el registro. No se confirmó el guardado.",
      INVALID_HISTORY:
        "La respuesta del historial no es válida. Vuelve a consultar.",
      SESSION_IDENTITY_MISMATCH:
        "La sesión cambió de persona. Se retiraron los datos de la cuenta anterior; vuelve a identificarte.",
      AUTHENTICATION_REQUIRED:
        "La sesión no está disponible. Vuelve a identificarte.",
      PASSWORD_CHANGE_REQUIRED: "Cambia tu contraseña temporal para continuar.",
      INVALID_CATALOG:
        "No se pudo verificar el catálogo o los permisos. Comprueba la sesión.",
    }[code] ??
    "No se pudo confirmar la operación. Conserva esta pestaña y comprueba la conexión."
  );
}
function permitted() {
  return (
    scope.find((row) => row.lot_id === $("#lot").value)?.can_record === true
  );
}
function locks() {
  $("#captureFields").disabled = busy || !!review || !!pending || !permitted();
  for (const id of ["company", "lot"])
    $(`#${id}`).disabled = busy || !!review || !!pending;
  $("#review").disabled =
    busy || !!review || !!pending || !permitted() || !navigator.onLine;
  $("#confirm").disabled = busy || !!pending || !review || !navigator.onLine;
  $("#edit").disabled = busy || !!pending;
  $("#retry").disabled = busy || !pending || !navigator.onLine;
  for (const id of [
    "logout",
    "refreshAccount",
    "historyDate",
    "refreshHistory",
    "moreHistory",
  ])
    $(`#${id}`).disabled = busy;
  for (const form of ["loginForm", "passwordForm", "lookupForm"])
    for (const el of $(`#${form}`).elements) el.disabled = busy;
  $("#supplyForm").setAttribute("aria-busy", String(busy));
}
function clear() {
  generation++;
  user = null;
  company = "";
  directory = null;
  scope = [];
  review = null;
  pending = null;
  next = null;
  for (const id of [
    "workspace",
    "accountPanel",
    "passwordPanel",
    "pendingPanel",
    "reviewPanel",
    "logout",
  ])
    $(`#${id}`).hidden = true;
  for (const id of ["company", "lot", "history", "detail"])
    $(`#${id}`).replaceChildren();
  for (const id of [
    "receiptStatus",
    "reviewSummary",
    "pendingSummary",
    "identity",
    "historyStatus",
    "permissionStatus",
  ])
    $(`#${id}`).textContent = "";
  $("#supplyForm").reset();
  $("#lookupForm").reset();
  $("#moreHistory").hidden = true;
  $("#businessDate").value = today();
  $("#occurredTime").value = timeNow();
  $("#historyDate").value = today();
}
async function api(path, { method = "GET", body } = {}, epoch = generation) {
  let response, data;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: {
        "content-type": "application/json",
        ...(user ? { "x-tamago-user": user } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15000),
    });
    data = await response.json();
  } catch {
    if (epoch !== generation) fail("CANCELLED");
    fail("NETWORK_UNCERTAIN");
  }
  if (epoch !== generation) fail("CANCELLED");
  if (!response.ok)
    throw Object.assign(new Error(data?.error ?? "UNAVAILABLE"), {
      status: response.status,
    });
  return data;
}
async function run(action) {
  if (busy) return;
  busy = true;
  $("#error").hidden = true;
  locks();
  try {
    await action();
  } catch (error) {
    if (error.message !== "CANCELLED") {
      if (
        error.status === 401 ||
        error.message === "SESSION_IDENTITY_MISMATCH"
      ) {
        clear();
        $("#loginPanel").hidden = false;
      }
      $("#error").textContent = explain(error.message);
      $("#error").hidden = false;
    }
  } finally {
    busy = false;
    locks();
  }
}
async function verifyActor() {
  const me = await api("/v1/auth/me");
  if (me.user_id !== user || me.password_change_required)
    fail("SESSION_IDENTITY_MISMATCH");
}
async function enter(me) {
  if (!uuid.test(me.user_id ?? "")) fail("INVALID_SESSION");
  clear();
  user = me.user_id;
  $("#loginPanel").hidden = true;
  $("#logout").hidden = false;
  $("#identity").textContent = `Cuenta verificada · ${user}`;
  if (me.password_change_required) {
    $("#passwordPanel").hidden = false;
    return;
  }
  const companies = await api("/v1/companies");
  if (
    !Array.isArray(companies) ||
    companies.some(
      (row) => !uuid.test(row.id ?? "") || typeof row.legal_name !== "string",
    )
  )
    fail("INVALID_CATALOG");
  $("#company").add(new Option("Elige empresa…", ""));
  for (const row of companies)
    $("#company").add(new Option(row.legal_name, row.id));
  $("#accountPanel").hidden = false;
  if (companies.length === 1) {
    $("#company").value = companies[0].id;
    await chooseCompany();
  }
  say(
    companies.length
      ? "Captura conectada; solo el acuse confirma el registro en servidor."
      : "No tienes empresas activas asignadas.",
  );
}
function lotLabel(id) {
  const lot = directory?.lots.find((row) => row.id === id);
  if (!lot) return `Lote ${id}`;
  return `${lot.code} · ${directory.houses.find((row) => row.id === lot.house_id)?.name ?? lot.house_id} · ${directory.sites.find((row) => row.id === lot.site_id)?.name ?? lot.site_id}`;
}
async function loadContext() {
  // Remove stale write permission before starting either read.
  scope = [];
  locks();
  const [catalog, permissions] = await Promise.all([
    api(`${base()}/operational-catalog`),
    api(`${base()}/feed-supply-context`),
  ]);
  try {
    assertOperationalCatalog(catalog, company);
  } catch {
    fail("INVALID_CATALOG");
  }
  if (
    permissions?.company_id !== company ||
    !Array.isArray(permissions.lots) ||
    permissions.lots.some(
      (row) =>
        !uuid.test(row?.lot_id ?? "") || typeof row.can_record !== "boolean",
    ) ||
    new Set(permissions.lots.map((row) => row.lot_id)).size !==
      permissions.lots.length
  )
    fail("INVALID_CATALOG");
  if (
    catalog.lots.some(
      (lot) =>
        catalog.houses.find((row) => row.id === lot.house_id)?.site_id !==
        lot.site_id,
    )
  )
    fail("INVALID_CATALOG");
  directory = catalog;
  scope = permissions.lots;
  const selected = $("#lot").value;
  $("#lot").replaceChildren(new Option("Elige lote y galpón…", ""));
  for (const lot of directory.lots.filter((row) =>
    scope.some((item) => item.lot_id === row.id),
  ))
    $("#lot").add(
      new Option(
        lotLabel(lot.id) +
          (scope.find((row) => row.lot_id === lot.id).can_record
            ? ""
            : " · solo consulta"),
        lot.id,
      ),
    );
  if ([...$("#lot").options].some((row) => row.value === selected))
    $("#lot").value = selected;
  permissionStatus();
}
function permissionStatus() {
  $("#permissionStatus").textContent = permitted()
    ? "Puedes registrar en este lote. El servidor comprobará nuevamente el permiso al confirmar."
    : "Elige un lote con permiso de captura. Dirección puede consultar sin tener permiso de registro.";
}
async function chooseCompany() {
  generation++;
  company = $("#company").value;
  directory = null;
  scope = [];
  review = null;
  pending = null;
  next = null;
  $("#history").replaceChildren();
  $("#detail").replaceChildren();
  $("#lot").replaceChildren();
  $("#supplyForm").reset();
  $("#businessDate").value = today();
  $("#occurredTime").value = timeNow();
  for (const id of ["reviewPanel", "pendingPanel"]) $(`#${id}`).hidden = true;
  $("#receiptStatus").textContent = "";
  $("#workspace").hidden = !company;
  $("#moreHistory").hidden = true;
  if (company) {
    await verifyActor();
    await loadContext();
    await loadHistory();
  }
}
function makeEvent() {
  const lot = directory?.lots.find((row) => row.id === $("#lot").value),
    quantity = normalizeFeedQuantity($("#quantity").value);
  if (!permitted() || !lot || quantity === null) fail("INVALID_FEED_SUPPLY");
  const date = $("#businessDate").value,
    time = $("#occurredTime").value;
  if (!/^\d{2}:\d{2}$/.test(time)) fail("INVALID_FEED_SUPPLY");
  const occurred = new Date(`${date}T${time}:00.000-05:00`);
  if (!Number.isFinite(occurred.getTime())) fail("INVALID_FEED_SUPPLY");
  const event = {
    schema_version: 1,
    event_id: crypto.randomUUID(),
    company_id: company,
    site_id: lot.site_id,
    house_id: lot.house_id,
    lot_id: lot.id,
    business_date: date,
    occurred_at: occurred.toISOString(),
    product_declared: $("#product").value.trim(),
    quantity,
    unit: "BAG_40KG",
    source_declared: $("#source").value.trim() || null,
    physical_batch_declared: $("#physicalBatch").value.trim() || null,
    notes: $("#notes").value || null,
  };
  if (!validateFeedSupply(event, company)) fail("INVALID_FEED_SUPPLY");
  return event;
}
function summary(event) {
  return `${event.quantity.replace(".", ",")} bultos de 40 kg · ${event.product_declared}\n${lotLabel(event.lot_id)}\n${event.business_date} · ${new Date(event.occurred_at).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })} Colombia\nID ${event.event_id}`;
}
function validRow(receipt) {
  return (
    uuid.test(receipt?.recorded_by ?? "") &&
    validateFeedSupply(receipt?.event, company) &&
    validateFeedReceipt(receipt, receipt.event, receipt.recorded_by)
  );
}
function showDetail(receipt) {
  const region = $("#detail");
  region.replaceChildren(
    text("h3", "Registro confirmado en servidor"),
    text("p", summary(receipt.event)),
    text(
      "p",
      `Origen: ${receipt.event.source_declared ?? "No aportado"} · Lote físico: ${receipt.event.physical_batch_declared ?? "No aportado"}`,
    ),
    text("p", receipt.event.notes ?? "Sin observaciones"),
    text(
      "p",
      `Registrado por ${receipt.recorded_by} · ${new Date(receipt.recorded_at).toLocaleString("es-CO", { timeZone: "America/Bogota" })}. Saldo de bodega no comprobado.`,
    ),
  );
}
async function loadDetail(id) {
  $("#detail").replaceChildren();
  if (!uuid.test(id ?? "")) fail("INVALID_FEED_SUPPLY");
  const receipt = await api(`${base()}/feed-supplies/${id}`);
  if (!validRow(receipt) || receipt.event.event_id !== id)
    fail("INVALID_RECEIPT");
  showDetail(receipt);
  $("#detail").focus();
}
async function loadHistory(append = false) {
  const date = $("#historyDate").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("INVALID_HISTORY");
  $("#historyStatus").textContent =
    "Consultando registros recibidos en servidor…";
  $("#history").setAttribute("aria-busy", "true");
  try {
    const data = await api(
      `${base()}/feed-supplies?business_date=${date}&offset=${append ? next : 0}`,
    );
    if (
      data?.format !== "tamago.feed-supply-list" ||
      data.schema_version !== 1 ||
      data.company_id !== company ||
      data.business_date !== date ||
      !Array.isArray(data.items) ||
      data.items.length > 25 ||
      data.items.some(
        (row) => !validRow(row) || row.event.business_date !== date,
      ) ||
      !(
        data.next_offset === null ||
        (Number.isSafeInteger(data.next_offset) &&
          data.next_offset > 0 &&
          data.next_offset <= 100025)
      )
    )
      fail("INVALID_HISTORY");
    const seen = new Set(
      append ? [...$("#history").children].map((el) => el.dataset.id) : [],
    );
    for (const row of data.items) {
      if (seen.has(row.event.event_id)) fail("INVALID_HISTORY");
      seen.add(row.event.event_id);
    }
    if (!append) $("#history").replaceChildren();
    for (const row of data.items) {
      const li = document.createElement("li"),
        button = text("button", summary(row.event));
      li.dataset.id = row.event.event_id;
      button.type = "button";
      button.addEventListener(
        "click",
        () => void run(() => loadDetail(row.event.event_id)),
      );
      li.append(button);
      $("#history").append(li);
    }
    next = data.next_offset;
    $("#moreHistory").hidden = next === null;
    $("#historyStatus").textContent =
      data.items.length || append
        ? `${$("#history").children.length} registro(s) visibles. Actualiza para volver a consultar; las páginas pueden cambiar con nuevos registros.`
        : "Sin información de suministro para esta fecha en tu ámbito. No equivale a cero.";
  } catch (error) {
    $("#history").replaceChildren();
    $("#moreHistory").hidden = true;
    next = null;
    $("#historyStatus").textContent =
      "No se pudo consultar el historial. Vuelve a actualizar.";
    throw error;
  } finally {
    $("#history").setAttribute("aria-busy", "false");
  }
}
async function accept(receipt, event) {
  if (!validateFeedReceipt(receipt, event, user)) fail("INVALID_RECEIPT");
  pending = null;
  review = null;
  $("#pendingPanel").hidden = true;
  $("#reviewPanel").hidden = true;
  for (const id of ["product", "quantity", "source", "physicalBatch", "notes"])
    $(`#${id}`).value = "";
  $("#receiptStatus").textContent =
    `Registrado en servidor: ${event.quantity.replace(".", ",")} bultos de 40 kg. ID ${event.event_id}. Saldo de bodega no comprobado.`;
  showDetail(receipt);
  $("#historyDate").value = event.business_date;
  say("Suministro registrado en servidor con confirmación válida.");
  try {
    await loadHistory();
  } catch (error) {
    if (
      error.status === 401 ||
      error.message === "SESSION_IDENTITY_MISMATCH" ||
      error.message === "CANCELLED"
    )
      throw error;
    $("#error").textContent =
      "El suministro está confirmado; no se pudo actualizar el historial. Vuelve a consultarlo.";
    $("#error").hidden = false;
  }
}
async function sendPending(retry = false) {
  const operation = pending,
    epoch = generation;
  if (!operation) return;
  try {
    await verifyActor();
    if (retry) {
      let found;
      try {
        found = await api(`${base()}/feed-supplies/${operation.event_id}`);
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (found) {
        if (!validateFeedReceipt(found, operation, user))
          fail("FEED_SUPPLY_CONFLICT");
        await accept(found, operation);
        return;
      }
    }
    const receipt = await api(`${base()}/feed-supplies`, {
      method: "POST",
      body: operation,
    });
    await accept(receipt, operation);
  } catch (error) {
    if (epoch !== generation || error.message === "CANCELLED") throw error;
    if (pending === operation) {
      $("#pendingPanel").hidden = false;
      $("#pendingSummary").textContent = summary(operation);
      $("#pendingTitle").focus();
    }
    throw error;
  }
}
$("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  void run(async () => {
    const session = await api("/v1/auth/login", {
      method: "POST",
      body: fields,
    });
    $("#loginForm").reset();
    await enter(session);
  });
});
$("#passwordForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  if (fields.password !== fields.confirmation) {
    $("#error").textContent = "Las contraseñas deben coincidir.";
    $("#error").hidden = false;
    return;
  }
  void run(async () => {
    await api("/v1/auth/change-initial-password", {
      method: "POST",
      body: { new_password: fields.password },
    });
    $("#passwordForm").reset();
    await enter(await api("/v1/auth/me"));
  });
});
$("#logout").addEventListener(
  "click",
  () =>
    void run(async () => {
      clear();
      try {
        await api("/v1/auth/logout", { method: "POST", body: {} });
      } finally {
        $("#loginPanel").hidden = false;
        say("Sesión cerrada. Borrador de esta pestaña retirado.");
      }
    }),
);
$("#company").addEventListener("change", () => void run(chooseCompany));
$("#refreshAccount").addEventListener(
  "click",
  () =>
    void run(async () => {
      await verifyActor();
      if (company) {
        await loadContext();
        await loadHistory();
      }
      say(
        "Sesión y permisos comprobados. El borrador de esta pestaña se conserva.",
      );
    }),
);
$("#lot").addEventListener("change", () => {
  permissionStatus();
  locks();
});
$("#supplyForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy || pending || review) return;
  void run(async () => {
    review = makeEvent();
    $("#reviewSummary").textContent = summary(review);
    $("#reviewPanel").hidden = false;
    $("#reviewTitle").focus();
  });
});
$("#edit").addEventListener("click", () => {
  if (busy || pending) return;
  review = null;
  $("#reviewPanel").hidden = true;
  locks();
  $("#quantity").focus();
});
$("#confirm").addEventListener("click", () => {
  if (busy || pending || !review || !navigator.onLine) return;
  pending = structuredClone(review);
  void run(() => sendPending());
});
$("#retry").addEventListener("click", () => void run(() => sendPending(true)));
$("#historyDate").addEventListener(
  "change",
  () =>
    void run(async () => {
      $("#detail").replaceChildren();
      await loadHistory();
    }),
);
$("#refreshHistory").addEventListener(
  "click",
  () => void run(() => loadHistory()),
);
$("#moreHistory").addEventListener(
  "click",
  () => void run(() => loadHistory(true)),
);
$("#lookupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = new FormData(event.currentTarget).get("event_id");
  void run(() => loadDetail(id));
});
for (const state of ["online", "offline"])
  addEventListener(state, () => {
    locks();
    say(
      navigator.onLine
        ? "Conexión disponible; comprueba la sesión antes de continuar."
        : "Sin conexión. No se guarda alimento offline; conserva esta pestaña y vuelve a conectar.",
    );
  });
addEventListener("beforeunload", (event) => {
  if (pending || review || $("#quantity").value || $("#product").value) {
    event.preventDefault();
    event.returnValue = "";
  }
});
clear();
void run(async () => {
  try {
    await enter(await api("/v1/auth/me"));
  } catch (error) {
    $("#loginPanel").hidden = false;
    if (error.status !== 401) throw error;
    say("Inicia sesión para registrar o consultar suministros.");
  }
});
