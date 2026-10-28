import { validateInventoryCommand } from "./feed-inventory-contract.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const common = [
  "format",
  "schema_version",
  "revision_id",
  "company_id",
  "target_kind",
  "target_id",
  "expected_revision",
  "previous_revision_id",
  "reason",
];
const counter = (v) => Number.isInteger(v) && v >= 0 && v <= 999999999;
export function validateInventoryCorrection(e, company) {
  if (
    !e ||
    typeof e !== "object" ||
    Array.isArray(e) ||
    !["binding", "cutoff"].includes(e.target_kind)
  )
    return false;
  const keys = [
    ...common,
    ...(e.target_kind === "binding"
      ? ["product_id", "location_id"]
      : [
          "classification",
          "expected_opening_binding_revision",
          "expected_movement_binding_revision",
        ]),
  ];
  return (
    Object.keys(e).sort().join() === keys.sort().join() &&
    e.format === "tamago.feed-inventory-correction" &&
    e.schema_version === 1 &&
    e.company_id === company &&
    ["revision_id", "company_id", "target_id"].every((k) =>
      uuid.test(e[k] ?? ""),
    ) &&
    counter(e.expected_revision) &&
    (e.expected_revision === 0
      ? e.previous_revision_id === null
      : uuid.test(e.previous_revision_id ?? "")) &&
    typeof e.reason === "string" &&
    e.reason.trim().length > 0 &&
    e.reason.length <= 2000 &&
    (e.target_kind === "binding"
      ? uuid.test(e.product_id ?? "") && uuid.test(e.location_id ?? "")
      : ["included_in_count", "after_count"].includes(e.classification) &&
        counter(e.expected_opening_binding_revision) &&
        counter(e.expected_movement_binding_revision))
  );
}
export function validateCorrectionReceipt(r, e, actor) {
  return (
    !!r &&
    Object.keys(r).sort().join() ===
      [
        "format",
        "schema_version",
        "event",
        "actor_id",
        "recorded_at",
        "duplicate",
        "inventory_check",
      ]
        .sort()
        .join() &&
    r.format === "tamago.feed-inventory-command-receipt" &&
    r.schema_version === 1 &&
    r.actor_id === actor &&
    uuid.test(actor ?? "") &&
    typeof r.recorded_at === "string" &&
    Number.isFinite(Date.parse(r.recorded_at)) &&
    typeof r.duplicate === "boolean" &&
    r.inventory_check === "not_applied" &&
    validateInventoryCorrection(r.event, e.company_id) &&
    Object.keys(e).every((k) => e[k] === r.event[k])
  );
}
export function validateInventoryHistory(h, company, kind, id, offset = 0) {
  if (
    !h ||
    Object.keys(h).sort().join() !==
      [
        "format",
        "schema_version",
        "company_id",
        "target_kind",
        "target_id",
        "current_revision",
        "original",
        "items",
        "next_offset",
        "inventory_check",
      ]
        .sort()
        .join() ||
    h.format !== "tamago.feed-inventory-history" ||
    h.schema_version !== 1 ||
    h.company_id !== company ||
    h.target_kind !== kind ||
    h.target_id !== id ||
    !counter(h.current_revision) ||
    h.inventory_check !== "not_applied" ||
    !Array.isArray(h.items) ||
    h.items.length > 25 ||
    !(h.next_offset === null || h.next_offset === offset + 25)
  )
    return false;
  const o = h.original;
  if (
    !o ||
    o.company_id !== company ||
    !uuid.test(o.recorded_by ?? "") ||
    !Number.isFinite(Date.parse(o.recorded_at)) ||
    !validateInventoryCommand(o.event_payload, company, kind) ||
    o[kind === "binding" ? "binding_id" : "action_id"] !== id
  )
    return false;
  if (
    h.items.length !== Math.min(25, Math.max(0, h.current_revision - offset)) ||
    h.next_offset !== (h.current_revision - offset > 25 ? offset + 25 : null)
  )
    return false;
  const seen = new Set();
  for (let n = 0; n < h.items.length; n++) {
    const r = h.items[n],
      e = r.event_payload;
    if (
      !validateInventoryCorrection(e, company) ||
      e.target_kind !== kind ||
      e.target_id !== id ||
      r.company_id !== company ||
      r.target_kind !== kind ||
      r.target_id !== id ||
      r.revision_id !== e.revision_id ||
      r.version !== e.expected_revision + 1 ||
      r.version !== h.current_revision - offset - n ||
      r.previous_revision_id !== e.previous_revision_id ||
      !uuid.test(r.recorded_by ?? "") ||
      !Number.isFinite(Date.parse(r.recorded_at)) ||
      seen.has(r.revision_id)
    )
      return false;
    if (n > 0 && h.items[n - 1].previous_revision_id !== r.revision_id)
      return false;
    if (
      kind === "binding"
        ? r.product_id !== e.product_id || r.location_id !== e.location_id
        : r.classification !== e.classification ||
          r.opening_binding_revision !== e.expected_opening_binding_revision ||
          r.movement_binding_revision !== e.expected_movement_binding_revision
    )
      return false;
    seen.add(r.revision_id);
  }
  return true;
}
export function validateEffectiveBinding(b, company, kind, id) {
  if (
    !b ||
    b.company_id !== company ||
    b.source_kind !== kind ||
    b.source_id !== id ||
    !uuid.test(b.binding_id ?? "") ||
    !uuid.test(b.product_id ?? "") ||
    !uuid.test(b.location_id ?? "") ||
    !counter(b.correction_revision) ||
    !uuid.test(b.effective_actor ?? "") ||
    !Number.isFinite(Date.parse(b.effective_recorded_at)) ||
    !validateInventoryCommand(b.event_payload, company, "binding")
  )
    return false;
  const base = b.event_payload;
  if (
    base.binding_id !== b.binding_id ||
    base.source_kind !== kind ||
    base.source_id !== id
  )
    return false;
  if (b.correction_revision === 0)
    return (
      b.current_revision_id === null &&
      b.effective_actor === b.recorded_by &&
      b.current_event &&
      Object.keys(base).every((k) => base[k] === b.current_event[k]) &&
      b.product_id === base.product_id &&
      b.location_id === base.location_id
    );
  const e = b.current_event;
  return (
    validateInventoryCorrection(e, company) &&
    e.target_kind === "binding" &&
    e.target_id === b.binding_id &&
    e.revision_id === b.current_revision_id &&
    e.expected_revision + 1 === b.correction_revision &&
    e.product_id === b.product_id &&
    e.location_id === b.location_id
  );
}
// Only an advanced immutable head proves this expected version can no longer apply.
// A durable matching row is evidence to retry for the original receipt, never a fabricated receipt.
export function assessCorrectionOutcome(h, e, actor, offset = 0) {
  if (
    !e ||
    !validateInventoryCorrection(e, e.company_id) ||
    !validateInventoryHistory(
      h,
      e.company_id,
      e.target_kind,
      e.target_id,
      offset,
    )
  )
    return "unknown";
  const row = h.items.find((r) => r.version === e.expected_revision + 1);
  if (row?.revision_id === e.revision_id) {
    return row.recorded_by === actor &&
      Object.keys(e).every((k) => row.event_payload[k] === e[k])
      ? "recorded"
      : "unknown";
  }
  return row && h.current_revision > e.expected_revision
    ? "rejected"
    : "unknown";
}
