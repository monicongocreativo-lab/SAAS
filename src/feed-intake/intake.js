import {
  validateFeedDelivery,
  validateFeedDeliveryReceipt,
} from "../shared/feed-delivery-contract.mjs";
import {
  validateOpeningContext,
  validateOpeningList,
} from "../shared/feed-opening-context.mjs";
import {
  validateOpeningApproval,
  validateOpeningCount,
  validateOpeningReceipt,
} from "../shared/feed-opening-contract.mjs";
import { normalizeFeedQuantity } from "../shared/feed-supply-contract.mjs";
import {
  createFeedWorkspace,
  timeNow,
  today,
  uuid,
} from "../shared/feed-workspace.mjs";

const $ = (s) => document.querySelector(s),
  text = (tag, value) => {
    const n = document.createElement(tag);
    n.textContent = value;
    return n;
  };
let intent = null,
  context = null,
  deliveryNext = null,
  caseNext = null,
  countNext = null,
  viewedCounts = [];
const fail = (code) => {
  throw new Error(code);
};
const formData = (id) => Object.fromEntries(new FormData($(`#${id}`)));
const localTime = (iso) =>
  new Date(iso).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    hourCycle: "h23",
  });
function reset() {
  intent = null;
  context = null;
  deliveryNext = null;
  caseNext = null;
  countNext = null;
  viewedCounts = [];
  for (const id of [
    "deliveryForm",
    "countForm",
    "recountForm",
    "approvalForm",
    "deliveryLookup",
    "openingLookup",
  ])
    $(`#${id}`).reset();
  for (const id of [
    "deliveries",
    "cases",
    "deliveryDetail",
    "countHistory",
    "currentCount",
    "approvalDetail",
  ])
    $(`#${id}`).replaceChildren();
  for (const id of [
    "intentSummary",
    "intentState",
    "receiptStatus",
    "caseSummary",
    "deliveryStatus",
    "caseStatus",
  ])
    $(`#${id}`).textContent = "";
  for (const id of [
    "intentPanel",
    "casePanel",
    "receiptStatus",
    "moreDeliveries",
    "moreCases",
    "moreCounts",
    "recountForm",
    "approvalForm",
  ])
    $(`#${id}`).hidden = true;
  $("#businessDate").value = today();
  $("#occurredTime").value = timeNow();
  $("#deliveryHistoryDate").value = today();
}
function locks() {
  const busy = ws.busy,
    frozen = busy || !!intent,
    can = ws.permitted($("#lot").value);
  $("#scopeFields").disabled = frozen;
  $("#deliveryFields").disabled = frozen || !can;
  $("#countFields").disabled = frozen || !can;
  $("#reviewDelivery").disabled = frozen || !can || !navigator.onLine;
  $("#reviewCount").disabled = frozen || !can || !navigator.onLine;
  $("#capturePermission").textContent = can
    ? "Puedes registrar en este lote; el servidor revalidará el permiso."
    : "Elige un lote con permiso de captura. Dirección puede consultar sin poder registrar.";
  $("#recountFields").disabled = frozen || !context?.can_count;
  $("#approvalFields").disabled = frozen || !context?.can_approve;
  $("#reviewRecount").disabled =
    frozen || !context?.can_count || !navigator.onLine;
  $("#reviewApproval").disabled =
    frozen || !context?.can_approve || !navigator.onLine;
  for (const id of [
    "refreshDeliveries",
    "deliveryHistoryDate",
    "moreDeliveries",
    "refreshCases",
    "moreCases",
  ])
    $(`#${id}`).disabled = busy;
  for (const id of ["deliveryLookup", "openingLookup"])
    for (const el of $(`#${id}`).elements) el.disabled = busy || !!intent;
  for (const b of document.querySelectorAll("#cases button"))
    b.disabled = frozen;
  $("#refreshCase").disabled = frozen;
  $("#moreCounts").disabled = frozen;
  $("#editIntent").hidden = !!intent?.pending;
  $("#confirmIntent").hidden = !!intent?.pending;
  $("#retryIntent").hidden = !intent?.pending;
  $("#discardIntent").hidden = !(
    intent?.pending &&
    intent.rejected &&
    !intent.uncertain
  );
  for (const id of ["editIntent", "discardIntent"]) $(`#${id}`).disabled = busy;
  $("#confirmIntent").disabled = busy || !intent || !navigator.onLine;
  $("#retryIntent").disabled = busy || !intent || !navigator.onLine;
}
const ws = createFeedWorkspace({
  reset,
  locks,
  hasIntent: () => !!intent,
  companyChanged: async () => {
    await Promise.all([loadDeliveries(), loadCases()]);
  },
  refreshed: async () => {
    await Promise.all([loadDeliveries(), loadCases()]);
    if (context && !intent) await loadCase(context.opening.opening_id);
  },
});
function timestamp(date, time) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") ||
    !/^\d{2}:\d{2}$/.test(time ?? "")
  )
    fail("INVALID_INTENT");
  const d = new Date(`${date}T${time}:00.000-05:00`);
  if (!Number.isFinite(d.getTime())) fail("INVALID_INTENT");
  return d.toISOString();
}
function common(d) {
  const lot = ws.lot($("#lot").value),
    quantity = normalizeFeedQuantity(d.quantity);
  if (!lot || !ws.permitted(lot.id) || quantity === null)
    fail("INVALID_INTENT");
  return {
    schema_version: 1,
    company_id: ws.company,
    site_id: lot.site_id,
    house_id: lot.house_id,
    lot_id: lot.id,
    business_date: $("#businessDate").value,
    product_declared: d.product.trim(),
    location_declared: d.location.trim(),
    quantity,
    unit: "BAG_40KG",
    notes: d.notes || null,
  };
}
function packetSummary(action) {
  const e = action.event;
  if (action.kind === "approval") {
    const count = viewedCounts.find(
      (row) => row.event_payload.count_id === e.count_id,
    )?.event_payload;
    if (!count) fail("INVALID_INTENT");
    return [
      "APROBAR CONTEO · NO APLICAR INVENTARIO",
      contextLabel(e.opening_id),
      `Cantidad: ${count.quantity.replace(".", ",")} bultos de 40 kg`,
      `Corte: ${localTime(count.cutoff_at)} Colombia`,
      `Soporte: ${count.evidence_reference}`,
      `Versión ${e.expected_revision} · conteo ${e.count_id}`,
      `Motivo: ${e.reason}`,
      `Acción ${e.action_id}`,
    ].join("\n");
  }
  return `${action.kind === "delivery" ? "RECEPCIÓN FÍSICA" : "CONTEO DE APERTURA"}\n${e.quantity.replace(".", ",")} bultos de 40 kg · ${e.product_declared}\n${ws.label(e.lot_id)}\nUbicación: ${e.location_declared}\n${localTime(e.occurred_at ?? e.cutoff_at)} Colombia\n${action.kind === "delivery" ? `Entrega ${e.event_id}` : `Caso ${e.opening_id} · versión ${e.expected_revision + 1} · conteo ${e.count_id}\nSoporte: ${e.evidence_reference}`}`;
}
function contextLabel(id) {
  return context?.opening.opening_id === id
    ? `${context.opening.product_declared} · ${context.opening.location_declared} · ${ws.label(context.opening.lot_id)} · caso ${id}`
    : `Caso ${id}`;
}
function review(action) {
  if (intent) return;
  intent = { ...action, pending: false, uncertain: false, rejected: false };
  $("#receiptStatus").hidden = true;
  $("#receiptStatus").textContent = "";
  $("#intentSummary").textContent = packetSummary(intent);
  $("#intentTitle").textContent = "Revisión de intención";
  $("#intentState").textContent =
    "Revisa ámbito, cantidad, soporte y versión antes de confirmar. No aplica inventario.";
  $("#intentPanel").hidden = false;
  $("#intentTitle").focus();
}
function validDelivery(r) {
  return (
    uuid.test(r?.recorded_by ?? "") &&
    validateFeedDelivery(r?.event, ws.company) &&
    validateFeedDeliveryReceipt(r, r.event, r.recorded_by)
  );
}
function deliverySummary(r) {
  const e = r.event;
  return `${e.quantity.replace(".", ",")} bultos de 40 kg · ${e.product_declared} · ${e.location_declared} · ${e.business_date} · ID ${e.event_id}`;
}
function showDelivery(r) {
  $("#deliveryDetail").replaceChildren(
    text("h4", "Recepción confirmada en servidor"),
    text("p", deliverySummary(r)),
    text("p", ws.label(r.event.lot_id)),
    text(
      "p",
      `Proveedor: ${r.event.supplier_declared ?? "No aportado"} · lote físico: ${r.event.physical_batch_declared ?? "No aportado"} · referencia: ${r.event.delivery_reference_declared ?? "No aportada"}`,
    ),
    text("p", r.event.notes ?? "Sin observaciones"),
    text(
      "p",
      `Registró ${r.recorded_by} · ${localTime(r.recorded_at)} Colombia. No equivale a saldo comprobado.`,
    ),
  );
}
async function loadDelivery(id) {
  $("#deliveryDetail").replaceChildren();
  if (!uuid.test(id ?? "")) fail("INVALID_INTENT");
  const r = await ws.api(`${ws.root}/feed-deliveries/${id}`);
  if (!validDelivery(r) || r.event.event_id !== id) fail("INVALID_RESPONSE");
  showDelivery(r);
  $("#deliveryDetail").focus();
}
async function loadDeliveries(append = false) {
  const epoch = ws.generation,
    date = $("#deliveryHistoryDate").value,
    offset = append ? deliveryNext : 0;
  $("#deliveryStatus").textContent = "Consultando recepciones…";
  try {
    const v = await ws.api(
      `${ws.root}/feed-deliveries?business_date=${date}&offset=${offset}`,
    );
    if (
      v?.format !== "tamago.feed-delivery-list" ||
      v.schema_version !== 1 ||
      v.company_id !== ws.company ||
      v.business_date !== date ||
      !Array.isArray(v.items) ||
      v.items.length > 25 ||
      v.items.some(
        (r) => !validDelivery(r) || r.event.business_date !== date,
      ) ||
      !(v.next_offset === null || v.next_offset === offset + 25)
    )
      fail("INVALID_RESPONSE");
    const seen = new Set(
      append ? [...$("#deliveries").children].map((n) => n.dataset.id) : [],
    );
    for (const r of v.items) {
      if (seen.has(r.event.event_id)) fail("INVALID_RESPONSE");
      seen.add(r.event.event_id);
    }
    if (!append) $("#deliveries").replaceChildren();
    for (const r of v.items) {
      const li = document.createElement("li"),
        b = text("button", deliverySummary(r));
      li.dataset.id = r.event.event_id;
      b.type = "button";
      b.addEventListener(
        "click",
        () => void ws.run(() => loadDelivery(r.event.event_id)),
      );
      li.append(b);
      $("#deliveries").append(li);
    }
    deliveryNext = v.next_offset;
    $("#moreDeliveries").hidden = deliveryNext === null;
    $("#deliveryStatus").textContent = $("#deliveries").children.length
      ? `${$("#deliveries").children.length} entregas visibles. Actualiza ante nuevos registros.`
      : "Sin información de recepciones para esta fecha en tu ámbito.";
  } catch (e) {
    if (epoch === ws.generation) {
      $("#deliveries").replaceChildren();
      deliveryNext = null;
      $("#moreDeliveries").hidden = true;
      $("#deliveryStatus").textContent =
        "No se pudo consultar. Vuelve a actualizar.";
    }
    throw e;
  }
}
async function loadCases(append = false) {
  const epoch = ws.generation,
    offset = append ? caseNext : 0;
  $("#caseStatus").textContent = "Consultando casos…";
  try {
    const v = await ws.api(`${ws.root}/feed-openings?offset=${offset}`);
    if (!validateOpeningList(v, ws.company, offset)) fail("INVALID_RESPONSE");
    const seen = new Set(
      append ? [...$("#cases").children].map((n) => n.dataset.id) : [],
    );
    for (const h of v.items) {
      if (seen.has(h.opening_id)) fail("INVALID_RESPONSE");
      seen.add(h.opening_id);
    }
    if (!append) $("#cases").replaceChildren();
    for (const h of v.items) {
      const li = document.createElement("li"),
        b = text(
          "button",
          `${h.product_declared} · ${h.location_declared} · ${ws.label(h.lot_id)} · versión ${h.current_revision} · ${h.status === "approved" ? "Aprobado, no aplicado" : "Pendiente de aprobación"} · caso ${h.opening_id}`,
        );
      li.dataset.id = h.opening_id;
      b.type = "button";
      b.addEventListener(
        "click",
        () => void ws.run(() => loadCase(h.opening_id)),
      );
      li.append(b);
      $("#cases").append(li);
    }
    caseNext = v.next_offset;
    $("#moreCases").hidden = caseNext === null;
    $("#caseStatus").textContent = $("#cases").children.length
      ? `${$("#cases").children.length} casos visibles. Ninguno implica apertura aplicada al saldo. Actualiza ante cambios.`
      : "No hay casos visibles en tu ámbito.";
  } catch (e) {
    if (epoch === ws.generation) {
      $("#cases").replaceChildren();
      caseNext = null;
      $("#moreCases").hidden = true;
      $("#caseStatus").textContent =
        "No se pudo consultar. Vuelve a actualizar.";
    }
    throw e;
  }
}
function renderCase() {
  const h = context.opening,
    latest = viewedCounts[0];
  $("#casePanel").hidden = false;
  $("#caseSummary").textContent =
    `${contextLabel(h.opening_id)}\nVersión vigente ${h.current_revision} · ${h.status === "approved" ? "APROBADO · NO APLICADO AL INVENTARIO" : "Pendiente de aprobación · no aplicado al inventario"}`;
  $("#currentCount").replaceChildren(
    text("h4", "Conteo vigente"),
    text(
      "p",
      `${latest.event_payload.quantity.replace(".", ",")} bultos de 40 kg · corte ${localTime(latest.event_payload.cutoff_at)} Colombia`,
    ),
    text("p", `Soporte: ${latest.event_payload.evidence_reference}`),
    text(
      "p",
      `Registró ${latest.recorded_by} · conteo ${latest.event_payload.count_id}`,
    ),
  );
  $("#approvalDetail").replaceChildren();
  if (context.approval) {
    const a = context.approval;
    $("#approvalDetail").append(
      text("h4", "Decisión conservada"),
      text(
        "p",
        `Dirección aprobó versión ${a.revision} · conteo ${a.event_payload.count_id}`,
      ),
      text("p", a.event_payload.reason),
      text(
        "p",
        `Aprobó ${a.recorded_by} · ${localTime(a.recorded_at)} Colombia. No aplicado al inventario.`,
      ),
    );
  }
  $("#countHistory").replaceChildren();
  for (const r of viewedCounts) {
    const li = text(
      "li",
      `Versión ${r.revision} · ${r.event_payload.quantity.replace(".", ",")} bultos · corte ${localTime(r.event_payload.cutoff_at)} Colombia\nSoporte: ${r.event_payload.evidence_reference}\nConteo ${r.event_payload.count_id} · registró ${r.recorded_by}`,
    );
    li.dataset.id = r.event_payload.count_id;
    $("#countHistory").append(li);
  }
  $("#moreCounts").hidden = countNext === null;
  $("#recountForm").hidden = !context.can_count;
  $("#approvalForm").hidden = !context.can_approve;
}
async function loadCase(id, append = false) {
  const epoch = ws.generation;
  if (!uuid.test(id ?? "")) fail("INVALID_INTENT");
  const offset = append ? countNext : 0;
  try {
    const c = await ws.api(`${ws.root}/feed-openings/${id}?offset=${offset}`);
    if (!validateOpeningContext(c, { companyId: ws.company, id, offset }))
      fail("INVALID_RESPONSE");
    if (
      append &&
      (context?.opening.opening_id !== id ||
        context.opening.current_revision !== c.opening.current_revision ||
        context.opening.status !== c.opening.status)
    )
      fail("CONTEXT_CHANGED");
    const rows = append ? [...viewedCounts, ...c.counts] : c.counts;
    if (new Set(rows.map((r) => r.revision)).size !== rows.length)
      fail("INVALID_RESPONSE");
    context = c;
    viewedCounts = rows;
    countNext = c.next_offset;
    renderCase();
    if (!append) {
      $("#recountForm").reset();
      $("#approvalForm").reset();
      $("#recountForm [name=date]").value = today();
      $("#recountForm [name=time]").value = timeNow();
      $("#caseTitle").focus();
    }
  } catch (e) {
    if (epoch === ws.generation) {
      context = null;
      viewedCounts = [];
      countNext = null;
      $("#casePanel").hidden = true;
      for (const name of [
        "caseSummary",
        "currentCount",
        "countHistory",
        "approvalDetail",
      ])
        $(`#${name}`).replaceChildren();
    }
    throw e;
  }
}
function reconstructed(row, approval) {
  return {
    format: `tamago.feed-opening-${approval ? "approval" : "count"}-receipt`,
    schema_version: 1,
    event: row.event_payload,
    actor_id: row.recorded_by,
    recorded_at: row.recorded_at,
    revision: row.revision,
    state_at_recording: approval ? "approved" : "pending",
    inventory_check: "not_applied",
    duplicate: true,
  };
}
function validAck(r, action) {
  return action.kind === "delivery"
    ? validateFeedDeliveryReceipt(r, action.event, ws.user)
    : validateOpeningReceipt(
        r,
        action.event,
        ws.user,
        action.kind === "approval",
      );
}
async function accept(r, action) {
  if (!validAck(r, action)) fail("INVALID_RESPONSE");
  intent = null;
  $("#intentPanel").hidden = true;
  $("#receiptStatus").hidden = false;
  $("#receiptStatus").textContent =
    action.kind === "approval"
      ? `CONTEO APROBADO · NO APLICADO AL INVENTARIO. Versión ${r.revision} · acción ${action.event.action_id}`
      : action.kind === "delivery"
        ? `Recepción confirmada en servidor: ${action.event.quantity.replace(".", ",")} bultos de 40 kg · ID ${action.event.event_id}. Saldo no comprobado.`
        : `Conteo confirmado en servidor · versión ${r.revision} · caso ${action.event.opening_id}. Consulta su estado actual; no aplica inventario.`;
  if (action.kind === "delivery") {
    $("#deliveryForm").reset();
    showDelivery(r);
    $("#deliveryHistoryDate").value = action.event.business_date;
  } else if (!action.recount) $("#countForm").reset();
  try {
    if (action.kind === "delivery") await loadDeliveries();
    else {
      await loadCases();
      await loadCase(action.event.opening_id);
    }
  } catch (e) {
    if (
      e.status === 401 ||
      e.message === "SESSION_IDENTITY_MISMATCH" ||
      e.message === "CANCELLED"
    )
      throw e;
    ws.error(
      "La acción está confirmada; no se pudo actualizar la consulta. Vuelve a consultar.",
    );
  }
}
async function send(retry = false) {
  const action = intent,
    epoch = ws.generation;
  if (!action) return;
  action.pending = true;
  locks();
  try {
    await ws.verify();
    if (retry) {
      let stored;
      try {
        if (action.kind === "delivery")
          stored = await ws.api(
            `${ws.root}/feed-deliveries/${action.event.event_id}`,
          );
        else {
          const c = await ws.api(
            `${ws.root}/feed-openings/${action.event.opening_id}?offset=0`,
          );
          if (
            !validateOpeningContext(c, {
              companyId: ws.company,
              id: action.event.opening_id,
            })
          )
            fail("INVALID_RESPONSE");
          const row =
            action.kind === "approval"
              ? c.approval?.event_payload.action_id === action.event.action_id
                ? c.approval
                : null
              : c.counts.find(
                  (r) => r.event_payload.count_id === action.event.count_id,
                );
          if (row) stored = reconstructed(row, action.kind === "approval");
        }
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      if (stored) {
        if (!validAck(stored, action)) fail("INVALID_RESPONSE");
        await accept(stored, action);
        return;
      }
    }
    const path =
      action.kind === "delivery"
        ? "feed-deliveries"
        : action.kind === "count"
          ? "feed-opening-counts"
          : "feed-opening-approvals";
    await accept(
      await ws.api(`${ws.root}/${path}`, {
        method: "POST",
        body: action.event,
      }),
      action,
    );
  } catch (e) {
    if (epoch !== ws.generation || e.message === "CANCELLED") throw e;
    if (intent === action) {
      if (
        [400, 403, 409].includes(e.status) &&
        e.message !== "SESSION_IDENTITY_MISMATCH"
      )
        action.rejected = true;
      else action.uncertain = true;
      $("#intentTitle").textContent =
        action.rejected && !action.uncertain
          ? "Intención rechazada"
          : "Confirmación pendiente";
      $("#intentState").textContent =
        action.rejected && !action.uncertain
          ? "El servidor rechazó esta intención. Puedes descartarla conscientemente y volver a consultar antes de preparar otra."
          : "No se confirmó el resultado. Conserva esta pestaña y consulta/reintenta exactamente el mismo ID.";
      $("#intentTitle").focus();
    }
    throw e;
  }
}
function hookForm(id, prepare) {
  $(`#${id}`).addEventListener("submit", (e) => {
    e.preventDefault();
    if (ws.busy || intent) return;
    const d = formData(id);
    void ws.run(async () => review(prepare(d)));
  });
}
hookForm("deliveryForm", (d) => {
  const e = {
    ...common(d),
    format: "tamago.feed-delivery",
    event_id: crypto.randomUUID(),
    occurred_at: timestamp($("#businessDate").value, $("#occurredTime").value),
    supplier_declared: d.supplier.trim() || null,
    physical_batch_declared: d.physicalBatch.trim() || null,
    delivery_reference_declared: d.reference.trim() || null,
  };
  if (!validateFeedDelivery(e, ws.company)) fail("INVALID_INTENT");
  return { kind: "delivery", event: e };
});
hookForm("countForm", (d) => {
  const e = {
    ...common(d),
    format: "tamago.feed-opening-count",
    opening_id: crypto.randomUUID(),
    count_id: crypto.randomUUID(),
    cutoff_at: timestamp($("#businessDate").value, $("#occurredTime").value),
    evidence_reference: d.evidence.trim(),
    expected_revision: 0,
    previous_count_id: null,
  };
  if (!validateOpeningCount(e, ws.company)) fail("INVALID_INTENT");
  return { kind: "count", event: e };
});
hookForm("recountForm", (d) => {
  if (!context?.can_count || context.opening.status !== "pending")
    fail("INVALID_INTENT");
  const old = viewedCounts[0].event_payload,
    e = {
      ...old,
      count_id: crypto.randomUUID(),
      quantity: normalizeFeedQuantity(d.quantity),
      business_date: d.date,
      cutoff_at: timestamp(d.date, d.time),
      evidence_reference: d.evidence.trim(),
      notes: d.notes || null,
      expected_revision: context.opening.current_revision,
      previous_count_id: old.count_id,
    };
  if (!validateOpeningCount(e, ws.company)) fail("INVALID_INTENT");
  return { kind: "count", recount: true, event: e };
});
hookForm("approvalForm", (d) => {
  if (!context?.can_approve || context.opening.status !== "pending")
    fail("INVALID_INTENT");
  const e = {
    format: "tamago.feed-opening-approval",
    schema_version: 1,
    action_id: crypto.randomUUID(),
    company_id: ws.company,
    opening_id: context.opening.opening_id,
    count_id: viewedCounts[0].event_payload.count_id,
    expected_revision: context.opening.current_revision,
    reason: d.reason.trim(),
  };
  if (!validateOpeningApproval(e, ws.company)) fail("INVALID_INTENT");
  return { kind: "approval", event: e };
});
$("#confirmIntent").addEventListener("click", () => {
  if (ws.busy || !intent || intent.pending || !navigator.onLine) return;
  void ws.run(() => send());
});
$("#retryIntent").addEventListener(
  "click",
  () => void ws.run(() => send(true)),
);
$("#editIntent").addEventListener("click", () => {
  if (ws.busy || intent?.pending) return;
  intent = null;
  $("#intentPanel").hidden = true;
  ws.locks();
});
$("#discardIntent").addEventListener("click", () => {
  if (ws.busy || !intent?.rejected || intent.uncertain) return;
  const id = intent.kind === "delivery" ? null : intent.event.opening_id;
  intent = null;
  $("#intentPanel").hidden = true;
  void ws.run(async () => {
    await Promise.all([loadCases(), loadDeliveries()]);
    if (id) await loadCase(id);
  });
});
$("#lot").addEventListener("change", () => ws.locks());
for (const [id, action] of [
  ["refreshDeliveries", () => loadDeliveries()],
  ["moreDeliveries", () => loadDeliveries(true)],
  ["refreshCases", () => loadCases()],
  ["moreCases", () => loadCases(true)],
  ["refreshCase", () => loadCase(context.opening.opening_id)],
  ["moreCounts", () => loadCase(context.opening.opening_id, true)],
])
  $(`#${id}`).addEventListener("click", () => void ws.run(action));
$("#deliveryHistoryDate").addEventListener(
  "change",
  () => void ws.run(loadDeliveries),
);
for (const [id, action] of [
  ["deliveryLookup", loadDelivery],
  ["openingLookup", loadCase],
])
  $(`#${id}`).addEventListener("submit", (e) => {
    e.preventDefault();
    const d = formData(id);
    void ws.run(() => action(d.id));
  });
addEventListener("beforeunload", (e) => {
  if (
    intent ||
    ["deliveryForm", "countForm", "recountForm", "approvalForm"].some((id) =>
      [...$(`#${id}`).elements].some(
        (el) =>
          ["product", "quantity", "evidence", "reason"].includes(el.name) &&
          el.value,
      ),
    )
  ) {
    e.preventDefault();
    e.returnValue = "";
  }
});
ws.start();
