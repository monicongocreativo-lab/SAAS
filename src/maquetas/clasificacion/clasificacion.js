const MAX_QUANTITY = 2_147_483_647;
const catalog = {
  typologies: [
    ["PIPO", "PIPO"], ["C", "C"], ["B", "B"], ["A", "A"], ["AA", "AA"],
    ["AAA", "Extra (AAA)"], ["YUMBO", "Yumbo"], ["UNKNOWN", "No determinada"],
  ],
  conditions: [["NORMAL", "Sin incidencia"], ["DIRTY", "Sucio"], ["BROKEN", "Roto"], ["YOLK", "Yema"]],
  destinations: [["PENDING", "Pendiente de definir"], ["DISCARD", "Descarte"]],
};

const initialEntries = [
  { transfer_id: "a1e00001-0000-4000-8000-000000000001", code: "TR-104", sent: 60, received_quantity: 59, quantity_classified: 0, quantity_available: 59, incident_id: "inc-demo-01", incident_status: "open", select: true, processing: 20 },
  { transfer_id: "a1e00002-0000-4000-8000-000000000002", code: "TR-105", sent: 30, received_quantity: 29, quantity_classified: 0, quantity_available: 29, incident_id: null, incident_status: null, select: true, processing: 10 },
];
const initialLines = [
  { quantity_eggs: 20, typology: "AA", condition: "NORMAL", destination: "PENDING" },
  { quantity_eggs: 5, typology: "UNKNOWN", condition: "DIRTY", destination: "PENDING" },
  { quantity_eggs: 5, typology: "PIPO", condition: "BROKEN", destination: "DISCARD" },
];
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = {
  scenario: "ready", entries: structuredClone(initialEntries), lines: structuredClone(initialLines),
  visibleView: "capture", reviewVisible: false, sample: false, pendingRequest: null,
};

const labelFor = (list, value) => list.find(([code]) => code === value)?.[1] ?? value;
const formatDate = (value) => value ? new Intl.DateTimeFormat("es-CO", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`)) : "—";
const integerValue = (value) => value === "" ? 0 : Number(value);
const validInteger = (value, min = 0) => Number.isSafeInteger(value) && value >= min && value <= MAX_QUANTITY;
const selectedTotal = () => state.entries.filter((entry) => entry.select).reduce((total, entry) => total + entry.processing, 0);
const distributedTotal = () => state.lines.reduce((total, line) => total + (validInteger(line.quantity_eggs) ? line.quantity_eggs : 0), 0);
const isLocked = () => ["forbidden", "offline", "uncertain"].includes(state.scenario);
const validSelection = () => state.entries.every((entry) => !entry.select || (validInteger(entry.processing) && entry.processing <= entry.quantity_available));
const validDateOrder = () => Boolean($("#originDate").value && $("#classifiedDate").value && $("#classifiedDate").value >= $("#originDate").value);

function announce(message) { $("#liveMessage").textContent = message; }
function htmlEscape(text) { return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

function renderOriginList() {
  const host = $("#originList");
  host.replaceChildren();
  for (const [index, entry] of state.entries.entries()) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `origin-card${entry.select ? " selected" : ""}`;
    button.disabled = isLocked() || state.scenario === "empty";
    button.setAttribute("aria-pressed", String(Boolean(entry.select)));
    button.setAttribute("aria-label", `${entry.code}, ${entry.received_quantity} recibidos, ${entry.quantity_available} disponibles${entry.incident_status === "open" ? ", incidencia abierta" : ""}`);
    button.innerHTML = `<div class="origin-card-top"><strong>${entry.code} <span aria-hidden="true">↗</span></strong><span class="received-tag">Recibido</span></div><div class="origin-card-meta"><span>Enviados <b>${entry.sent}</b></span><span>Recibidos <b>${entry.received_quantity}</b></span><span>Disponibles <b>${entry.quantity_available}</b></span></div>${entry.incident_status === "open" ? '<span class="incident-label"><span class="incident-dot" aria-hidden="true"></span>Incidencia abierta</span>' : ""}`;
    button.addEventListener("click", () => {
      entry.select = !entry.select;
      if (!entry.select) entry.processing = 0;
      else if (entry.processing === 0 && entry.quantity_available > 0) entry.processing = Math.min(entry.quantity_available, 10);
      render();
    });
    host.append(button);
    if (index === state.entries.length - 1) $("#entryCount").textContent = `${state.entries.length} ${state.entries.length === 1 ? "entrada" : "entradas"}`;
  }
  $("#emptyState").hidden = state.entries.length > 0;
  $("#originList").hidden = state.entries.length === 0;
  $("#incidentHint").hidden = !state.entries.some((entry) => entry.incident_status === "open") || state.scenario === "empty";
  $("#entryCount").textContent = state.entries.length === 0 ? "0 entradas" : `${state.entries.length} ${state.entries.length === 1 ? "entrada" : "entradas"}`;
  const originDate = $("#originDate").value;
  $("#originDateLabel").textContent = formatDate(originDate);
}

function renderProcessRows() {
  const tbody = $("#processRows");
  tbody.replaceChildren();
  for (const entry of state.entries) {
    const tr = document.createElement("tr");
    const disabled = isLocked() || state.scenario === "empty" || !entry.select || entry.quantity_available <= 0;
    tr.innerHTML = `<td><span class="transfer-code">${entry.code}</span><span class="transfer-origin">${entry.incident_status === "open" ? "Origen con incidencia" : "Mismo origen"}</span></td><td data-label="Recibidos"><span class="availability">${entry.received_quantity}</span><span class="sub-quantity">huevos</span></td><td data-label="Clasificados"><span class="availability">${entry.quantity_classified}</span><span class="sub-quantity">huevos</span></td><td data-label="Disponibles"><span class="availability">${entry.quantity_available}</span><span class="sub-quantity">huevos</span></td><td data-label="Procesar ahora"><input class="quantity-input" type="number" inputmode="numeric" min="0" max="${entry.quantity_available}" step="1" value="${entry.select ? entry.processing : 0}" aria-label="Cantidad a procesar de ${entry.code}" ${disabled ? "disabled" : ""}></td>`;
    const input = $("input", tr);
    input.addEventListener("input", () => {
      const value = integerValue(input.value);
      entry.processing = value;
      if (!validInteger(value) || value > entry.quantity_available) input.setCustomValidity(`Ingresa un entero entre 0 y ${entry.quantity_available}.`);
      else input.setCustomValidity("");
      updateTotals();
    });
    tbody.append(tr);
  }
}

function makeOptions(pairs, selected) {
  return pairs.map(([code, label]) => `<option value="${code}" ${code === selected ? "selected" : ""}>${label}</option>`).join("");
}
function renderLines() {
  const host = $("#lines");
  host.replaceChildren();
  state.lines.forEach((line, index) => {
    const row = document.createElement("div");
    row.className = "result-line";
    row.innerHTML = `<span class="line-index" aria-label="Resultado ${index + 1}">${String(index + 1).padStart(2, "0")}</span><label class="line-quantity"><span>Huevos enteros</span><input type="number" inputmode="numeric" min="1" max="${MAX_QUANTITY}" step="1" value="${htmlEscape(line.quantity_eggs)}" aria-label="Huevos enteros, resultado ${index + 1}"></label><label class="line-typology"><span>Tipología</span><select aria-label="Tipología, resultado ${index + 1}">${makeOptions(catalog.typologies, line.typology)}</select></label><label class="line-condition"><span>Condición</span><select aria-label="Condición, resultado ${index + 1}">${makeOptions(catalog.conditions, line.condition)}</select></label><label class="line-destination"><span>Destino</span><select aria-label="Destino, resultado ${index + 1}">${makeOptions(catalog.destinations, line.destination)}</select></label><button class="line-remove" type="button" aria-label="Quitar resultado ${index + 1}" ${state.lines.length <= 1 || isLocked() ? "disabled" : ""}>×</button>`;
    const [quantity, typology, condition, destination] = $$("input, select", row);
    quantity.addEventListener("input", () => {
      line.quantity_eggs = integerValue(quantity.value);
      if (!validInteger(line.quantity_eggs, 1)) quantity.setCustomValidity("Ingresa una cantidad entera positiva."); else quantity.setCustomValidity("");
      updateTotals();
    });
    typology.addEventListener("change", () => {
      line.typology = typology.value;
      if (line.typology === "PIPO") line.destination = "DISCARD";
      renderLines(); updateTotals();
    });
    condition.addEventListener("change", () => { line.condition = condition.value; });
    destination.addEventListener("change", () => { line.destination = destination.value; });
    if (line.typology === "PIPO") {
      destination.value = "DISCARD";
      destination.disabled = true;
      destination.setAttribute("aria-describedby", `pipoHint${index}`);
      const hint = document.createElement("span");
      hint.id = `pipoHint${index}`;
      hint.className = "sr-only";
      hint.textContent = "PIPO requiere destino Descarte.";
      row.querySelector(".line-destination").append(hint);
    }
    $(".line-remove", row).addEventListener("click", () => { if (state.lines.length > 1) { state.lines.splice(index, 1); render(); } });
    host.append(row);
  });
  $("#addLine").disabled = isLocked() || state.lines.length >= 100;
}

function updateTotals() {
  const selected = selectedTotal();
  const distributed = distributedTotal();
  const difference = selected - distributed;
  const equalAndPositive = selected > 0 && difference === 0 && validSelection() && validDateOrder() && state.lines.every((line) => validInteger(line.quantity_eggs, 1));
  $("#selectedTotal").textContent = selected;
  $("#balanceSelected").textContent = selected;
  $("#distributedTotal").textContent = distributed;
  $("#differenceTotal").textContent = Math.abs(difference);
  $("#differenceLabel").textContent = !validSelection() ? "Revisar disponibilidad" : difference > 0 ? "Falta por distribuir" : difference < 0 ? "Exceso distribuido" : "Diferencia por distribuir";
  $("#balanceHint").textContent = !validSelection() ? "La cantidad seleccionada supera la nueva disponibilidad." : selected === 0 ? "Selecciona una cantidad mayor que cero." : difference === 0 ? "Los totales coinciden." : difference > 0 ? "Distribuye los huevos que faltan en una o más líneas." : "Hay más huevos distribuidos que seleccionados.";
  $("#differenceCard").classList.toggle("balanced", equalAndPositive);
  $("#differenceCard").classList.toggle("unbalanced", !equalAndPositive);
  $("#reviewButton").disabled = !equalAndPositive || isLocked() || state.scenario === "empty";
  $("#actionHelp").textContent = state.scenario === "changed" && !validSelection() ? "Ajusta la cantidad al nuevo disponible para continuar." : equalAndPositive ? "La cantidad es entera y los totales coinciden." : "Para continuar, los totales deben coincidir y ser mayores que cero.";
  if (state.reviewVisible && !equalAndPositive) state.reviewVisible = false;
  $("#reviewPanel").hidden = !state.reviewVisible;
  $("#dateOrderNotice").hidden = validDateOrder();
}

function syncScenarioNotices() {
  $("#networkNotice").hidden = state.scenario !== "offline";
  $("#permissionNotice").hidden = state.scenario !== "forbidden";
  $("#changedNotice").hidden = state.scenario !== "changed";
  $("#uncertainNotice").hidden = state.scenario !== "uncertain";
  for (const element of [$("#originDate"), $("#classifiedDate"), $("#machineReference"), $("#notes")]) element.disabled = isLocked();
  $("#classifiedDate").min = $("#originDate").value;
  $("#retryIntent").disabled = !state.pendingRequest;
}

function buildReview() {
  const selectedEntries = state.entries.filter((entry) => entry.select && entry.processing > 0);
  const origin = $("#reviewOrigin");
  origin.innerHTML = `<div><strong>Origen</strong>${$("#companyName").textContent} · ${$("#siteName").textContent} · ${$("#lotName").textContent} · ${$("#houseName").textContent}</div><div><strong>Fecha de recogida</strong>${$("#originDateLabel").textContent}</div><div><strong>Fecha de clasificación</strong>${formatDate($("#classifiedDate").value)}</div><div><strong>Entradas</strong>${selectedEntries.map((entry) => `${entry.code}: ${entry.processing}`).join(" · ")}</div>`;
  $("#reviewLines").innerHTML = state.lines.map((line) => `<div class="review-line"><strong>${line.quantity_eggs} huevos</strong><span>${labelFor(catalog.typologies, line.typology)}</span><span>${labelFor(catalog.conditions, line.condition)}</span><span>${labelFor(catalog.destinations, line.destination)}</span></div>`).join("");
  $("#reviewTotal").textContent = selectedTotal();
  $("#simulatedReceipt").hidden = true;
}

function render() {
  renderOriginList();
  renderProcessRows();
  renderLines();
  updateTotals();
  syncScenarioNotices();
  $("#captureView").hidden = state.visibleView !== "capture";
  $("#sessionView").hidden = state.visibleView !== "session";
  $$(".view-tab").forEach((tab) => {
    const selected = tab.dataset.view === state.visibleView;
    tab.classList.toggle("active", selected);
    if (selected) tab.setAttribute("aria-current", "page"); else tab.removeAttribute("aria-current");
  });
  $("#reviewButton").dataset.valid = String(selectedTotal() > 0 && selectedTotal() === distributedTotal() && validSelection() && validDateOrder() && state.lines.every((line) => validInteger(line.quantity_eggs, 1)));
  $("#scenarioSelect").value = state.scenario === "sample" ? "ready" : state.scenario;
}

function resetScenario(value) {
  state.scenario = value;
  state.visibleView = value === "sample" ? "session" : "capture";
  state.reviewVisible = value === "review";
  state.pendingRequest = null;
  state.entries = structuredClone(initialEntries);
  state.lines = structuredClone(initialLines);
  if (value === "empty") {
    state.entries = [];
    state.lines = [{ quantity_eggs: 0, typology: "UNKNOWN", condition: "NORMAL", destination: "PENDING" }];
  } else if (value === "imbalance") {
    state.lines = [{ quantity_eggs: 12, typology: "AA", condition: "NORMAL", destination: "PENDING" }, { quantity_eggs: 5, typology: "PIPO", condition: "BROKEN", destination: "DISCARD" }];
  } else if (value === "changed") {
    state.entries[0].quantity_available = 12;
    state.entries[0].processing = 20;
    state.entries[1].select = false;
    state.entries[1].processing = 0;
  } else if (["forbidden", "offline", "uncertain"].includes(value)) {
    state.entries[0].select = true; state.entries[0].processing = 20;
    state.entries[1].select = false; state.entries[1].processing = 0;
  }
  if (value === "uncertain") state.pendingRequest = makeIntent();
  render();
  if (value === "review") buildReview();
  announce(`Escenario de demostración: ${$("#scenarioSelect").selectedOptions[0]?.textContent ?? value}.`);
}

function makeIntent() {
  // Modelo volátil de la solicitud de demostración. No se envía ni persiste.
  return {
    session_id: "a1000000-0000-4000-8000-000000000001",
    inputs: state.entries.filter((entry) => entry.select && entry.processing > 0).map((entry) => ({ transfer_id: entry.transfer_id, quantity_eggs: entry.processing })),
    lines: state.lines.map((line, index) => ({ line_id: `a200000${index}-0000-4000-8000-00000000000${index + 1}`, quantity_eggs: line.quantity_eggs, typology: line.typology, condition: line.condition, destination: line.destination })),
  };
}

$("#scenarioSelect").addEventListener("change", (event) => resetScenario(event.target.value));
$("#originDate").addEventListener("change", () => { $("#classifiedDate").min = $("#originDate").value; renderOriginList(); updateTotals(); announce("Fecha de recogida actualizada en la vista de demostración."); });
$("#reviewButton").addEventListener("click", () => {
  if ($( "#reviewButton").disabled) return;
  state.reviewVisible = true; buildReview(); render();
  $("#reviewHeading").focus({ preventScroll: true });
});
$("#editButton").addEventListener("click", () => { state.reviewVisible = false; render(); $("#resultsHeading").focus({ preventScroll: true }); });
$("#simulateButton").addEventListener("click", () => {
  state.pendingRequest = makeIntent();
  $("#simulatedReceipt").hidden = false;
  $("#simulatedReceipt").textContent = "Intención confirmada en esta demostración. No se envió solicitud, no se creó una sesión y ningún dato quedó guardado.";
  announce("La intención se mostró en la maqueta. No se creó un registro real.");
});
$("#retryIntent").addEventListener("click", () => {
  if (!state.pendingRequest) return;
  $("#uncertainNotice").hidden = false;
  announce(`Reintento de demostración con la misma sesión ${state.pendingRequest.session_id}. No se hizo ninguna solicitud.`);
});
$("#addLine").addEventListener("click", () => { if (state.lines.length < 100) { state.lines.push({ quantity_eggs: 0, typology: "UNKNOWN", condition: "NORMAL", destination: "PENDING" }); render(); $("#lines .result-line:last-child input").focus(); } });
$("#classifiedDate").addEventListener("change", () => { updateTotals(); announce("Fecha de clasificación actualizada. La fecha de recogida se mantiene como origen."); });
$$('[data-view]').forEach((button) => button.addEventListener("click", () => {
  state.visibleView = button.dataset.view;
  if (state.visibleView === "session") state.scenario = "sample";
  else if (state.scenario === "sample") state.scenario = "ready";
  render();
  const target = state.visibleView === "session" ? $("#sessionHeading") : $("#pageTitle");
  target.focus?.({ preventScroll: true });
}));

render();
