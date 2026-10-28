import { validateFeedSupply } from "./feed-supply-contract.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const countKeys = [
  "format",
  "schema_version",
  "opening_id",
  "count_id",
  "company_id",
  "site_id",
  "house_id",
  "lot_id",
  "business_date",
  "cutoff_at",
  "product_declared",
  "location_declared",
  "quantity",
  "unit",
  "evidence_reference",
  "notes",
  "expected_revision",
  "previous_count_id",
]
  .sort()
  .join();
const approvalKeys = [
  "format",
  "schema_version",
  "action_id",
  "company_id",
  "opening_id",
  "count_id",
  "expected_revision",
  "reason",
]
  .sort()
  .join();
const reference = (v) =>
  typeof v === "string" && v.trim().length > 0 && v.length <= 2000;
export function validateOpeningCount(v, companyId) {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).sort().join() !== countKeys ||
    v.format !== "tamago.feed-opening-count" ||
    !uuid.test(v.opening_id ?? "") ||
    !uuid.test(v.count_id ?? "") ||
    !Number.isInteger(v.expected_revision) ||
    v.expected_revision < 0 ||
    v.expected_revision > 1000000 ||
    !(v.expected_revision === 0
      ? v.previous_count_id === null
      : uuid.test(v.previous_count_id ?? "")) ||
    !reference(v.evidence_reference) ||
    typeof v.location_declared !== "string" ||
    !v.location_declared.trim() ||
    v.location_declared.length > 200
  )
    return false;
  return validateFeedSupply(
    {
      schema_version: v.schema_version,
      event_id: v.count_id,
      company_id: v.company_id,
      site_id: v.site_id,
      house_id: v.house_id,
      lot_id: v.lot_id,
      business_date: v.business_date,
      occurred_at: v.cutoff_at,
      product_declared: v.product_declared,
      quantity: v.quantity,
      unit: v.unit,
      source_declared: v.location_declared,
      physical_batch_declared: null,
      notes: v.notes,
    },
    companyId,
  );
}
export function validateOpeningApproval(v, companyId) {
  return (
    !!v &&
    Object.keys(v).sort().join() === approvalKeys &&
    v.format === "tamago.feed-opening-approval" &&
    v.schema_version === 1 &&
    v.company_id === companyId &&
    ["action_id", "company_id", "opening_id", "count_id"].every((k) =>
      uuid.test(v[k] ?? ""),
    ) &&
    Number.isInteger(v.expected_revision) &&
    v.expected_revision >= 1 &&
    v.expected_revision <= 1000001 &&
    reference(v.reason)
  );
}
export function validateOpeningReceipt(r, event, actor, approval = false) {
  return (
    !!r &&
    Object.keys(r).sort().join() ===
      [
        "format",
        "schema_version",
        "event",
        "actor_id",
        "recorded_at",
        "revision",
        "state_at_recording",
        "inventory_check",
        "duplicate",
      ]
        .sort()
        .join() &&
    r.format ===
      `tamago.feed-opening-${approval ? "approval" : "count"}-receipt` &&
    r.schema_version === 1 &&
    r.actor_id === actor &&
    uuid.test(actor ?? "") &&
    typeof r.recorded_at === "string" &&
    Number.isFinite(Date.parse(r.recorded_at)) &&
    r.revision === event.expected_revision + (approval ? 0 : 1) &&
    r.state_at_recording === (approval ? "approved" : "pending") &&
    r.inventory_check === "not_applied" &&
    typeof r.duplicate === "boolean" &&
    (approval
      ? validateOpeningApproval(r.event, event.company_id)
      : validateOpeningCount(r.event, event.company_id)) &&
    Object.keys(event).every((k) => r.event[k] === event[k])
  );
}
