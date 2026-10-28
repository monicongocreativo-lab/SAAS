import { validateFeedSupply } from "./feed-supply-contract.mjs";

const keys = [
  "format",
  "schema_version",
  "event_id",
  "company_id",
  "site_id",
  "house_id",
  "lot_id",
  "business_date",
  "occurred_at",
  "product_declared",
  "quantity",
  "unit",
  "location_declared",
  "supplier_declared",
  "physical_batch_declared",
  "delivery_reference_declared",
  "notes",
]
  .sort()
  .join();
const optional = (value) =>
  value === null ||
  (typeof value === "string" && value.trim().length > 0 && value.length <= 200);
export function validateFeedDelivery(value, companyId) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys ||
    value.format !== "tamago.feed-delivery" ||
    value.quantity === "0" ||
    typeof value.location_declared !== "string" ||
    !value.location_declared.trim() ||
    value.location_declared.length > 200 ||
    !optional(value.supplier_declared) ||
    !optional(value.delivery_reference_declared)
  )
    return false;
  // Reuse the proven scalar/date/scope checks only; never record a delivery as supply.
  const {
    format: _format,
    location_declared,
    supplier_declared: _supplier,
    delivery_reference_declared: _reference,
    ...common
  } = value;
  return validateFeedSupply(
    { ...common, source_declared: location_declared },
    companyId,
  );
}
export function validateFeedDeliveryReceipt(receipt, event, actor) {
  return (
    !!receipt &&
    Object.keys(receipt).sort().join() ===
      [
        "format",
        "schema_version",
        "event",
        "recorded_by",
        "recorded_at",
        "inventory_check",
        "duplicate",
      ]
        .sort()
        .join() &&
    receipt.format === "tamago.feed-delivery-receipt" &&
    receipt.schema_version === 1 &&
    typeof receipt.duplicate === "boolean" &&
    receipt.inventory_check === "not_evaluated" &&
    receipt.recorded_by === actor &&
    typeof receipt.recorded_at === "string" &&
    Number.isFinite(Date.parse(receipt.recorded_at)) &&
    validateFeedDelivery(receipt.event, event.company_id) &&
    Object.keys(event).every((k) => receipt.event[k] === event[k])
  );
}
