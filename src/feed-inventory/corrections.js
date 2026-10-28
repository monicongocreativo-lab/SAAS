import {
  assessCorrectionOutcome,
  validateEffectiveBinding,
  validateInventoryCorrection,
  validateInventoryHistory,
} from "../shared/feed-inventory-revision.mjs";
import { validateOpeningContext } from "../shared/feed-opening-context.mjs";
import { uuid } from "../shared/feed-workspace.mjs";

const $ = (s) => document.querySelector(s),
  text = (tag, value) => {
    const n = document.createElement(tag);
    n.textContent = value;
    return n;
  };
const fields = () =>
  Object.fromEntries(
    [...$("#correctionForm").elements]
      .filter((e) => e.name)
      .map((e) => [e.name, e.value]),
  );
export function createCorrections({
  ws,
  isDirector,
  getItems,
  scopeMatches,
  describe,
  stage,
  hasIntent,
}) {
  let context = null,
    rows = [],
    next = null,
    stale = false;
  const api = (path) => ws.api(`${ws.root}/feed-inventory/${path}`);
  const invalid = () => {
    throw new Error("INVALID_RESPONSE");
  };
  function reset() {
    context = null;
    rows = [];
    next = null;
    stale = false;
    $("#correctionPanel").hidden = true;
    $("#correctionForm").hidden = true;
    $("#moreCorrections").hidden = true;
    $("#correctionForm").reset();
    $("#correctionLookup").reset();
    for (const id of [
      "correctionOriginal",
      "correctionCurrent",
      "correctionHistory",
      "correctionState",
      "correctionScope",
    ])
      $(`#${id}`).replaceChildren();
  }
  function locks() {
    const frozen = ws.busy || hasIntent();
    for (const el of $("#correctionLookup").elements)
      el.disabled = frozen || !ws.lot($("#lot").value);
    for (const el of $("#correctionForm").elements)
      el.disabled =
        frozen || !isDirector() || !context || stale || !context.eligible;
    $("#refreshCorrection").disabled = frozen || !context;
    $("#moreCorrections").disabled = frozen || stale;
    $("#correctionForm").hidden = !context || !isDirector();
  }
  function options() {
    const d = fields();
    for (const [name, kind] of [
      ["product", "product"],
      ["location", "location"],
    ]) {
      const select = $(`#correctionForm [name=${name}]`),
        current =
          context?.current[kind === "product" ? "product_id" : "location_id"];
      select.replaceChildren(new Option("Elige una identidad…", ""));
      for (const i of getItems().filter((i) => i.kind === kind))
        select.add(
          new Option(`${i.code} · ${i.label} · ${i.item_id}`, i.item_id),
        );
      if (current && ![...select.options].some((o) => o.value === current))
        select.add(new Option(`Identidad vigente · ${current}`, current));
      if (
        d[name] &&
        uuid.test(d[name]) &&
        ![...select.options].some((o) => o.value === d[name])
      )
        select.add(new Option(`Propuesta conservada · ${d[name]}`, d[name]));
      const chosen = d[name] || current;
      if ([...select.options].some((o) => o.value === chosen))
        select.value = chosen;
    }
  }
  async function history(kind, id, offset = 0) {
    const h = await api(`history/${kind}/${id}?offset=${offset}`);
    if (!validateInventoryHistory(h, ws.company, kind, id, offset)) invalid();
    return h;
  }
  async function binding(kind, id) {
    const v = await api(`bindings/${kind}/${id}`);
    if (!validateEffectiveBinding(v.binding, ws.company, kind, id)) invalid();
    return v.binding;
  }
  async function prepare(h) {
    const original = h.original,
      last = h.items[0],
      current = last?.event_payload ?? original.event_payload;
    if (h.target_kind === "binding") {
      if (!scopeMatches(original)) throw new Error("CORRECTION_SCOPE");
      return {
        h,
        original,
        current,
        eligible: true,
        source:
          original.source_snapshot?.event_payload ?? original.source_snapshot,
      };
    }
    const c = await ws.api(
      `${ws.root}/feed-openings/${original.opening_id}?offset=0`,
    );
    if (
      !validateOpeningContext(c, {
        companyId: ws.company,
        id: original.opening_id,
      }) ||
      !scopeMatches(c.opening) ||
      c.approval?.event_payload.count_id !== original.count_id
    )
      throw new Error("CORRECTION_SCOPE");
    const [count, movement] = await Promise.all([
      binding("count", original.count_id),
      binding(original.source_kind, original.source_id),
    ]);
    if (!scopeMatches(count) || !scopeMatches(movement))
      throw new Error("CORRECTION_SCOPE");
    const eligible =
      count.product_id === movement.product_id &&
      count.location_id === movement.location_id &&
      Date.parse(count.source_snapshot.occurred_at) ===
        Date.parse(movement.source_snapshot.occurred_at);
    return {
      h,
      original,
      current,
      eligible,
      count,
      movement,
      source:
        movement.source_snapshot?.event_payload ?? movement.source_snapshot,
    };
  }
  function render() {
    const { h, original, current } = context,
      label = h.target_kind === "binding" ? "vínculo" : "decisión";
    $("#correctionPanel").hidden = false;
    $("#correctionTitle").textContent =
      `Historial de ${label} · versión ${h.current_revision}`;
    $("#correctionScope").textContent =
      `${ws.label($("#lot").value)} · original ${h.target_id}`;
    $("#correctionOriginal").replaceChildren(
      text("p", `Autor ${original.recorded_by} · ${original.recorded_at}`),
      text("pre", describe(original.event_payload)),
    );
    const latest = rows[0] ?? original;
    $("#correctionCurrent").replaceChildren(
      text("p", `Autor ${latest.recorded_by} · ${latest.recorded_at}`),
      text("pre", describe(current)),
    );
    if (context.source)
      $("#correctionCurrent").append(
        text("h4", "Fuente conservada"),
        text("pre", describe(context.source)),
      );
    if (context.count)
      $("#correctionCurrent").append(
        text(
          "p",
          `Vínculos revisados · conteo ${context.count.correction_revision} · movimiento ${context.movement.correction_revision}`,
        ),
      );
    $("#correctionHistory").replaceChildren(
      ...rows.map((r) => {
        const li = text(
          "li",
          `Corrección ${r.version} · ${r.recorded_by} · ${r.recorded_at}`,
        );
        li.append(text("pre", describe(r.event_payload)));
        return li;
      }),
    );
    $("#moreCorrections").hidden = next === null;
    $("#correctBinding").hidden = h.target_kind !== "binding";
    $("#correctCutoff").hidden = h.target_kind !== "cutoff";
    $("#correctionForm [name=product]").required = h.target_kind === "binding";
    $("#correctionForm [name=location]").required = h.target_kind === "binding";
    $("#correctionForm [name=classification]").required =
      h.target_kind === "cutoff";
    options();
    if (h.target_kind === "cutoff")
      $("#correctionForm [name=classification]").value = current.classification;
    $("#correctionState").textContent = !context.eligible
      ? "Los vínculos no corresponden a la misma cuenta y corte. Revísalos antes de corregir esta decisión."
      : !isDirector()
        ? "Consulta del historial: Dirección puede registrar correcciones."
        : `Versión consultada ${h.current_revision}. Toda propuesta exige revisión y motivo. No aplica inventario.`;
  }
  async function open(kind, id, { keepDraft = false } = {}) {
    if (!["binding", "cutoff"].includes(kind) || !uuid.test(id)) invalid();
    const draft = keepDraft ? fields() : null;
    try {
      const h = await history(kind, id),
        prepared = await prepare(h);
      context = prepared;
      rows = [...h.items];
      next = h.next_offset;
      stale = false;
      $("#correctionForm").reset();
      render();
      if (draft) {
        for (const [k, v] of Object.entries(draft)) {
          const el = $(`#correctionForm [name=${k}]`);
          if (
            ["product", "location"].includes(k) &&
            uuid.test(v) &&
            ![...el.options].some((o) => o.value === v)
          )
            el.add(new Option(`Propuesta conservada · ${v}`, v));
          if (
            el.tagName !== "SELECT" ||
            [...el.options].some((o) => o.value === v)
          )
            el.value = v;
        }
      }
      $("#correctionTitle").focus();
    } catch (e) {
      reset();
      throw e;
    }
  }
  async function more() {
    if (!context || next === null) return;
    const h = await history(context.h.target_kind, context.h.target_id, next);
    if (
      h.current_revision !== context.h.current_revision ||
      JSON.stringify(h.original) !== JSON.stringify(context.original)
    ) {
      stale = true;
      $("#correctionState").textContent =
        "El historial cambió. Actualiza la versión antes de revisar o unir páginas.";
      throw new Error("CONTEXT_CHANGED");
    }
    if (
      rows.length &&
      h.items.length &&
      rows.at(-1).previous_revision_id !== h.items[0].revision_id
    )
      invalid();
    const merged = [...rows, ...h.items];
    if (new Set(merged.map((r) => r.revision_id)).size !== merged.length)
      invalid();
    rows = merged;
    next = h.next_offset;
    const draft = fields();
    render();
    for (const [k, v] of Object.entries(draft))
      $(`#correctionForm [name=${k}]`).value = v;
  }
  function review() {
    if (!context || stale || !context.eligible || !isDirector()) invalid();
    const d = fields(),
      { h, current } = context;
    const e = {
      format: "tamago.feed-inventory-correction",
      schema_version: 1,
      revision_id: crypto.randomUUID(),
      company_id: ws.company,
      target_kind: h.target_kind,
      target_id: h.target_id,
      expected_revision: h.current_revision,
      previous_revision_id: h.items[0]?.revision_id ?? null,
      reason: d.reason.trim(),
    };
    if (h.target_kind === "binding") {
      e.product_id = d.product;
      e.location_id = d.location;
      if (
        e.product_id === current.product_id &&
        e.location_id === current.location_id
      ) {
        ws.error("La propuesta no cambia el vínculo vigente.");
        return;
      }
    } else {
      e.classification = d.classification;
      e.expected_opening_binding_revision = context.count.correction_revision;
      e.expected_movement_binding_revision =
        context.movement.correction_revision;
      const latest = h.items[0] ?? h.original;
      if (
        e.classification === current.classification &&
        latest.opening_binding_revision ===
          e.expected_opening_binding_revision &&
        latest.movement_binding_revision ===
          e.expected_movement_binding_revision
      ) {
        ws.error(
          "La decisión y las versiones revisadas ya coinciden; no hay corrección que registrar.",
        );
        return;
      }
    }
    if (!validateInventoryCorrection(e, ws.company)) invalid();
    stage(
      "correction",
      e,
      `Original conservado:\n${describe(context.original.event_payload)}\n\nVersión vigente revisada:\n${describe(current)}\n\nPropuesta de corrección:\n${describe(e)}`,
    );
  }
  async function reconcile(action) {
    const e = action.event;
    let h = await history(e.target_kind, e.target_id),
      offset = Math.max(0, h.current_revision - (e.expected_revision + 1));
    if (offset > 0) {
      const page = await history(e.target_kind, e.target_id, offset);
      if (page.current_revision !== h.current_revision)
        throw new Error("CONTEXT_CHANGED");
      h = page;
    }
    let outcome = assessCorrectionOutcome(h, e, ws.user, offset);
    if (outcome === "recorded") return "retry";
    // A decision may be stale because its binding versions advanced, without a decision correction.
    // Read the decision head again AFTER proving that advance, to exclude an earlier committed intention.
    if (
      outcome === "unknown" &&
      e.target_kind === "cutoff" &&
      h.current_revision === e.expected_revision
    ) {
      const inspected = await prepare(h);
      if (
        inspected.count.correction_revision >
          e.expected_opening_binding_revision ||
        inspected.movement.correction_revision >
          e.expected_movement_binding_revision
      ) {
        const proof = await history(e.target_kind, e.target_id);
        if (proof.current_revision !== e.expected_revision)
          throw new Error("CONTEXT_CHANGED");
        outcome = "rejected";
      }
    }
    if (outcome !== "rejected") {
      ws.error(
        "No se pudo demostrar que esta intención fue rechazada. Conserva su ID y reintenta; no se retiró.",
      );
      return "unknown";
    }
    await open(e.target_kind, e.target_id, { keepDraft: true });
    $("#correctionState").textContent =
      "Avanzó la versión del original o de sus vínculos. La intención anterior no se aplicó. Se conserva tu propuesta en el formulario: compárala con la versión vigente y revísala expresamente antes de enviar otra.";
    return "review";
  }
  $("#correctionLookup").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.currentTarget,
      kind = f.elements.kind.value,
      id = f.elements.id.value.trim();
    void ws.run(() => open(kind, id));
  });
  $("#correctionForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void ws.run(review);
  });
  $("#refreshCorrection").addEventListener(
    "click",
    () =>
      void ws.run(() =>
        open(context.h.target_kind, context.h.target_id, { keepDraft: true }),
      ),
  );
  $("#moreCorrections").addEventListener("click", () => void ws.run(more));
  return {
    reset,
    locks,
    options,
    open,
    reconcile,
    async accepted(e) {
      await open(e.target_kind, e.target_id);
    },
  };
}
