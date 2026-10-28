const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const whole = (n, min = 1) =>
  Number.isSafeInteger(n) && n >= min && n <= 2147483647;
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
const short = (id) => String(id).slice(0, 8);
const groupKey = (row) =>
  [
    row.company_id,
    row.site_id,
    row.house_id,
    row.lot_id,
    row.origin_business_date,
  ].join("/");
const canonical = (value) =>
  JSON.stringify(value, (_key, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.keys(item)
            .sort()
            .map((key) => [key, item[key]]),
        )
      : item,
  );
let generation = 0,
  busy = false,
  user = null,
  company = "",
  catalog = null,
  sites = [],
  rows = [],
  group = "",
  authorized = false,
  nextInputs = null,
  nextSessions = null,
  lines = [],
  review = null,
  pending = null,
  view = "capture";
const root = () => `/v1/companies/${company}`;
function message(text) {
  $("#message").textContent = text;
  $("#liveMessage").textContent = text;
}
function showError(text) {
  $("#error").textContent = text;
  $("#error").hidden = false;
}
function explain(code) {
  return (
    {
      CLASSIFICATION_CONFLICT:
        "El saldo, estado o ID entró en conflicto. Conserva las cantidades y actualiza antes de revisar otra solicitud.",
      CLASSIFICATION_FORBIDDEN:
        "Tu permiso actual no permite registrar esta clasificación.",
      INVALID_MANUAL_CLASSIFICATION:
        "Revisa cantidades, origen y fecha/hora; el servidor no aceptó la solicitud.",
      INVALID_CREDENTIALS: "Correo o contraseña incorrectos.",
      SESSION_IDENTITY_MISMATCH:
        "La sesión corresponde a otra cuenta. Vuelve a identificarte.",
      AUTHENTICATION_REQUIRED: "Inicia sesión para continuar.",
      PASSWORD_CHANGE_REQUIRED: "Cambia la contraseña temporal para continuar.",
    }[code] ??
    "No se pudo completar la operación. Conserva esta pestaña y comprueba la conexión."
  );
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
    if (epoch !== generation) throw new Error("CANCELLED");
    throw Object.assign(new Error("NETWORK_UNCERTAIN"), { status: 503 });
  }
  if (epoch !== generation) throw new Error("CANCELLED");
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
    if (error.message === "CANCELLED") return;
    if (error.status === 401 || error.message === "SESSION_IDENTITY_MISMATCH") {
      clear();
      $("#loginPanel").hidden = false;
    }
    showError(explain(error.message));
  } finally {
    busy = false;
    locks();
  }
}
function blankLine() {
  return {
    line_id: crypto.randomUUID(),
    quantity_eggs: 0,
    typology: "UNKNOWN",
    condition: "NORMAL",
    destination: "PENDING",
  };
}
function resetDraft() {
  review = null;
  pending = null;
  $("#reviewOrigin").replaceChildren();
  $("#reviewLines").replaceChildren();
  lines = catalog ? [blankLine()] : [];
  for (const row of rows) {
    row.selected = false;
    row.processing = 0;
  }
  $("#machineReference").value = "";
  $("#notes").value = "";
  $("#reviewPanel").hidden = true;
  $("#uncertainNotice").hidden = true;
  $("#receiptStatus").hidden = true;
}
function clear() {
  generation++;
  user = null;
  company = "";
  catalog = null;
  rows = [];
  sites = [];
  group = "";
  authorized = false;
  nextInputs = null;
  nextSessions = null;
  resetDraft();
  $("#workspace").hidden = true;
  $("#accountPanel").hidden = true;
  $("#passwordPanel").hidden = true;
  $("#accountLabel").textContent = "Sin sesión";
  $("#sessionDetail").replaceChildren();
  $("#sessionList").replaceChildren();
  $("#companySelect").replaceChildren();
  render();
}
function selectedRows() {
  return rows.filter((row) => row.selected && groupKey(row) === group);
}
function totals() {
  const selected = selectedRows().reduce(
    (sum, row) => sum + (Number.isFinite(row.processing) ? row.processing : 0),
    0,
  );
  const distributed = lines.reduce(
    (sum, line) =>
      sum + (Number.isFinite(line.quantity_eggs) ? line.quantity_eggs : 0),
    0,
  );
  return { selected, distributed, difference: selected - distributed };
}
function classifiedAt() {
  const day = $("#classifiedDate").value,
    time = $("#classifiedTime").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}:\d{2}$/.test(time))
    return null;
  const date = new Date(`${day}T${time}:00.000-05:00`);
  if (
    !Number.isFinite(date.getTime()) ||
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date) !== day
  )
    return null;
  return date.toISOString();
}
function valid() {
  const { selected, difference } = totals();
  const entries = selectedRows();
  return (
    authorized &&
    catalog &&
    group &&
    entries.length > 0 &&
    entries.length <= 50 &&
    selected > 0 &&
    difference === 0 &&
    entries.every(
      (row) =>
        whole(row.processing) &&
        !row.stale &&
        row.processing <= row.quantity_available,
    ) &&
    lines.length > 0 &&
    lines.length <= 100 &&
    lines.every(
      (line) =>
        whole(line.quantity_eggs) &&
        catalog.typologies.some((x) => x.code === line.typology) &&
        catalog.conditions.some((x) => x.code === line.condition) &&
        catalog.destinations.some((x) => x.code === line.destination) &&
        (line.typology !== "PIPO" || line.destination === "DISCARD"),
    ) &&
    classifiedAt() &&
    $("#classifiedDate").value >= $("#originDate").value
  );
}
function frozen() {
  return Boolean(pending);
}
function locks() {
  $("#workspace").setAttribute("aria-busy", String(busy));
  const lock = busy || frozen() || !navigator.onLine;
  for (const node of $$(".view-tab")) node.disabled = busy;
  for (const node of $$(
    "#accountPanel select,#originDate,#originGroup,#classifiedDate,#classifiedTime,#machineReference,#notes,#refreshInputs,#moreInputs",
  ))
    node.disabled = lock;
  for (const node of $$(
    "#originList button,#processRows input,#lines input,#lines select,#lines button",
  ))
    node.disabled = lock || !authorized || node.dataset.fixed === "true";
  $("#addLine").disabled =
    lock || !authorized || !catalog || lines.length >= 100;
  $("#reviewButton").disabled = lock || !valid();
  $("#confirmButton").disabled =
    busy || !navigator.onLine || !review || frozen();
  $("#editButton").disabled = busy || frozen();
  $("#retryIntent").disabled = busy || !navigator.onLine || !pending;
  for (const node of $$(
    "#loginForm button,#passwordForm button,#refreshAccount,#logout,#refreshSessions,#moreSessions,#lookupForm button",
  ))
    node.disabled = busy || !navigator.onLine;
  $("#refreshAccount").disabled = lock;
  $("#logout").disabled = lock;
  $("#networkNotice").hidden = navigator.onLine;
  $("#permissionNotice").hidden = !company || authorized;
  $("#uncertainNotice").hidden = !pending;
  $("#moreInputs").hidden = nextInputs === null;
  $("#moreSessions").hidden = nextSessions === null;
}
function label(list, code) {
  return list?.find((item) => item.code === code)?.label ?? code;
}
function options(list, value) {
  return list
    .map(
      (item) =>
        `<option value="${esc(item.code)}" ${item.code === value ? "selected" : ""}>${esc(item.label)}</option>`,
    )
    .join("");
}
function updateTotals() {
  const t = totals();
  for (const id of ["selectedTotal", "balanceSelected"])
    $(`#${id}`).textContent = t.selected;
  $("#distributedTotal").textContent = t.distributed;
  $("#differenceTotal").textContent = Math.abs(t.difference);
  $("#differenceLabel").textContent =
    t.difference < 0 ? "Exceso distribuido" : "Falta por distribuir";
  $("#balanceHint").textContent = valid()
    ? "Los totales coinciden. Puedes revisar."
    : "Revisa origen, cantidades disponibles y fecha/hora; cada huevo cuenta una sola vez.";
  $("#differenceCard").classList.toggle("balanced", Boolean(valid()));
  $("#differenceCard").classList.toggle("unbalanced", !valid());
  $("#dateOrderNotice").hidden =
    $("#classifiedDate").value >= $("#originDate").value;
  locks();
}
function renderEntries() {
  const entries = rows.filter((row) => groupKey(row) === group);
  $("#originList").replaceChildren();
  $("#processRows").replaceChildren();
  const first = entries[0];
  $("#entryCount").textContent = `${entries.length} entradas`;
  $("#emptyState").hidden = rows.length > 0;
  $("#incidentHint").hidden = !entries.some(
    (row) => row.incident_id && row.incident_status !== "resolved",
  );
  $("#companyName").textContent =
    $("#companySelect").selectedOptions[0]?.textContent ?? "—";
  $("#siteName").textContent =
    sites.find((site) => site.id === first?.site_id)?.name ?? "—";
  $("#lotName").textContent = first?.lot_code ?? "—";
  $("#houseName").textContent = first?.house_name ?? "—";
  $("#originDateLabel").textContent = first?.origin_business_date ?? "—";
  for (const row of entries) {
    const code = `TR-${short(row.transfer_id)}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `origin-card${row.selected ? " selected" : ""}`;
    button.setAttribute("aria-pressed", String(Boolean(row.selected)));
    button.title = row.transfer_id;
    button.textContent = `${code} · ${row.received_quantity} recibidos · ${row.quantity_available} disponibles${row.incident_id ? " · incidencia de custodia" : ""}`;
    button.dataset.fixed = String(row.quantity_available === 0);
    button.addEventListener("click", () => {
      row.selected = !row.selected;
      if (!row.selected) row.processing = 0;
      review = null;
      $("#reviewPanel").hidden = true;
      render();
    });
    $("#originList").append(button);
    if (!row.selected) continue;
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${esc(code)}</td><td data-label="Recibidos">${row.received_quantity}</td><td data-label="Clasificados">${row.quantity_classified}</td><td data-label="Disponibles">${row.quantity_available}</td><td data-label="Procesar ahora"><input type="number" min="1" max="${row.quantity_available}" step="1" inputmode="numeric" value="${esc(row.processing || "")}" aria-label="Cantidad de ${esc(code)}"></td>`;
    tr.querySelector("input").addEventListener("input", (event) => {
      row.processing =
        event.target.value === "" ? 0 : Number(event.target.value);
      review = null;
      $("#reviewPanel").hidden = true;
      updateTotals();
    });
    $("#processRows").append(tr);
  }
}
function renderLines() {
  $("#lines").replaceChildren();
  if (!catalog) return;
  lines.forEach((line, index) => {
    const div = document.createElement("div");
    div.className = "result-line";
    div.innerHTML = `<span class="line-index">${index + 1}</span><label>Huevos enteros<input type="number" min="1" max="2147483647" step="1" inputmode="numeric" value="${esc(line.quantity_eggs || "")}" aria-label="Huevos, resultado ${index + 1}"></label><label>Tipología<select aria-label="Tipología, resultado ${index + 1}">${options(catalog.typologies, line.typology)}</select></label><label>Condición<select aria-label="Condición, resultado ${index + 1}">${options(catalog.conditions, line.condition)}</select></label><label>Destino<select aria-label="Destino, resultado ${index + 1}">${options(catalog.destinations, line.destination)}</select></label><button class="line-remove" type="button" aria-label="Quitar resultado ${index + 1}">×</button>`;
    const [quantity, typology, condition, destination] =
      div.querySelectorAll("input,select");
    quantity.addEventListener("input", (event) => {
      line.quantity_eggs =
        event.target.value === "" ? 0 : Number(event.target.value);
      review = null;
      $("#reviewPanel").hidden = true;
      updateTotals();
    });
    for (const [node, key] of [
      [typology, "typology"],
      [condition, "condition"],
      [destination, "destination"],
    ])
      node.addEventListener("change", () => {
        line[key] = node.value;
        if (line.typology === "PIPO") line.destination = "DISCARD";
        review = null;
        $("#reviewPanel").hidden = true;
        renderLines();
        updateTotals();
      });
    destination.dataset.fixed = String(line.typology === "PIPO");
    if (line.typology === "PIPO") destination.title = "PIPO requiere Descarte";
    div.querySelector("button").dataset.fixed = String(lines.length === 1);
    div.querySelector("button").addEventListener("click", () => {
      lines.splice(index, 1);
      review = null;
      $("#reviewPanel").hidden = true;
      renderLines();
      updateTotals();
    });
    $("#lines").append(div);
  });
}
function render() {
  renderEntries();
  renderLines();
  updateTotals();
  $("#captureView").hidden = view !== "capture";
  $("#sessionView").hidden = view !== "session";
  for (const tab of $$(".view-tab")) {
    const active = tab.dataset.view === view;
    tab.classList.toggle("active", active);
    if (active) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
}
function groupOptions() {
  const previous = group;
  const groups = [
    ...new Map(rows.map((row) => [groupKey(row), row])).entries(),
  ];
  $("#originGroup").replaceChildren(new Option("Elige un único origen…", ""));
  for (const [key, row] of groups)
    $("#originGroup").add(
      new Option(
        `${row.lot_code} · ${row.house_name} · ${sites.find((site) => site.id === row.site_id)?.name ?? short(row.site_id)} · ${row.origin_business_date}`,
        key,
      ),
    );
  group = groups.some(([key]) => key === previous) ? previous : "";
  $("#originGroup").value = group;
}
async function loadInputs(more = false) {
  const epoch = generation;
  const path = root();
  const date = $("#originDate").value;
  const result = await api(
    `${path}/manual-classification-inputs?business_date=${encodeURIComponent(date)}&offset=${more ? nextInputs : 0}`,
    {},
    epoch,
  );
  if (!Array.isArray(result.items) || typeof result.authorized !== "boolean")
    throw new Error("INVALID_RESPONSE");
  const previous = new Map(rows.map((row) => [row.transfer_id, row]));
  const loaded = result.items.map((row) => {
    if (
      row.company_id !== company ||
      row.origin_business_date !== date ||
      !uuid.test(row.transfer_id) ||
      !["site_id", "house_id", "lot_id"].every((key) => uuid.test(row[key])) ||
      !["received_quantity", "quantity_classified", "quantity_available"].every(
        (key) => Number.isSafeInteger(row[key]) && row[key] >= 0,
      )
    )
      throw new Error("INVALID_RESPONSE");
    return {
      ...row,
      selected: previous.get(row.transfer_id)?.selected ?? false,
      processing: previous.get(row.transfer_id)?.processing ?? 0,
      stale: false,
    };
  });
  const retained = more
    ? rows
    : rows
        .filter((row) => row.selected)
        .map((row) => ({ ...row, stale: true }));
  rows = [
    ...new Map(
      [...retained, ...loaded].map((row) => [row.transfer_id, row]),
    ).values(),
  ];
  authorized = result.authorized;
  nextInputs = result.next_offset;
  if (nextInputs !== null && (!Number.isInteger(nextInputs) || nextInputs < 1))
    throw new Error("INVALID_RESPONSE");
  groupOptions();
  $("#inputStatus").textContent =
    `${rows.length} entradas cargadas.${nextInputs !== null ? " Hay más entradas." : ""}${authorized ? "" : " Sin permiso para registrar."}${rows.some((row) => row.stale) ? " Carga más entradas para verificar las seleccionadas que no aparecieron en la primera página." : ""}`;
  render();
}
async function enter(me) {
  if (!uuid.test(me.user_id)) throw new Error("INVALID_SESSION");
  user = me.user_id;
  $("#loginPanel").hidden = true;
  $("#accountLabel").textContent = `Cuenta ${short(user)}`;
  if (me.password_change_required) {
    $("#passwordPanel").hidden = false;
    return;
  }
  $("#passwordPanel").hidden = true;
  $("#accountPanel").hidden = false;
  const companies = await api("/v1/companies");
  $("#companySelect").replaceChildren(new Option("Elige empresa…", ""));
  for (const item of companies)
    $("#companySelect").add(new Option(item.legal_name, item.id));
  message(
    companies.length
      ? "Elige una empresa autorizada."
      : "No tienes empresas activas asignadas.",
  );
}
async function chooseCompany() {
  generation++;
  company = $("#companySelect").value;
  catalog = null;
  sites = [];
  rows = [];
  group = "";
  authorized = false;
  nextInputs = null;
  nextSessions = null;
  resetDraft();
  $("#sessionList").replaceChildren();
  $("#sessionDetail").replaceChildren();
  $("#workspace").hidden = !company;
  render();
  if (!company) return;
  const epoch = generation,
    path = root();
  const response = await api(
    `${path}/manual-classification-catalog`,
    {},
    epoch,
  );
  if (
    response.company_id !== company ||
    !response.catalog?.conditions?.some((x) => x.code === "NORMAL") ||
    !response.catalog?.destinations?.some((x) => x.code === "PENDING")
  )
    throw new Error("INVALID_CATALOG");
  catalog = response.catalog;
  const directory = await api(`${path}/operational-catalog`, {}, epoch);
  sites = directory.sites ?? [];
  resetDraft();
  await loadInputs();
}
function makePacket() {
  if (!valid()) throw new Error("INVALID_MANUAL_CLASSIFICATION");
  const first = selectedRows()[0];
  return {
    schema_version: 1,
    session_id: crypto.randomUUID(),
    company_id: company,
    site_id: first.site_id,
    house_id: first.house_id,
    lot_id: first.lot_id,
    origin_business_date: $("#originDate").value,
    classified_at: classifiedAt(),
    machine_configuration_reference:
      $("#machineReference").value.trim() || null,
    notes: $("#notes").value || null,
    inputs: selectedRows().map((row) => ({
      transfer_id: row.transfer_id,
      quantity_eggs: row.processing,
    })),
    lines: lines.map((line) => ({ ...line })),
  };
}
function reviewPacket(packet) {
  $("#reviewOrigin").textContent =
    `${$("#companyName").textContent} · ${$("#siteName").textContent} · ${$("#lotName").textContent} · ${$("#houseName").textContent} · recogida ${packet.origin_business_date} · clasificación ${$("#classifiedDate").value} ${$("#classifiedTime").value} Colombia · ID ${packet.session_id}`;
  $("#reviewLines").innerHTML = packet.lines
    .map(
      (line) =>
        `<div class="review-line"><strong>${line.quantity_eggs} huevos</strong><span>${esc(label(catalog.typologies, line.typology))}</span><span>${esc(label(catalog.conditions, line.condition))}</span><span>${esc(label(catalog.destinations, line.destination))}</span></div>`,
    )
    .join("");
  $("#reviewTotal").textContent = packet.inputs.reduce(
    (sum, row) => sum + row.quantity_eggs,
    0,
  );
  $("#reviewPanel").hidden = false;
  $("#reviewHeading").focus();
}
async function verifyActor() {
  const me = await api("/v1/auth/me");
  if (me.user_id !== user || me.password_change_required)
    throw Object.assign(new Error("SESSION_IDENTITY_MISMATCH"), {
      status: 409,
    });
}
function validateReceipt(receipt, packet) {
  return (
    receipt?.format === "tamago.manual-classification-receipt" &&
    receipt.schema_version === 1 &&
    receipt.session_id === packet.session_id &&
    receipt.company_id === company &&
    receipt.recorded_by === user &&
    receipt.origin_business_date === packet.origin_business_date &&
    receipt.processed_quantity ===
      packet.inputs.reduce((n, x) => n + x.quantity_eggs, 0) &&
    receipt.review_status === "pending" &&
    receipt.configuration_status === "declared_unverified" &&
    typeof receipt.duplicate === "boolean" &&
    typeof receipt.recorded_at === "string" &&
    Number.isFinite(Date.parse(receipt.recorded_at))
  );
}
async function confirmed(receipt) {
  const id = pending.packet.session_id;
  pending = null;
  resetDraft();
  render();
  $("#changedNotice").hidden = true;
  message(
    `Clasificación registrada en servidor: ${receipt.processed_quantity} huevos. Revisión pendiente. ID ${id}`,
  );
  await loadInputs();
  await loadDetail(id);
  view = "session";
  render();
  $("#sessionHeading").focus();
}
async function sendPending(retry = false) {
  const current = pending,
    epoch = generation;
  if (!current) return;
  await verifyActor();
  try {
    if (retry) {
      let found = null;
      try {
        found = await api(
          `${root()}/manual-classifications/${current.packet.session_id}`,
        );
      } catch (error) {
        if (error.status !== 404) throw error;
      }
      if (
        found &&
        canonical(found.session?.event_payload) !== canonical(current.packet)
      )
        throw new Error("STORED_CONTENT_CONFLICT");
    }
    const receipt = await api(`${root()}/manual-classifications`, {
      method: "POST",
      body: current.packet,
    });
    if (!validateReceipt(receipt, current.packet))
      throw new Error("INVALID_RECEIPT");
    await confirmed(receipt);
  } catch (error) {
    if (epoch !== generation || error.message === "CANCELLED") return;
    if (pending !== current) throw error;
    if (error.status === 401 || error.message === "SESSION_IDENTITY_MISMATCH")
      throw error;
    const definite =
      [400, 403, 409].includes(error.status) && !current.uncertain;
    if (definite) {
      pending = null;
      review = null;
      $("#reviewPanel").hidden = true;
      $("#changedNotice").hidden = error.status !== 409;
      if (error.status === 403) authorized = false;
      showError(explain(error.message));
      message(
        "No se confirmó un registro. Conservamos el formulario; actualiza y revisa antes de una nueva solicitud.",
      );
    } else {
      current.uncertain = true;
      pending = current;
      showError(
        `No se confirmó el resultado. Conserva el ID ${current.packet.session_id} y esta pestaña. Consulta y reintenta exactamente la misma solicitud.`,
      );
      message(`Confirmación pendiente · ID ${current.packet.session_id}`);
    }
    locks();
  }
}
async function loadDetail(id) {
  if (!uuid.test(id)) throw new Error("INVALID_ID");
  const result = await api(`${root()}/manual-classifications/${id}`);
  const session = result.session;
  if (
    session?.company_id !== company ||
    session.session_id !== id ||
    !Array.isArray(result.lines) ||
    !Array.isArray(result.inputs)
  )
    throw new Error("INVALID_RESPONSE");
  $("#sessionDetail").innerHTML =
    `<h3>Sesión ${esc(short(id))}</h3><p>Revisión pendiente · configuración declarada, no verificada.</p><p>Origen ${esc(session.origin_business_date)} · lote ${esc(short(session.lot_id))} · galpón ${esc(short(session.house_id))}</p><p>${session.processed_quantity} huevos · ${result.inputs.length} entrada(s) · clasificación ${esc(new Date(session.classified_at).toLocaleString("es-CO", { timeZone: "America/Bogota" }))}</p><p>Registrado por ${esc(short(session.recorded_by))} · ${esc(session.recorded_at)}</p><div class="table-wrap"><table class="session-table"><thead><tr><th>Cantidad</th><th>Tipología</th><th>Condición</th><th>Destino</th></tr></thead><tbody>${result.lines.map((line) => `<tr><td>${line.quantity_eggs}</td><td>${esc(label(catalog.typologies, line.typology))}</td><td>${esc(label(catalog.conditions, line.condition))}</td><td>${esc(label(catalog.destinations, line.destination))}</td></tr>`).join("")}</tbody></table></div><p>ID ${esc(id)}. Este registro no aplica correcciones, pérdidas ni cierre; una incidencia de custodia sigue su propio proceso.</p>`;
}
async function loadSessions(more = false) {
  if (!company) return;
  const result = await api(
    `${root()}/manual-classifications?business_date=${encodeURIComponent($("#originDate").value)}&offset=${more ? nextSessions : 0}`,
  );
  if (!Array.isArray(result.items)) throw new Error("INVALID_RESPONSE");
  if (!more) $("#sessionList").replaceChildren();
  for (const session of result.items) {
    const button = document.createElement("button");
    button.className = "button secondary";
    button.type = "button";
    button.textContent = `Sesión ${short(session.session_id)} · ${session.processed_quantity} huevos · ${session.origin_business_date} · revisión pendiente`;
    button.addEventListener(
      "click",
      () => void run(() => loadDetail(session.session_id)),
    );
    $("#sessionList").append(button);
  }
  nextSessions = result.next_offset;
  $("#sessionStatus").textContent = $("#sessionList").children.length
    ? "Sesiones cargadas del ámbito autorizado."
    : "Sin sesiones registradas para esta fecha y ámbito.";
  locks();
}
$("#loginForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(event.currentTarget));
  void run(async () => {
    clear();
    const me = await api("/v1/auth/login", { method: "POST", body });
    $("#loginForm").reset();
    await enter(me);
  });
});
$("#passwordForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  if (data.get("password") !== data.get("confirmation"))
    return showError("Las contraseñas deben coincidir.");
  void run(async () => {
    await api("/v1/auth/change-initial-password", {
      method: "POST",
      body: { new_password: data.get("password") },
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
        message("Sesión cerrada.");
      } finally {
        $("#loginPanel").hidden = false;
      }
    }),
);
$("#refreshAccount").addEventListener(
  "click",
  () =>
    void run(async () => {
      clear();
      await enter(await api("/v1/auth/me"));
    }),
);
$("#companySelect").addEventListener("change", () => void run(chooseCompany));
$("#originDate").addEventListener(
  "change",
  () =>
    void run(async () => {
      generation++;
      rows = [];
      group = "";
      nextInputs = null;
      nextSessions = null;
      resetDraft();
      $("#sessionDetail").replaceChildren();
      $("#sessionList").replaceChildren();
      await loadInputs();
      if (view === "session") await loadSessions();
    }),
);
$("#originGroup").addEventListener("change", () => {
  if (busy || pending) return;
  resetDraft();
  group = $("#originGroup").value;
  render();
});
$("#refreshInputs").addEventListener("click", () => void run(loadInputs));
$("#moreInputs").addEventListener(
  "click",
  () => void run(() => loadInputs(true)),
);
$("#addLine").addEventListener("click", () => {
  if (busy || pending || lines.length >= 100) return;
  lines.push(blankLine());
  review = null;
  $("#reviewPanel").hidden = true;
  renderLines();
  updateTotals();
  $("#lines .result-line:last-child input").focus();
});
for (const id of [
  "classifiedDate",
  "classifiedTime",
  "machineReference",
  "notes",
])
  $(`#${id}`).addEventListener("input", () => {
    review = null;
    $("#reviewPanel").hidden = true;
    updateTotals();
  });
$("#reviewButton").addEventListener("click", () => {
  if (busy || pending || !valid()) return;
  review = makePacket();
  reviewPacket(review);
  locks();
});
$("#editButton").addEventListener("click", () => {
  review = null;
  $("#reviewPanel").hidden = true;
  locks();
});
$("#confirmButton").addEventListener("click", () => {
  if (busy || pending || !review || !navigator.onLine) return;
  pending = { packet: structuredClone(review), uncertain: false };
  void run(() => sendPending());
});
$("#retryIntent").addEventListener(
  "click",
  () => void run(() => sendPending(true)),
);
for (const tab of $$("[data-view]"))
  tab.addEventListener("click", () => {
    view = tab.dataset.view;
    render();
    if (view === "session") void run(loadSessions);
  });
$("#refreshSessions").addEventListener("click", () => void run(loadSessions));
$("#moreSessions").addEventListener(
  "click",
  () => void run(() => loadSessions(true)),
);
$("#lookupForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const id = new FormData(event.currentTarget).get("session_id");
  void run(() => loadDetail(id));
});
addEventListener("online", locks);
addEventListener("offline", locks);
addEventListener("beforeunload", (event) => {
  if (
    pending ||
    selectedRows().some((row) => row.processing > 0) ||
    lines.some((line) => line.quantity_eggs > 0)
  ) {
    event.preventDefault();
    event.returnValue = "";
  }
});
$("#originDate").value = today();
$("#classifiedDate").value = today();
$("#classifiedTime").value = timeNow();
clear();
void run(async () => {
  try {
    await enter(await api("/v1/auth/me"));
  } catch (error) {
    if (error.status === 401) {
      $("#loginPanel").hidden = false;
      message("Inicia sesión para consultar clasificación.");
    } else {
      $("#loginPanel").hidden = false;
      throw error;
    }
  }
});
