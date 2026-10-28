import { mountOriginSummary } from "./origin-summary.js";

const $ = (selector) => document.querySelector(selector);
const forms = ["receiptForm", "evidenceForm", "submitForm", "reviewForm"];
const states = {
  open: "Abierta",
  investigating: "En investigación",
  submitted_to_direction: "Presentada a Dirección",
};
const actions = {
  add_evidence: "Antecedente agregado",
  submit: "Investigación presentada",
  request_evidence: "Solicitud de evidencia",
  continue_investigation: "Continúa investigación",
};
const evidenceKinds = {
  count_record: "Recuento",
  origin_card: "Tarjeta de origen",
  sender_statement: "Antecedente de quien entrega",
  transfer_note: "Nota de traslado",
  photo_reference: "Referencia a foto",
  other: "Otro soporte",
  missing: "Soporte faltante",
};
const dateTime = (value) =>
  new Date(value).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
let generation = 0,
  user = null,
  company = "",
  context = null,
  selected = "",
  nextList = null,
  nextEvidence = null,
  nextHistory = null;
let busy = false,
  pending = null,
  mustRefresh = false;
let origin = null,
  originRows = [],
  nextOrigins = null,
  originStale = true;
const originKey = (row) =>
  [
    row.company_id,
    row.site_id,
    row.house_id,
    row.lot_id,
    row.business_date,
  ].join("/");
const todayColombia = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
function message(text) {
  $("#message").textContent = text;
  $("#error").hidden = true;
}
function error(text) {
  $("#error").textContent = text;
  $("#error").hidden = false;
}
function explain(code) {
  return (
    {
      CUSTODY_CONFLICT:
        "El expediente cambió o no admite esta acción. Conserva tus datos y actualiza antes de volver a registrar.",
      CUSTODY_FORBIDDEN:
        "Tu permiso actual no permite esta acción. Actualiza el expediente.",
      CUSTODY_NOT_FOUND: "El traslado ya no está disponible en tu ámbito.",
      INVALID_CUSTODY_REQUEST:
        "Revisa los datos; el servidor no aceptó la solicitud.",
      INVALID_ORIGIN_DATE: "Selecciona una fecha de recogida válida.",
      INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
      PASSWORD_CHANGE_REQUIRED: "Debes cambiar la contraseña temporal.",
      SESSION_IDENTITY_MISMATCH:
        "La sesión corresponde a otra persona. Inicia sesión de nuevo.",
    }[code] ?? "No fue posible confirmar la operación. Comprueba la conexión."
  );
}
const flowSummary = mountOriginSummary({
  request: api,
  currentCompany: () => company,
  currentGeneration: () => generation,
});
function clear(keepPending = false) {
  generation++;
  flowSummary.clear();
  user = null;
  company = "";
  context = null;
  selected = "";
  busy = false;
  mustRefresh = false;
  origin = null;
  originRows = [];
  nextOrigins = null;
  originStale = true;
  if (!keepPending) pending = null;
  for (const id of [
    "workspace",
    "detail",
    "loginPanel",
    "passwordPanel",
    "logout",
    "dispatchPanel",
  ])
    $(`#${id}`).hidden = true;
  for (const id of ["transfers", "evidence", "history", "company", "origins"])
    $(`#${id}`).replaceChildren();
  for (const id of forms) $(`#${id}`).reset();
  $("#dispatchForm").reset();
  $("#originDate").value = todayColombia();
  $("#flowDate").value = todayColombia();
  $("#dispatchOrigin").textContent = "";
  $("#originsStatus").textContent = "";
  $("#pendingSummary").textContent = "";
  $("#loginForm").reset();
  $("#passwordForm").reset();
  $("#identity").textContent = "";
  $("#identity").removeAttribute("title");
  $("#originTitle").textContent = "";
  $("#quantities").textContent = "";
  $("#previousSummary").textContent = "";
  $("#locations").textContent = "";
  $("#caseStatus").textContent = "";
}
function controls() {
  for (const id of forms)
    for (const element of $(`#${id}`).elements)
      element.disabled = busy || Boolean(pending) || mustRefresh;
  for (const element of document.querySelectorAll(
    "#transfers button,#company,#refreshList,#refreshDetail,#moreTransfers,#moreEvidence,#moreHistory,#origins button,#originDate,#refreshOrigins,#moreOrigins,#flowDate,#refreshFlow,#moreFlow",
  ))
    element.disabled = busy || Boolean(pending);
  $("#retryPanel").hidden = !pending;
  $("#retry").disabled = busy;
  $("#pendingSummary").textContent = pending?.description ?? "";
  for (const element of $("#dispatchForm").elements)
    element.disabled =
      busy ||
      Boolean(pending) ||
      originStale ||
      !origin ||
      origin.quantity_available <= 0;
}
async function api(path, options = {}) {
  const current = generation;
  const response = await fetch(path, {
    ...options,
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(path.includes("/custody-") && user ? { "x-tamago-user": user } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (current !== generation) throw new Error("STALE");
  if (!response.ok) {
    if (response.status === 401 || body.error === "SESSION_IDENTITY_MISMATCH") {
      clear(response.status === 401);
      $("#loginPanel").hidden = false;
      message("La sesión cambió o venció. Inicia sesión para continuar.");
    }
    throw Object.assign(new Error(body.error ?? "REQUEST_FAILED"), {
      status: response.status,
    });
  }
  return body;
}
async function safely(fn) {
  try {
    await fn();
  } catch (cause) {
    if (cause.message !== "STALE") error(explain(cause.message));
  }
}
async function withBusy(fn) {
  if (busy || pending) return;
  const current = generation;
  busy = true;
  controls();
  try {
    await fn();
  } finally {
    if (current === generation) {
      busy = false;
      controls();
    }
  }
}
function endpoint(tail) {
  return `/v1/companies/${company}/${tail}`;
}
function label(text, tag = "p") {
  const element = document.createElement(tag);
  element.textContent = text;
  return element;
}
function paintOrigin() {
  $("#dispatchOrigin").textContent = origin
    ? `${origin.house_name} · ${origin.lot_code} · origen ${origin.business_date} · ${origin.occurrences} recogida(s) recibida(s) por servidor · ${origin.quantity_collected} huevos registrados · ${origin.quantity_sent} enviados · ${origin.quantity_available} disponibles para entrega`
    : "Selecciona el origen diario de la entrega.";
  $("#dispatchForm").hidden = !origin || origin.quantity_available <= 0;
  if (origin) {
    $("#dispatchForm [name=quantity]").max = String(
      Math.min(origin.quantity_available, 2147483647),
    );
    if (!$("#dispatchForm [name=sent_from]").value)
      $("#dispatchForm [name=sent_from]").value = origin.house_name;
  }
  for (const button of $("#origins").querySelectorAll("button"))
    button.setAttribute(
      "aria-current",
      String(origin && button.dataset.key === originKey(origin)),
    );
  controls();
}
async function loadOrigins(append = false) {
  const current = generation;
  originStale = true;
  controls();
  $("#originsStatus").textContent =
    "Consultando recogidas recibidas por servidor…";
  $("#origins").setAttribute("aria-busy", "true");
  try {
    const date = $("#originDate").value;
    if (!date) throw new Error("INVALID_ORIGIN_DATE");
    const data = await api(
      endpoint(
        `custody-origins?business_date=${encodeURIComponent(date)}&offset=${append ? nextOrigins : 0}`,
      ),
    );
    $("#dispatchPanel").hidden = !data.authorized;
    const selectedKey = origin ? originKey(origin) : null;
    if (!append) {
      originRows = [];
      $("#origins").replaceChildren();
    }
    originRows.push(...data.items);
    for (const row of data.items) {
      const item = document.createElement("li"),
        button = document.createElement("button");
      button.type = "button";
      button.dataset.key = originKey(row);
      button.textContent = `${row.house_name} · ${row.lot_code} · ${row.business_date} · ${row.quantity_available} huevos disponibles para entrega`;
      button.addEventListener("click", () => {
        if (busy || pending) return;
        origin = row;
        $("#dispatchForm").reset();
        paintOrigin();
        if (row.quantity_available > 0)
          $("#dispatchForm [name=quantity]").focus();
      });
      item.append(button);
      $("#origins").append(item);
    }
    origin = originRows.find((row) => originKey(row) === selectedKey) ?? null;
    nextOrigins = data.next_offset;
    $("#moreOrigins").hidden = nextOrigins === null;
    $("#originsStatus").textContent = originRows.length
      ? "Elige un único lote, galpón y día de recogida."
      : "Sin recogidas recibidas en servidor para esta fecha y tu ámbito. No se interpreta como cero producción.";
    originStale = false;
    paintOrigin();
  } catch (cause) {
    if (current === generation)
      $("#originsStatus").textContent =
        "No se pudieron actualizar los orígenes.";
    throw cause;
  } finally {
    if (current === generation)
      $("#origins").setAttribute("aria-busy", "false");
  }
}
function paint() {
  if (!context) return;
  const { transfer: t, incident: i, permissions: p } = context;
  $("#detail").hidden = false;
  $("#originTitle").textContent =
    `${t.house_name} · ${t.lot_code} · ${t.origin_business_date}`;
  $("#quantities").textContent =
    `${t.quantity_sent} huevos enviados · ${t.received_quantity === null ? "Sin recepción registrada" : `${t.received_quantity} huevos recibidos`}`;
  $("#locations").textContent =
    `${t.sent_from} → ${t.sent_to}${t.received_at_location ? ` · Descarga: ${t.received_at_location}` : ""}`;
  $("#caseStatus").textContent = i
    ? `${states[i.status]} · diferencia enviada − recibida: ${i.quantity_difference} huevos · revisión ${i.revision}`
    : t.status === "received"
      ? "Recepción registrada sin diferencia."
      : "En tránsito · confirma la cantidad real al descargar.";
  $("#receiptForm").hidden = !p.receive;
  $("#casePanel").hidden = !i;
  $("#evidenceForm").hidden = !p.evidence;
  $("#submitForm").hidden = !p.submit;
  $("#reviewForm").hidden = !p.review;
  $("#previousSummary").textContent = i?.investigation_summary
    ? `Última presentación: ${i.investigation_summary}`
    : "";
  for (const button of $("#transfers").querySelectorAll("button"))
    button.setAttribute("aria-current", String(button.dataset.id === selected));
  controls();
}
async function list(append = false) {
  const data = await api(
    endpoint(`custody-transfers?offset=${append ? nextList : 0}`),
  );
  if (!append) $("#transfers").replaceChildren();
  for (const t of data.items) {
    const item = document.createElement("li"),
      button = document.createElement("button");
    button.type = "button";
    button.dataset.id = t.transfer_id;
    button.setAttribute("aria-current", String(t.transfer_id === selected));
    button.textContent = `${t.house_name} · ${t.lot_code} · ${t.origin_business_date} · ${t.quantity_sent} huevos · ${t.status === "received" ? "Recepción registrada" : "Por recibir"}`;
    button.addEventListener("click", () =>
      safely(async () => {
        if (busy || pending) return;
        generation++;
        selected = t.transfer_id;
        context = null;
        for (const id of forms) $(`#${id}`).reset();
        $("#detail").hidden = true;
        busy = true;
        controls();
        const current = generation;
        try {
          await detail();
          $("#originTitle").focus();
        } finally {
          if (current === generation) {
            busy = false;
            controls();
          }
        }
      }),
    );
    item.append(button);
    $("#transfers").append(item);
  }
  nextList = data.next_offset;
  $("#moreTransfers").hidden = nextList === null;
  $("#listStatus").textContent = $("#transfers").children.length
    ? "Selecciona un traslado para revisar su recepción."
    : "No hay traslados visibles para esta empresa y tu ámbito.";
  controls();
}
function renderEntries(kind, items, append = false) {
  const target = $(kind === "actions" ? "#history" : "#evidence");
  if (!append) target.replaceChildren();
  for (const entry of items) {
    const item = document.createElement("li");
    item.append(
      label(
        kind === "actions"
          ? `Revisión ${entry.revision_after} · ${actions[entry.action_type]}`
          : (evidenceKinds[entry.evidence_kind] ?? "Antecedente"),
        "strong",
      ),
    );
    const details = entry.command_payload?.details;
    item.append(
      label(
        kind === "actions"
          ? (details?.summary ?? details?.reason ?? details?.notes ?? "")
          : entry.notes,
      ),
    );
    if (entry.reference) item.append(label(`Referencia: ${entry.reference}`));
    const actor = entry.actor_id ?? entry.recorded_by;
    const metadata = label(
      `${dateTime(entry.recorded_at)} (Colombia) · usuario ${actor.slice(0, 8)}`,
      "small",
    );
    metadata.title = actor;
    item.append(metadata);
    target.append(item);
  }
  if (!target.children.length)
    target.append(
      label(
        kind === "actions"
          ? "Sin acciones en el historial de esta versión."
          : "Sin antecedentes registrados.",
        "li",
      ),
    );
}
async function entries(kind, append = false) {
  const history = kind === "actions",
    cursor = append ? (history ? nextHistory : nextEvidence) : 0;
  const data = await api(
    endpoint(
      `custody-incidents/${context.incident.incident_id}/${kind}?${history ? "after_revision" : "offset"}=${cursor}`,
    ),
  );
  renderEntries(kind, data.items, append);
  if (history) nextHistory = data.next_cursor;
  else nextEvidence = data.next_cursor;
  $(history ? "#moreHistory" : "#moreEvidence").hidden =
    data.next_cursor === null;
}
async function detail() {
  const current = generation;
  mustRefresh = true;
  $("#detail").setAttribute("aria-busy", "true");
  try {
    const data = await api(endpoint(`custody-transfers/${selected}`));
    context = data;
    paint();
    if (context.incident)
      await Promise.all([entries("evidence"), entries("actions")]);
    else {
      $("#evidence").replaceChildren();
      $("#history").replaceChildren();
    }
    mustRefresh = false;
    controls();
  } finally {
    if (current === generation) $("#detail").setAttribute("aria-busy", "false");
  }
}
async function chooseCompany() {
  generation++;
  company = $("#company").value;
  flowSummary.clear();
  context = null;
  selected = "";
  $("#detail").hidden = true;
  $("#transfers").replaceChildren();
  origin = null;
  originRows = [];
  originStale = true;
  $("#origins").replaceChildren();
  $("#dispatchForm").reset();
  $("#dispatchPanel").hidden = true;
  if (!company) return;
  const current = generation;
  busy = true;
  controls();
  try {
    await Promise.all([list(), loadOrigins(), flowSummary.load()]);
    if (pending?.company === company && pending.form !== "dispatchForm") {
      selected = pending.transfer;
      await detail();
    }
  } finally {
    if (current === generation) {
      busy = false;
      controls();
    }
  }
}
async function enter(session) {
  const retained = pending?.owner === session.user_id ? pending : null;
  clear();
  pending = retained;
  user = session.user_id;
  $("#logout").hidden = false;
  if (session.password_change_required) {
    $("#passwordPanel").hidden = false;
    return;
  }
  const companies = await api("/v1/companies");
  const select = $("#company");
  for (const company of companies) {
    const option = document.createElement("option");
    option.value = company.id;
    option.textContent = company.legal_name;
    select.append(option);
  }
  if (pending && companies.some((c) => c.id === pending.company))
    select.value = pending.company;
  else pending = null;
  if (pending?.form === "dispatchForm")
    $("#originDate").value = JSON.parse(pending.body).origin_business_date;
  $("#workspace").hidden = false;
  $("#identity").textContent =
    `Acceso personal verificado · usuario ${user.slice(0, 8)}`;
  $("#identity").title = user;
  await chooseCompany();
  message(
    companies.length
      ? "Consulta conectada al servidor."
      : "No tienes empresas disponibles.",
  );
  controls();
}
async function sendPending() {
  if (busy || !pending || pending.owner !== user) return;
  const current = generation,
    operation = pending;
  busy = true;
  controls();
  message("Esperando confirmación del servidor…");
  try {
    await api(operation.url, { method: "POST", body: operation.body });
  } catch (cause) {
    if (current !== generation) return;
    if (cause.status && cause.status < 500) {
      pending = null;
      if (operation.form === "dispatchForm") originStale = true;
      else mustRefresh = true;
    }
    error(
      operation.form === "dispatchForm" && cause.status === 409
        ? "El origen cambió o no tiene suficientes huevos. Actualiza los orígenes antes de volver a entregar."
        : explain(cause.message),
    );
    busy = false;
    controls();
    return;
  }
  if (current !== generation) return;
  pending = null;
  mustRefresh = true;
  $(`#${operation.form}`).reset();
  message("Confirmado por el servidor.");
  try {
    if (operation.form === "dispatchForm") {
      selected = operation.transfer;
      context = null;
      $("#detail").hidden = true;
      await Promise.all([list(), loadOrigins()]);
    }
    await detail();
  } catch (cause) {
    if (current === generation)
      error(
        `La operación se confirmó, pero falta actualizar el expediente. ${explain(cause.message)}`,
      );
  }
  if (current === generation) {
    busy = false;
    controls();
  }
}
function queue(form, url, body, transferId = selected, description = "") {
  if (busy || pending || (form === "dispatchForm" ? originStale : mustRefresh))
    return;
  pending = {
    form,
    url,
    body: JSON.stringify(body),
    owner: user,
    company,
    transfer: transferId,
    description,
  };
  void safely(sendPending);
}
$("#dispatchForm").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!origin || origin.quantity_available <= 0) return;
  const values = new FormData(event.currentTarget),
    transferId = crypto.randomUUID();
  const body = {
    schema_version: 1,
    transfer_id: transferId,
    company_id: company,
    site_id: origin.site_id,
    house_id: origin.house_id,
    lot_id: origin.lot_id,
    origin_business_date: origin.business_date,
    quantity_sent: Number(values.get("quantity")),
    sent_from: values.get("sent_from"),
    sent_to: values.get("sent_to"),
    sent_at: new Date().toISOString(),
  };
  queue(
    "dispatchForm",
    endpoint("custody-transfers"),
    body,
    transferId,
    `${origin.house_name} · ${origin.lot_code} · origen ${origin.business_date} · entrega de ${body.quantity_sent} huevos`,
  );
});
$("#receiptForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(event.currentTarget);
  queue("receiptForm", endpoint(`custody-transfers/${selected}/receipt`), {
    received_quantity: Number(values.get("quantity")),
    received_at_location: values.get("location"),
    received_at: new Date().toISOString(),
    receiver_note: values.get("note") || null,
  });
});
for (const [form, action] of [
  ["evidenceForm", "add_evidence"],
  ["submitForm", "submit"],
  ["reviewForm", null],
]) {
  $(`#${form}`).addEventListener("submit", (event) => {
    event.preventDefault();
    if (!context?.incident) return;
    const fields = Object.fromEntries(new FormData(event.currentTarget));
    const type = action ?? fields.action;
    const details =
      type === "add_evidence"
        ? {
            kind: fields.kind,
            reference: fields.reference || null,
            notes: fields.notes,
          }
        : type === "submit"
          ? { summary: fields.summary }
          : { reason: fields.reason };
    queue(form, endpoint("custody-case-actions"), {
      schema_version: 1,
      command_id: crypto.randomUUID(),
      company_id: company,
      incident_id: context.incident.incident_id,
      expected_revision: context.incident.revision,
      action: type,
      details,
    });
  });
}
$("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  const current = generation;
  const button = event.currentTarget.querySelector("button");
  button.disabled = true;
  void safely(async () => {
    try {
      const session = await api("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify(fields),
      });
      $("#loginForm").reset();
      await enter(session);
    } finally {
      if (current <= generation) button.disabled = false;
    }
  });
});
$("#passwordForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  if (fields.password !== fields.confirmation) {
    error("Las contraseñas deben coincidir.");
    return;
  }
  void safely(async () => {
    await api("/v1/auth/change-initial-password", {
      method: "POST",
      body: JSON.stringify({ new_password: fields.password }),
    });
    $("#passwordForm").reset();
    await enter(await api("/v1/auth/me"));
  });
});
$("#logout").addEventListener("click", () => {
  clear();
  message("Cerrando sesión…");
  $("#logout").hidden = false;
  $("#loginPanel").hidden = true;
  void safely(async () => {
    try {
      await api("/v1/auth/logout", { method: "POST", body: "{}" });
      $("#logout").hidden = true;
      $("#loginPanel").hidden = false;
      message("Sesión cerrada.");
    } catch (cause) {
      error("No se confirmó el cierre. Reintenta cerrar sesión.");
      throw cause;
    }
  });
});
$("#company").addEventListener("change", () => {
  void safely(chooseCompany);
});
$("#originDate").addEventListener("change", () => {
  if (busy || pending) return;
  generation++;
  origin = null;
  originRows = [];
  $("#origins").replaceChildren();
  $("#dispatchForm").reset();
  $("#dispatchForm").hidden = true;
  void safely(() => withBusy(() => loadOrigins()));
});
$("#refreshOrigins").addEventListener("click", () => {
  void safely(() =>
    withBusy(async () => {
      await loadOrigins();
      message("Orígenes actualizados desde servidor.");
    }),
  );
});
$("#moreOrigins").addEventListener("click", () => {
  void safely(() => withBusy(() => loadOrigins(true)));
});
$("#refreshList").addEventListener("click", () => {
  void safely(() => withBusy(() => list()));
});
$("#refreshDetail").addEventListener("click", () => {
  void safely(() =>
    withBusy(async () => {
      try {
        await detail();
        message("Expediente actualizado.");
      } catch (cause) {
        if (cause.status === 404 || cause.status === 403) {
          $("#detail").hidden = true;
          context = null;
        }
        throw cause;
      }
    }),
  );
});
$("#moreTransfers").addEventListener("click", () => {
  void safely(() => withBusy(() => list(true)));
});
$("#moreEvidence").addEventListener("click", () => {
  void safely(() => withBusy(() => entries("evidence", true)));
});
$("#moreHistory").addEventListener("click", () => {
  void safely(() => withBusy(() => entries("actions", true)));
});
$("#retry").addEventListener("click", () => {
  void safely(sendPending);
});
window.addEventListener("beforeunload", (event) => {
  if (pending) {
    event.preventDefault();
    event.returnValue = "";
  }
});
window.addEventListener("focus", () => {
  if (user)
    void safely(async () => {
      const actual = await api("/v1/auth/me");
      if (actual.user_id !== user) {
        clear();
        $("#loginPanel").hidden = false;
        message("Cambió la sesión. Inicia sesión otra vez.");
      }
    });
});
void safely(async () => {
  message("Verificando sesión…");
  try {
    await enter(await api("/v1/auth/me"));
  } catch (cause) {
    if (cause.status !== 401) throw cause;
  }
});

$("#flowDate").addEventListener(
  "change",
  () => void safely(() => withBusy(() => flowSummary.load())),
);
$("#refreshFlow").addEventListener(
  "click",
  () => void safely(() => withBusy(() => flowSummary.load())),
);
$("#moreFlow").addEventListener(
  "click",
  () => void safely(() => withBusy(() => flowSummary.load(true))),
);
