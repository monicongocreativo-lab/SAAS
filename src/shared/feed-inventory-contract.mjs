const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ref = (v) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 2000;
const sets = {
  catalog: [
    "format",
    "schema_version",
    "item_id",
    "company_id",
    "site_id",
    "house_id",
    "lot_id",
    "kind",
    "code",
    "label",
    "unit",
    "reason",
  ],
  binding: [
    "format",
    "schema_version",
    "binding_id",
    "company_id",
    "source_kind",
    "source_id",
    "product_id",
    "location_id",
    "reason",
  ],
  cutoff: [
    "format",
    "schema_version",
    "action_id",
    "company_id",
    "opening_id",
    "count_id",
    "source_kind",
    "source_id",
    "classification",
    "reason",
  ],
};
const formats = {
  catalog: "tamago.feed-catalog-item",
  binding: "tamago.feed-fact-binding",
  cutoff: "tamago.feed-cutoff-decision",
};
export function validateInventoryCommand(v, companyId, kind) {
  const expected = [...(sets[kind] ?? [])];
  const guarded =
    kind === "cutoff" &&
    v &&
    (Object.hasOwn(v, "expected_opening_binding_revision") ||
      Object.hasOwn(v, "expected_movement_binding_revision"));
  if (guarded)
    expected.push(
      "expected_opening_binding_revision",
      "expected_movement_binding_revision",
    );
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    !sets[kind] ||
    Object.keys(v).sort().join() !== expected.sort().join() ||
    v.format !== formats[kind] ||
    v.schema_version !== 1 ||
    v.company_id !== companyId ||
    !ref(v.reason)
  )
    return false;
  const ids =
    kind === "catalog"
      ? ["item_id", "company_id", "site_id", "house_id", "lot_id"]
      : kind === "binding"
        ? ["binding_id", "company_id", "source_id", "product_id", "location_id"]
        : ["action_id", "company_id", "opening_id", "count_id", "source_id"];
  if (!ids.every((k) => uuid.test(v[k] ?? ""))) return false;
  if (kind === "catalog")
    return (
      ["product", "location"].includes(v.kind) &&
      typeof v.code === "string" &&
      /^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(v.code) &&
      typeof v.label === "string" &&
      v.label.trim().length > 0 &&
      v.label.length <= 200 &&
      (v.kind === "product" ? v.unit === "BAG_40KG" : v.unit === null)
    );
  if (kind === "binding")
    return ["supply", "delivery", "count"].includes(v.source_kind);
  return (
    (!guarded ||
      [
        v.expected_opening_binding_revision,
        v.expected_movement_binding_revision,
      ].every((n) => Number.isInteger(n) && n >= 0 && n <= 999999999)) &&
    ["supply", "delivery"].includes(v.source_kind) &&
    ["included_in_count", "after_count"].includes(v.classification)
  );
}
export function validateInventoryReceipt(r, event, actor, kind) {
  return (
    !!r &&
    Object.keys(r).sort().join() ===
      [
        "format",
        "schema_version",
        "event",
        "actor_id",
        "recorded_at",
        "inventory_check",
        "duplicate",
      ]
        .sort()
        .join() &&
    r.format === "tamago.feed-inventory-command-receipt" &&
    r.schema_version === 1 &&
    r.actor_id === actor &&
    uuid.test(actor ?? "") &&
    typeof r.recorded_at === "string" &&
    Number.isFinite(Date.parse(r.recorded_at)) &&
    r.inventory_check === "not_applied" &&
    typeof r.duplicate === "boolean" &&
    validateInventoryCommand(r.event, event.company_id, kind) &&
    Object.keys(event).every((k) => r.event[k] === event[k])
  );
}
const dec = (v) =>
  typeof v === "string" &&
  v.length <= 256 &&
  /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(v) &&
  v !== "-0";
function scaled(v, scale) {
  const [w, f = ""] = v.split(".");
  return BigInt(w + f.padEnd(scale, "0"));
}
export function validateBalancePreview(v, companyId, openingId) {
  const keys = [
    "format",
    "schema_version",
    "company_id",
    "opening_id",
    "purpose",
    "inventory_check",
    "coverage",
    "through_at",
    "status",
    "reason",
    "product_id",
    "location_id",
    "count_id",
    "cutoff_at",
    "opening_bags",
    "known_receipts_bags",
    "known_supplied_bags",
    "diagnostic_balance_bags",
    "balance_bags",
    "unmapped_count",
    "pending_tie_count",
    "blockers",
    "blockers_truncated",
  ]
    .sort()
    .join();
  if (!v || Object.keys(v).sort().join() !== keys) return false;
  if (
    v?.format !== "tamago.feed-balance-preview" ||
    v.schema_version !== 1 ||
    v.company_id !== companyId ||
    v.opening_id !== openingId ||
    v.purpose !== "reconciliation_preview" ||
    v.inventory_check !== "not_applied" ||
    v.coverage !== "server_records_only" ||
    typeof v.through_at !== "string" ||
    !Number.isFinite(Date.parse(v.through_at)) ||
    !["resolved", "blocked", "negative"].includes(v.status) ||
    !Number.isSafeInteger(v.unmapped_count) ||
    v.unmapped_count < 0 ||
    !Number.isSafeInteger(v.pending_tie_count) ||
    v.pending_tie_count < 0 ||
    !Array.isArray(v.blockers) ||
    v.blockers.length > 25 ||
    typeof v.blockers_truncated !== "boolean"
  )
    return false;
  if (
    v.blockers.some(
      (b) =>
        !["supply", "delivery"].includes(b.source_kind) ||
        !uuid.test(b.source_id ?? "") ||
        !["unmapped", "cutoff_tie"].includes(b.problem) ||
        (b.previous_decision_id !== undefined &&
          b.previous_decision_id !== null &&
          !uuid.test(b.previous_decision_id)),
    )
  )
    return false;
  const total = v.unmapped_count + v.pending_tie_count;
  if (
    !Number.isSafeInteger(total) ||
    v.blockers.length !== Math.min(25, total) ||
    v.blockers_truncated !== total > 25 ||
    new Set(v.blockers.map((b) => `${b.source_kind}/${b.source_id}`)).size !==
      v.blockers.length ||
    v.blockers.filter((b) => b.problem === "unmapped").length >
      v.unmapped_count ||
    v.blockers.filter((b) => b.problem === "cutoff_tie").length >
      v.pending_tie_count
  )
    return false;
  if (v.reason !== null)
    return (
      v.status === "blocked" &&
      [
        "opening_not_approved",
        "opening_not_linked",
        "cutoff_after_through",
      ].includes(v.reason) &&
      v.balance_bags === null &&
      v.diagnostic_balance_bags === null
    );
  if (
    !["product_id", "location_id", "count_id"].every((k) =>
      uuid.test(v[k] ?? ""),
    ) ||
    typeof v.cutoff_at !== "string" ||
    !Number.isFinite(Date.parse(v.cutoff_at))
  )
    return false;
  if (Date.parse(v.cutoff_at) > Date.parse(v.through_at)) return false;
  const values = [
    v.opening_bags,
    v.known_receipts_bags,
    v.known_supplied_bags,
    v.diagnostic_balance_bags,
  ];
  if (!values.every(dec) || values.slice(0, 3).some((n) => n.startsWith("-")))
    return false;
  const scale = Math.max(...values.map((n) => (n.split(".")[1] ?? "").length));
  if (
    scaled(values[0], scale) +
      scaled(values[1], scale) -
      scaled(values[2], scale) !==
    scaled(values[3], scale)
  )
    return false;
  if (v.unmapped_count + v.pending_tie_count > 0)
    return v.status === "blocked" && v.balance_bags === null;
  if (v.diagnostic_balance_bags.startsWith("-"))
    return v.status === "negative" && v.balance_bags === null;
  return (
    v.status === "resolved" && v.balance_bags === v.diagnostic_balance_bags
  );
}
