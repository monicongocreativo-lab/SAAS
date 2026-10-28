const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keys = [
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
  "source_declared",
  "physical_batch_declared",
  "notes",
]
  .sort()
  .join();
export const validFeedQuantity = (value) =>
  typeof value === "string" &&
  value.length <= 100 &&
  /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(value);
export function validateFeedSupply(value, companyId) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys ||
    value.schema_version !== 1 ||
    value.company_id !== companyId ||
    !["event_id", "company_id", "site_id", "house_id", "lot_id"].every(
      (k) => typeof value[k] === "string" && uuid.test(value[k]),
    ) ||
    !validFeedQuantity(value.quantity) ||
    !["BAG_40KG"].includes(value.unit)
  )
    return false;
  if (
    typeof value.business_date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.business_date) ||
    value.business_date.startsWith("0000") ||
    typeof value.occurred_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.occurred_at) ||
    value.occurred_at.startsWith("0000")
  )
    return false;
  const date = new Date(value.occurred_at);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== value.occurred_at ||
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Bogota",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date) !== value.business_date
  )
    return false;
  return (
    typeof value.product_declared === "string" &&
    value.product_declared.trim().length > 0 &&
    value.product_declared.length <= 200 &&
    ["source_declared", "physical_batch_declared"].every(
      (k) =>
        value[k] === null ||
        (typeof value[k] === "string" &&
          value[k].trim().length > 0 &&
          value[k].length <= 200),
    ) &&
    (value.notes === null ||
      (typeof value.notes === "string" && value.notes.length <= 2000))
  );
}
export function validateFeedReceipt(value, event, actor) {
  return (
    !!value &&
    Object.keys(value).sort().join() ===
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
    value.format === "tamago.feed-supply-receipt" &&
    value.schema_version === 1 &&
    typeof value.duplicate === "boolean" &&
    value.inventory_check === "not_evaluated" &&
    value.recorded_by === actor &&
    typeof value.recorded_at === "string" &&
    Number.isFinite(Date.parse(value.recorded_at)) &&
    validateFeedSupply(value.event, event.company_id) &&
    Object.keys(event).every((k) => value.event[k] === event[k])
  );
}

// Decimal input normalization only. No conversion to mass or floating point.
export function normalizeFeedQuantity(input) {
  if (
    typeof input !== "string" ||
    input.length > 110 ||
    !/^[0-9]+(?:[.,][0-9]+)?$/.test(input.trim())
  )
    return null;
  const [whole, fraction = ""] = input.trim().replace(",", ".").split(".");
  const tail = fraction.replace(/0+$/, "");
  const value = whole.replace(/^0+(?=[0-9])/, "") + (tail ? `.${tail}` : "");
  return validFeedQuantity(value) ? value : null;
}
