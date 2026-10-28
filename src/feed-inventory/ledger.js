import {
  ledgerTime,
  validateLedgerCommand,
  validateLedgerEntries,
  validateLedgerReceipt,
  validateLedgerReview,
} from "../shared/feed-ledger-contract.mjs";
import { validateOpeningContext } from "../shared/feed-opening-context.mjs";
import { timeNow, today, uuid } from "../shared/feed-workspace.mjs";

const $ = (s) => document.querySelector(s),
  n = (tag, value) => {
    const e = document.createElement(tag);
    e.textContent = value;
    return e;
  };
const when = (v) =>
  new Date(v).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    hourCycle: "h23",
  });
const kind = (v) =>
  ({ opening: "Apertura", delivery: "Recepción", supply: "Suministro" })[v] ??
  v;
export function createLedger({
  ws,
  scopeMatches,
  isDirector,
  hasIntent,
  stage,
}) {
  let context = null,
    sources = [],
    sourceNext = null,
    entries = [],
    entryNext = null,
    stale = false,
    pendingOpening = null;
  $("#bookLoading").textContent = "";
  const api = (path, options) =>
    ws.api(`${ws.root}/feed-inventory/${path}`, options);
  const invalid = () => {
    throw new Error("INVALID_RESPONSE");
  };
  function invalidate(
    message = "Consulta el libro nuevamente antes de revisarlo.",
  ) {
    context = null;
    sources = [];
    sourceNext = null;
    entries = [];
    entryNext = null;
    stale = false;
    $("#bookContext").hidden = true;
    $("#bookForm").hidden = true;
    $("#bookSources").replaceChildren();
    $("#bookHistory").replaceChildren();
    $("#bookState").textContent = message;
  }
  async function loading(label, action) {
    $("#bookLoading").textContent = label;
    try {
      return await action();
    } finally {
      $("#bookLoading").textContent = "";
    }
  }
  function reset() {
    invalidate();
    pendingOpening = null;
    $("#bookLoading").textContent = "";
    $("#bookLookup").reset();
    $("#bookForm").reset();
    $("#bookLookup [name=date]").value = today();
    $("#bookLookup [name=time]").value = timeNow();
    for (const id of [
      "bookScope",
      "bookBalance",
      "bookProposal",
      "bookCount",
      "bookHistoryState",
    ])
      $(`#${id}`).textContent = "";
  }
  function locks() {
    const frozen = ws.busy || hasIntent();
    for (const e of $("#bookLookup").elements)
      e.disabled = frozen || !ws.lot($("#lot").value);
    for (const e of $("#bookForm").elements)
      e.disabled =
        frozen ||
        stale ||
        !context?.can_manage ||
        !isDirector() ||
        !(context.can_activate || context.can_post) ||
        !navigator.onLine;
    for (const id of ["bookMoreSources", "bookMoreHistory", "bookHistoryLoad"])
      $(`#${id}`).disabled = frozen || stale;
    $("#bookForm").hidden =
      !context?.can_manage ||
      !isDirector() ||
      !(context.can_activate || context.can_post);
  }
  function timestamp() {
    const date = $("#bookLookup [name=date]").value,
      time = $("#bookLookup [name=time]").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time))
      invalid();
    const value = new Date(`${date}T${time}:00.000-05:00`).toISOString();
    if (!ledgerTime(value)) invalid();
    return value;
  }
  const path = (id, time, offset = 0) =>
    `ledger-review/${id}?through_at=${encodeURIComponent(time)}&offset=${offset}`;
  async function fetchReview(id, time, offset = 0) {
    const v = await api(path(id, time, offset));
    if (
      !validateLedgerReview(v, ws.company, id, offset) ||
      Date.parse(v.through_at) !== Date.parse(time)
    )
      invalid();
    return v;
  }
  async function load(id, time) {
    invalidate();
    if (!uuid.test(id ?? "") || !ledgerTime(time)) invalid();
    const c = await ws.api(`${ws.root}/feed-openings/${id}?offset=0`);
    if (
      !validateOpeningContext(c, { companyId: ws.company, id }) ||
      !scopeMatches(c.opening)
    )
      throw new Error("CORRECTION_SCOPE");
    const v = await fetchReview(id, time);
    if (v.account && !scopeMatches(v.account))
      throw new Error("CORRECTION_SCOPE");
    context = v;
    sources = [...v.items];
    sourceNext = v.next_offset;
    stale = false;
    render();
    $("#bookTitle").focus();
  }
  function render() {
    const v = context;
    if (!v) return;
    const messages = {
      needs_activation:
        "Conteo aprobado y conjunto sin bloqueos. Falta activar explícitamente la primera apertura.",
      current:
        "Libro al día con los hechos conocidos de la ventana consultada.",
      pending:
        "Hay movimientos o correcciones sin aplicar. Dirección debe revisar el conjunto.",
      blocked:
        "Aplicación pendiente de Dirección: faltan aprobación, vínculo o decisión de empate.",
      insufficient:
        "Saldo insuficiente: la captura se conserva y todo este conjunto queda pendiente de Dirección. No se aplica un saldo negativo.",
      already_active:
        "Esta cuenta ya tiene otra apertura efectiva. La sustitución no está habilitada; consulta su caso activo.",
      opening_changed:
        "Se corrigió la identidad del conteo activado. El libro requiere revisión de apertura, aún no habilitada; no se cambia automáticamente.",
      future_window:
        "La fecha/hora consultada es futura. No se puede aplicar un saldo futuro.",
      earlier_window:
        "La ventana no puede retroceder antes de la última aplicación.",
      other_account_pending:
        "Una fuente conserva efecto en otra cuenta. Dirección debe conciliar primero esa cuenta para no duplicar inventario.",
    };
    $("#bookContext").hidden = false;
    $("#bookState").textContent =
      v.status === "blocked" && v.preview.reason === "cutoff_after_through"
        ? "La ventana termina antes del conteo. Revisa la fecha y hora."
        : messages[v.status];
    $("#bookScope").textContent =
      `${ws.label($("#lot").value)} · caso ${v.opening_id} · hasta ${when(v.through_at)}`;
    $("#bookBalance").textContent = v.account
      ? `Saldo del libro: ${v.book_balance_bags} bultos de40kg · versión ${v.revision} · última ventana aplicada ${when(v.book_through_at)}`
      : "Sin apertura efectiva: el conteo aprobado todavía no es saldo del libro.";
    $("#bookProposal").textContent =
      (v.proposed_balance_bags === null
        ? "Cálculo del conjunto no evaluable."
        : `Resultado del conjunto revisable: ${v.proposed_balance_bags} bultos de40kg.`) +
      (v.available_bags === null
        ? " No hay saldo disponible confirmado para esta consulta."
        : ` Saldo registrado disponible en esta ventana: ${v.available_bags} bultos de40kg.`);
    $("#bookCount").textContent =
      `Movimientos del conjunto: ${v.source_count} · pendientes de aplicación: ${v.pending_sources}${v.account ? ` · cuenta ${v.account.account_id} · apertura efectiva ${v.account.opening_id}` : ""}`;
    $("#bookSources").replaceChildren(
      ...sources.map((s) =>
        n(
          "li",
          `${kind(s.source_kind)} · ${when(s.occurred_at)} · ${s.quantity_bags} bultos · ID ${s.source_id} · efecto registrado ${s.applied_bags} · propuesto ${s.desired_bags} · diferencia ${s.delta_bags}${s.pending ? " · pendiente" : ""}`,
        ),
      ),
    );
    $("#bookMoreSources").hidden = sourceNext === null;
    $("#bookHistoryPanel").hidden = !v.account;
    $("#bookHistory").replaceChildren();
    $("#bookMoreHistory").hidden = true;
    $("#bookHistoryState").textContent = "";
    $("#reviewBook").textContent = v.can_activate
      ? "Revisar primera activación"
      : "Revisar aplicación del conjunto";
  }
  async function moreSources() {
    if (!context || sourceNext === null) return;
    const v = await fetchReview(
      context.opening_id,
      new Date(context.through_at).toISOString(),
      sourceNext,
    );
    if (v.review_token !== context.review_token) {
      stale = true;
      $("#bookProposal").textContent =
        "Consulta desactualizada: el saldo disponible no se confirma hasta actualizar.";
      $("#bookState").textContent =
        "El conjunto cambió al paginar. Consulta nuevamente antes de revisar una acción.";
      throw new Error("CONTEXT_CHANGED");
    }
    const combined = [...sources, ...v.items];
    if (
      new Set(combined.map((s) => `${s.source_kind}/${s.source_id}`)).size !==
      combined.length
    )
      invalid();
    sources = combined;
    sourceNext = v.next_offset;
    render();
  }
  async function history(append = false) {
    if (!context?.account) return;
    const offset = append ? entryNext : 0,
      v = await api(
        `ledger-entries/${context.account.account_id}?offset=${offset}`,
      );
    if (
      !validateLedgerEntries(v, ws.company, context.account.account_id, offset)
    )
      invalid();
    if (
      v.revision !== context.revision ||
      v.book_balance_bags !== context.book_balance_bags
    ) {
      stale = true;
      $("#bookProposal").textContent =
        "Consulta desactualizada: el saldo disponible no se confirma hasta actualizar.";
      $("#bookState").textContent =
        "El libro cambió. Consulta nuevamente antes de unir el historial o aplicar.";
      throw new Error("CONTEXT_CHANGED");
    }
    const combined = append ? [...entries, ...v.items] : v.items;
    if (new Set(combined.map((e) => e.entry_id)).size !== combined.length)
      invalid();
    entries = combined;
    entryNext = v.next_offset;
    $("#bookHistory").replaceChildren(
      ...entries.map((e) =>
        n(
          "li",
          `Operación ${e.operation_revision} · ID operación ${e.action_id} · ${kind(e.source_kind)} · ID fuente ${e.source_id} · variación ${e.delta} · efecto acumulado de fuente ${e.desired_after} bultos · ${e.recorded_by} · ${when(e.recorded_at)} · motivo: ${e.operation_payload.reason}`,
        ),
      ),
    );
    $("#bookHistoryState").textContent =
      `${entries.length} asientos consultados; se conservan apertura y compensaciones.`;
    $("#bookMoreHistory").hidden = entryNext === null;
  }
  function review() {
    if (
      !context ||
      stale ||
      !context.can_manage ||
      !isDirector() ||
      !(context.can_activate || context.can_post)
    )
      invalid();
    if (!$("#bookForm [name=reason]").value.trim()) {
      ws.error("Escribe el motivo y el soporte revisado antes de continuar.");
      return;
    }
    const v = context,
      e = {
        format: v.can_activate
          ? "tamago.feed-inventory-activation"
          : "tamago.feed-inventory-posting",
        schema_version: 1,
        action_id: crypto.randomUUID(),
        company_id: ws.company,
        through_at: new Date(v.through_at).toISOString(),
        review_token: v.review_token,
        reason: $("#bookForm [name=reason]").value.trim(),
        ...(v.can_activate
          ? { opening_id: v.opening_id }
          : {
              account_id: v.account.account_id,
              expected_revision: v.revision,
            }),
      };
    if (!validateLedgerCommand(e, ws.company)) invalid();
    pendingOpening = v.opening_id;
    stage(
      "ledger",
      e,
      `${v.can_activate ? "Primera apertura efectiva:" : "Aplicación al libro:"}\n${ws.label($("#lot").value)}\nCaso ${v.opening_id}\nCuenta ${v.account?.account_id ?? e.action_id}\nConteo aprobado ${v.anchor.count_id} · ${v.anchor.opening_bags} bultos\nHasta ${when(v.through_at)}\nSaldo del libro ${v.book_balance_bags ?? "sin activar"} · resultado revisado ${v.proposed_balance_bags} bultos\nMovimientos ${v.source_count} · diferencias pendientes ${v.pending_sources}\nID de operación: ${e.action_id}\nMotivo: ${e.reason}\nSolo hechos de servidor. No certifica existencia física; se conservan todos los asientos anteriores.`,
    );
  }
  async function reconcile(action) {
    const e = action.event,
      id = e.opening_id ?? pendingOpening;
    if (!id) invalid();
    async function recorded() {
      try {
        const r = await api(`ledger-actions/${e.action_id}`);
        if (!validateLedgerReceipt(r, e, ws.user)) invalid();
        return true;
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    }
    if (await recorded()) return "retry";
    const v = await fetchReview(id, e.through_at);
    if (v.review_token === e.review_token) {
      ws.error(
        "No se pudo demostrar un cambio que rechace esta intención. Conserva el ID y reintenta; no se retiró.",
      );
      return "unknown";
    }
    if (await recorded()) return "retry";
    const reason = $("#bookForm [name=reason]").value;
    await load(id, e.through_at);
    $("#bookForm [name=reason]").value = reason;
    $("#bookState").textContent +=
      " La intención anterior no consta aplicada y el conjunto cambió. Compáralo nuevamente; no se reenviará automáticamente.";
    return "review";
  }
  $("#bookLookup").addEventListener("submit", (e) => {
    e.preventDefault();
    const id = e.currentTarget.elements.id.value.trim();
    let t;
    try {
      t = timestamp();
    } catch {
      ws.error("Revisa fecha y hora de la consulta del libro.");
      return;
    }
    void ws.run(() =>
      loading("Consultando libro y movimientos…", () => load(id, t)),
    );
  });
  for (const name of ["id", "date", "time"])
    $(`#bookLookup [name=${name}]`).addEventListener("input", () => {
      if (!hasIntent()) invalidate();
    });
  $("#bookForm").addEventListener("submit", (e) => {
    e.preventDefault();
    void ws.run(review);
  });
  $("#bookMoreSources").addEventListener(
    "click",
    () =>
      void ws.run(() => loading("Consultando más movimientos…", moreSources)),
  );
  $("#bookHistoryLoad").addEventListener(
    "click",
    () => void ws.run(() => loading("Consultando asientos…", () => history())),
  );
  $("#bookMoreHistory").addEventListener(
    "click",
    () =>
      void ws.run(() =>
        loading("Consultando asientos anteriores…", () => history(true)),
      ),
  );
  return {
    reset,
    locks,
    reconcile,
    invalidate,
    async accepted(e) {
      const id = e.opening_id ?? pendingOpening;
      if (!id) invalid();
      await load(id, e.through_at);
      $("#bookForm").reset();
      await history();
    },
    changed() {
      if (context) {
        invalidate(
          "Los hechos fueron modificados. Consulta nuevamente el libro.",
        );
        $("#bookLoading").textContent =
          "Los hechos fueron modificados. Consulta nuevamente el libro.";
      }
    },
  };
}
