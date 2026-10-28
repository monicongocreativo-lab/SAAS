import { validateFeedDeliveryReceipt } from "../shared/feed-delivery-contract.mjs";
import {
  validateBalancePreview,
  validateInventoryCommand,
  validateInventoryReceipt,
} from "../shared/feed-inventory-contract.mjs";
import {
  validateCorrectionReceipt,
  validateInventoryCorrection,
} from "../shared/feed-inventory-revision.mjs";
import {
  validateLedgerCommand,
  validateLedgerReceipt,
} from "../shared/feed-ledger-contract.mjs";
import { validateOpeningContext } from "../shared/feed-opening-context.mjs";
import { validateFeedReceipt } from "../shared/feed-supply-contract.mjs";
import {
  createFeedWorkspace,
  timeNow,
  today,
  uuid,
} from "../shared/feed-workspace.mjs";
import { createCorrections } from "./corrections.js";
import { createLedger } from "./ledger.js";

const $ = (s) => document.querySelector(s),
  node = (tag, value) => {
    const n = document.createElement(tag);
    n.textContent = value;
    return n;
  };
const data = (id) =>
  Object.fromEntries(
    [...$(id).elements]
      .filter((el) => el.name)
      .map((el) => [el.name, el.value]),
  );
const fail = () => {
  throw new Error("INVALID_RESPONSE");
};
let corrections = null,
  book = null;
let manage = false,
  items = [],
  next = null,
  source = null,
  opening = null,
  preview = null,
  intent = null,
  ties = [],
  previewBinding = null;
const ws = createFeedWorkspace({
  reset,
  locks,
  hasIntent: () => !!intent,
  companyChanged: async () => {},
  refreshed: async () => {
    if ($("#lot").value) await loadCatalog();
  },
});
corrections = createCorrections({
  ws,
  isDirector: () => manage,
  getItems: () => items,
  scopeMatches,
  describe,
  stage: review,
  hasIntent: () => !!intent,
});
book = createLedger({
  ws,
  scopeMatches,
  isDirector: () => manage,
  hasIntent: () => !!intent,
  stage: review,
});
function reset() {
  corrections?.reset();
  book?.reset();
  manage = false;
  items = [];
  next = null;
  source = null;
  opening = null;
  preview = null;
  intent = null;
  ties = [];
  previewBinding = null;
  for (const id of [
    "catalogForm",
    "sourceForm",
    "bindingForm",
    "openingForm",
    "previewForm",
    "cutoffForm",
  ])
    $(`#${id}`).reset();
  for (const id of ["catalog", "source", "opening", "preview", "tieDetail"])
    $(`#${id}`).replaceChildren();
  for (const id of [
    "intentPanel",
    "bindingForm",
    "useCount",
    "previewForm",
    "cutoffForm",
    "more",
  ])
    $(`#${id}`).hidden = true;
  for (const id of ["receipt", "permission", "catalogState"])
    $(`#${id}`).textContent = "";
  $("#previewForm [name=date]").value = today();
  $("#previewForm [name=time]").value = timeNow();
}
function clearScope() {
  reset();
}
function locks() {
  const frozen = ws.busy || !!intent,
    lot = !!ws.lot($("#lot").value);
  $("#lot").disabled = frozen;
  $("#reload").disabled = frozen || !lot;
  $("#more").disabled = frozen;
  for (const id of ["catalogForm", "bindingForm", "cutoffForm"])
    for (const el of $(`#${id}`).elements) el.disabled = frozen || !manage;
  for (const id of ["sourceForm", "openingForm", "previewForm"])
    for (const el of $(`#${id}`).elements) el.disabled = frozen || !lot;
  $("#useCount").disabled = frozen;
  for (const b of document.querySelectorAll("#preview button, #source button"))
    b.disabled = frozen;
  $("#confirm").hidden = !!intent?.pending;
  $("#retry").hidden = !intent?.pending;
  $("#confirm").disabled = ws.busy || !intent || !navigator.onLine;
  $("#retry").disabled = ws.busy || !intent || !navigator.onLine;
  $("#edit").disabled = ws.busy || !!intent?.pending;
  $("#reconcile").hidden = !(
    ["correction", "ledger"].includes(intent?.kind) && intent?.conflict
  );
  $("#reconcile").disabled = ws.busy;
  corrections?.locks();
  book?.locks();
  $("#permission").textContent = lot
    ? manage
      ? "Dirección verificada en este ámbito. El servidor revalida cada acción."
      : "Consulta: sin permiso de Dirección para gestionar este ámbito."
    : "Elige lote y galpón.";
}
function scopeMatches(e) {
  const l = ws.lot($("#lot").value);
  return (
    l &&
    e.company_id === ws.company &&
    e.lot_id === l.id &&
    e.site_id === l.site_id &&
    e.house_id === l.house_id
  );
}
async function inventory(path, options) {
  return ws.api(`${ws.root}/feed-inventory/${path}`, options);
}
async function loadCatalog(append = false) {
  manage = false;
  ws.locks();
  const lot = $("#lot").value;
  if (!lot) return;
  const permissions = await inventory(`context?lot_id=${lot}`);
  if (
    permissions.company_id !== ws.company ||
    permissions.lot_id !== lot ||
    typeof permissions.can_manage !== "boolean"
  )
    fail();
  const offset = append ? next : 0;
  const v = await inventory(`catalog?lot_id=${lot}&offset=${offset}`);
  if (
    v.company_id !== ws.company ||
    v.lot_id !== lot ||
    !Array.isArray(v.items) ||
    v.items.length > 25 ||
    !(v.next_offset === null || v.next_offset === offset + 25)
  )
    fail();
  const result = append ? [...items, ...v.items] : v.items;
  if (new Set(result.map((x) => x.item_id)).size !== result.length) fail();
  for (const i of result)
    if (
      !uuid.test(i.item_id) ||
      i.company_id !== ws.company ||
      !["product", "location"].includes(i.kind) ||
      (i.kind === "location" && !scopeMatches({ ...i, lot_id: lot }))
    )
      fail();
  items = result;
  next = v.next_offset;
  manage = permissions.can_manage;
  const option = [...$("#lot").options].find((o) => o.value === lot);
  if (option)
    option.textContent =
      ws.label(lot) + (manage ? " · Dirección" : " · consulta");
  $("#catalog").replaceChildren(
    ...items.map((i) =>
      node(
        "li",
        (i.kind === "product" ? "Producto" : "Ubicación") +
          " · " +
          i.code +
          " · " +
          i.label +
          " · ID " +
          i.item_id,
      ),
    ),
  );
  $("#catalogState").textContent =
    items.length +
    " identidades cargadas" +
    (next !== null ? " · hay más páginas" : " · catálogo consultado completo");
  $("#more").hidden = next === null;
  for (const [field, kind] of [
    ["product", "product"],
    ["location", "location"],
  ]) {
    const select = $(`#bindingForm [name=${field}]`),
      selected = select.value;
    select.replaceChildren(new Option("Elige código e identidad…", ""));
    for (const i of items.filter((x) => x.kind === kind))
      select.add(
        new Option(`${i.code} · ${i.label} · ${i.item_id}`, i.item_id),
      );
    if (items.some((x) => x.item_id === selected)) select.value = selected;
  }
  corrections?.options();
}
function correctionLink(b) {
  const button = node("button", "Revisar historial y corregir vínculo");
  button.type = "button";
  button.className = "quiet";
  button.addEventListener(
    "click",
    () => void ws.run(() => corrections.open("binding", b.binding_id)),
  );
  $("#source").append(button);
}
function describe(e) {
  const names = {
    item_id: "ID de identidad",
    kind: "Tipo",
    code: "Código",
    label: "Nombre",
    company_id: "Empresa",
    site_id: "Sede",
    house_id: "Galpón",
    lot_id: "Lote",
    reason: "Motivo",
    source_kind: "Tipo de fuente",
    source_id: "ID de fuente",
    binding_id: "ID de vínculo",
    product_id: "Producto · ID",
    location_id: "Ubicación · ID",
    opening_id: "Caso",
    count_id: "Conteo",
    action_id: "ID de decisión",
    revision_id: "ID de corrección",
    target_kind: "Tipo de corrección",
    target_id: "ID original",
    expected_revision: "Versión anterior",
    previous_revision_id: "Corrección anterior",
    expected_opening_binding_revision: "Versión vínculo del conteo",
    expected_movement_binding_revision: "Versión vínculo del movimiento",
    classification: "Decisión",
    business_date: "Fecha física · Colombia",
    occurred_at: "Fecha y hora · Colombia",
    cutoff_at: "Corte del conteo · Colombia",
    product_declared: "Producto declarado",
    location_declared: "Ubicación declarada",
    quantity: "Cantidad · bultos de 40 kg",
    evidence_reference: "Soporte del conteo",
    supplier_declared: "Proveedor declarado",
    notes: "Observaciones",
    event_id: "ID del registro",
    delivery_reference_declared: "Referencia de entrega",
    physical_batch_declared: "Lote físico",
    source_declared: "Origen declarado",
  };
  const values = {
    product: "Producto · bulto de 40 kg",
    location: "Ubicación",
    delivery: "Recepción",
    supply: "Suministro",
    count: "Conteo",
    binding: "Vínculo de producto y ubicación",
    cutoff: "Decisión de empate",
    included_in_count: "Ya incluido en el conteo",
    after_count: "Posterior al conteo",
  };
  return Object.entries(e)
    .filter(([k, v]) => names[k] && v !== null)
    .map(([k, v]) => {
      const value = ["occurred_at", "cutoff_at"].includes(k)
        ? new Intl.DateTimeFormat("es-CO", {
            timeZone: "America/Bogota",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hourCycle: "h23",
          }).format(new Date(v))
        : ["kind", "source_kind", "target_kind", "classification"].includes(k)
          ? (values[v] ?? v)
          : v;
      return `${names[k]}: ${value}`;
    })
    .join("\n");
}
function showSource() {
  $("#source").replaceChildren(
    node("h3", "Fuente original consultada"),
    node("pre", describe(source.event)),
  );
  $("#bindingForm").hidden = !manage;
  $("#source").focus();
}
async function loadSource(kind, id) {
  source = null;
  $("#source").replaceChildren();
  $("#bindingForm").hidden = true;
  if (!uuid.test(id)) fail();
  const r = await ws.api(
    ws.root +
      (kind === "delivery" ? "/feed-deliveries/" : "/feed-supplies/") +
      id,
  );
  if (
    !(kind === "delivery"
      ? validateFeedDeliveryReceipt(r, r.event, r.recorded_by)
      : validateFeedReceipt(r, r.event, r.recorded_by)) ||
    !scopeMatches(r.event)
  )
    fail();
  source = { kind, id, event: r.event };
  showSource();
  try {
    const b = await inventory(`bindings/${kind}/${id}`);
    source.binding = b.binding;
    correctionLink(b.binding);
    $("#source").append(
      node(
        "p",
        "Vínculo consultado · corrección " +
          (b.binding.correction_revision ?? 0) +
          ": " +
          b.binding.product_id +
          " · " +
          b.binding.location_id +
          " · motivo " +
          (b.binding.current_event ?? b.binding.event_payload).reason,
      ),
    );
    $("#bindingForm").hidden = true;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
}
async function loadOpening(id) {
  opening = null;
  preview = null;
  ties = [];
  $("#opening").replaceChildren();
  $("#preview").replaceChildren();
  $("#cutoffForm").hidden = true;
  $("#previewForm").hidden = true;
  $("#useCount").hidden = true;
  if (!uuid.test(id)) fail();
  const c = await ws.api(`${ws.root}/feed-openings/${id}?offset=0`);
  if (
    !validateOpeningContext(c, { companyId: ws.company, id }) ||
    !scopeMatches(c.opening)
  )
    fail();
  opening = c;
  $("#opening").append(
    node(
      "p",
      "Caso " +
        id +
        " · " +
        (c.opening.status === "approved"
          ? "Aprobado · no aplicado"
          : "Pendiente de aprobación") +
        " · revisión " +
        c.opening.current_revision,
    ),
  );
  if (c.approval) {
    const approved = c.counts.find(
      (x) => x.event_payload.count_id === c.approval.event_payload.count_id,
    );
    if (!approved) fail();
    $("#opening").append(node("pre", describe(approved.event_payload)));
    $("#useCount").hidden = !manage;
    $("#previewForm").hidden = false;
  } else
    $("#opening").append(
      node("p", "Pendiente de aprobación: consulta provisional bloqueada."),
    );
  $("#opening").focus();
}
function through() {
  const d = data("#previewForm");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !/^\d{2}:\d{2}$/.test(d.time))
    fail();
  const s = `${d.date}T${d.time}:00.000-05:00`;
  const dt = new Date(s);
  if (!Number.isFinite(dt.getTime())) fail();
  return dt.toISOString();
}
async function loadPreview() {
  preview = null;
  ties = [];
  $("#preview").replaceChildren();
  $("#cutoffForm").hidden = true;
  $("#tieDetail").replaceChildren();
  const id = opening.opening.opening_id,
    time = through();
  previewBinding = null;
  try {
    previewBinding = (
      await inventory(
        `bindings/count/${opening.approval.event_payload.count_id}`,
      )
    ).binding;
  } catch (e) {
    if (e.status !== 404) throw e;
  }
  const v = await inventory(
    `previews/${id}?through_at=${encodeURIComponent(time)}`,
  );
  if (
    !validateBalancePreview(v, ws.company, id) ||
    Date.parse(v.through_at) !== Date.parse(time)
  )
    fail();
  preview = v;
  const reasons = {
    opening_not_approved: "El caso no está aprobado.",
    opening_not_linked: "Falta vincular el conteo aprobado.",
    cutoff_after_through: "La ventana termina antes del conteo.",
  };
  $("#preview").append(
    node("h3", "Consulta provisional · NO APLICADA AL INVENTARIO"),
    node(
      "p",
      reasons[v.reason] ??
        (v.status === "resolved"
          ? "Sin bloqueos en los registros de servidor."
          : v.status === "negative"
            ? "Resultado negativo: requiere investigación."
            : "Bloqueada: faltan vínculos o decisiones de empate."),
    ),
  );
  if (v.diagnostic_balance_bags !== null)
    $("#preview").append(
      node(
        "p",
        "Conteo " +
          v.opening_bags +
          " + entradas " +
          v.known_receipts_bags +
          " − suministros " +
          v.known_supplied_bags +
          " = " +
          v.diagnostic_balance_bags +
          " bultos de 40 kg · diagnóstico",
      ),
    );
  if (v.balance_bags !== null)
    $("#preview").append(
      node("p", `Resultado provisional: ${v.balance_bags} bultos de 40 kg.`),
    );
  $("#preview").append(
    node(
      "p",
      "Sin vincular: " +
        v.unmapped_count +
        " · Empates pendientes: " +
        v.pending_tie_count,
    ),
  );
  for (const b of v.blockers) {
    const button = node(
      "button",
      (b.problem === "unmapped"
        ? "Consultar fuente sin vínculo"
        : "Consultar fuente empatada") +
        " · " +
        b.source_kind +
        " · " +
        b.source_id,
    );
    button.type = "button";
    button.className = "quiet";
    button.addEventListener(
      "click",
      () => void ws.run(() => loadSource(b.source_kind, b.source_id)),
    );
    $("#preview").append(button);
  }
  if (v.blockers_truncated)
    $("#preview").append(
      node(
        "p",
        "Se muestran los primeros 25 bloqueos. Resuélvelos y vuelve a consultar; el total incluye todos.",
      ),
    );
  ties = v.blockers.filter(
    (b) => b.problem === "cutoff_tie" && !b.previous_decision_id,
  );
  for (const b of v.blockers.filter(
    (b) => b.problem === "cutoff_tie" && b.previous_decision_id,
  )) {
    $("#preview").append(
      node(
        "p",
        "Una decisión anterior quedó desactualizada al corregirse un vínculo. Requiere corrección auditada; no vuelvas a crearla. Consulta su historial y revisa la corrección con Dirección.",
      ),
    );
    const button = node("button", "Ver historial de decisión");
    button.type = "button";
    button.className = "quiet";
    button.addEventListener(
      "click",
      () =>
        void ws.run(() => corrections.open("cutoff", b.previous_decision_id)),
    );
    $("#preview").append(button);
  }
  const sel = $("#cutoffForm [name=source]");
  sel.replaceChildren(new Option("Consulta un movimiento empatado…", ""));
  for (const b of ties)
    sel.add(
      new Option(
        `${b.source_kind} · ${b.source_id}`,
        `${b.source_kind}/${b.source_id}`,
      ),
    );
  $("#cutoffForm").hidden = !manage || !ties.length;
}
function review(kind, event, summary) {
  if (
    !manage ||
    !(kind === "correction"
      ? validateInventoryCorrection(event, ws.company)
      : kind === "ledger"
        ? validateLedgerCommand(event, ws.company)
        : validateInventoryCommand(event, ws.company, kind))
  )
    fail();
  intent = { kind, event, pending: false };
  $("#intentSummary").textContent = summary ?? describe(event);
  $("#intentState").textContent =
    "Revisa alcance, identidades y motivo. Aún no registrado.";
  $("#intentPanel").hidden = false;
  $("#intentTitle").focus();
}
async function send() {
  const action = intent;
  if (!action) return;
  action.pending = true;
  ws.locks();
  $("#intentState").textContent = "Enviando intención con ID conservado…";
  try {
    await ws.verify();
    const paths = {
      catalog: "catalog",
      binding: "bindings",
      cutoff: "cutoff-decisions",
      correction: "corrections",
      ledger:
        action.event.format === "tamago.feed-inventory-activation"
          ? "ledger-activate"
          : "ledger-post",
    };
    const r = await inventory(paths[action.kind], {
      method: "POST",
      body: action.event,
    });
    if (
      !(action.kind === "correction"
        ? validateCorrectionReceipt(r, action.event, ws.user)
        : action.kind === "ledger"
          ? validateLedgerReceipt(r, action.event, ws.user)
          : validateInventoryReceipt(r, action.event, ws.user, action.kind))
    )
      fail();
    intent = null;
    $("#intentPanel").hidden = true;
    $("#receipt").textContent =
      action.kind === "ledger"
        ? `Acuse de operación del libro · ${action.event.action_id} · versión ${r.revision} · saldo de esa operación ${r.balance_bags} bultos${r.duplicate ? " · reintento, sin duplicar" : ""}`
        : "Registrado en servidor · " +
          (action.event.revision_id ??
            action.event.item_id ??
            action.event.binding_id ??
            action.event.action_id) +
          (r.duplicate ? " · reintento, sin duplicar" : "") +
          " · inventario no aplicado.";
    if (action.kind === "ledger") await book.accepted(action.event);
    else if (["binding", "cutoff", "correction"].includes(action.kind))
      book.changed();
    if (action.kind === "catalog") await loadCatalog();
    if (action.kind === "binding") {
      source = null;
      $("#source").replaceChildren();
      $("#bindingForm").hidden = true;
    }
    if (action.kind === "correction") await corrections.accepted(action.event);
    if (opening?.approval) await loadPreview();
  } catch (e) {
    if (
      intent === action &&
      e.status === 409 &&
      e.message === "FEED_INVENTORY_CONFLICT"
    )
      action.conflict = true;
    if (intent === action)
      $("#intentState").textContent =
        "Sin confirmación válida. Se conserva exactamente el mismo ID y contenido para reintentar; el servidor puede haberlo registrado. Un rechazo requiere revisar la fuente y permisos, no otro ID.";
    throw e;
  }
}
for (const [id, handler] of [
  [
    "catalogForm",
    () => {
      const d = data("#catalogForm"),
        l = ws.lot($("#lot").value);
      review("catalog", {
        format: "tamago.feed-catalog-item",
        schema_version: 1,
        item_id: crypto.randomUUID(),
        company_id: ws.company,
        site_id: l.site_id,
        house_id: l.house_id,
        lot_id: l.id,
        kind: d.kind,
        code: d.code.trim(),
        label: d.label.trim(),
        unit: d.kind === "product" ? "BAG_40KG" : null,
        reason: d.reason.trim(),
      });
    },
  ],
  [
    "sourceForm",
    () => {
      const d = data("#sourceForm");
      return loadSource(d.kind, d.id.trim());
    },
  ],
  ["openingForm", () => loadOpening(data("#openingForm").id.trim())],
  ["previewForm", loadPreview],
  [
    "bindingForm",
    () => {
      if (!source) fail();
      const d = data("#bindingForm");
      review("binding", {
        format: "tamago.feed-fact-binding",
        schema_version: 1,
        binding_id: crypto.randomUUID(),
        company_id: ws.company,
        source_kind: source.kind,
        source_id: source.id,
        product_id: d.product,
        location_id: d.location,
        reason: d.reason.trim(),
      });
    },
  ],
  [
    "cutoffForm",
    () => {
      const d = data("#cutoffForm"),
        b = ties.find((x) => `${x.source_kind}/${x.source_id}` === d.source);
      if (
        !b ||
        !source ||
        source.id !== b.source_id ||
        source.kind !== b.source_kind
      )
        fail();
      review("cutoff", {
        format: "tamago.feed-cutoff-decision",
        schema_version: 1,
        action_id: crypto.randomUUID(),
        company_id: ws.company,
        opening_id: preview.opening_id,
        count_id: preview.count_id,
        source_kind: b.source_kind,
        source_id: b.source_id,
        classification: d.classification,
        expected_opening_binding_revision: previewBinding?.correction_revision,
        expected_movement_binding_revision: source.binding?.correction_revision,
        reason: d.reason.trim(),
      });
    },
  ],
])
  $(`#${id}`).addEventListener("submit", (e) => {
    e.preventDefault();
    void ws.run(handler);
  });
$("#lot").addEventListener(
  "change",
  () =>
    void ws.run(async () => {
      clearScope();
      await loadCatalog();
    }),
);
$("#reload").addEventListener("click", () => void ws.run(() => loadCatalog()));
$("#more").addEventListener(
  "click",
  () => void ws.run(() => loadCatalog(true)),
);
$("#useCount").addEventListener(
  "click",
  () =>
    void ws.run(async () => {
      const row = opening.counts.find(
        (x) =>
          x.event_payload.count_id === opening.approval.event_payload.count_id,
      );
      source = {
        kind: "count",
        id: row.event_payload.count_id,
        event: row.event_payload,
      };
      showSource();
      try {
        const b = await inventory(`bindings/count/${source.id}`);
        correctionLink(b.binding);
        $("#source").append(
          node(
            "p",
            "Vínculo consultado · corrección " +
              (b.binding.correction_revision ?? 0) +
              ": " +
              b.binding.product_id +
              " · " +
              b.binding.location_id,
          ),
        );
        $("#bindingForm").hidden = true;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }),
);
$("#cutoffForm [name=source]").addEventListener(
  "change",
  () =>
    void ws.run(async () => {
      const val = $("#cutoffForm [name=source]").value;
      $("#tieDetail").replaceChildren();
      if (!val) return;
      const [k, id] = val.split("/");
      await loadSource(k, id);
      $("#tieDetail").replaceChildren(node("pre", describe(source.event)));
    }),
);
for (const id of ["confirm", "retry"])
  $(`#${id}`).addEventListener("click", () => void ws.run(send));
$("#edit").addEventListener("click", () => {
  if (!intent?.pending) {
    intent = null;
    $("#intentPanel").hidden = true;
    ws.locks();
  }
});
$("#reconcile").addEventListener(
  "click",
  () =>
    void ws.run(async () => {
      const action = intent;
      if (!["correction", "ledger"].includes(action?.kind) || !action.conflict)
        return;
      const outcome = await (action.kind === "ledger"
        ? book
        : corrections
      ).reconcile(action);
      if (outcome === "retry") await send();
      else if (outcome === "review" && intent === action) {
        intent = null;
        $("#intentPanel").hidden = true;
        $("#receipt").textContent =
          "Conflicto comprobado: intención rechazada sin aplicación. Revisa nuevamente la propuesta con la versión vigente.";
      }
    }),
);
ws.start();
