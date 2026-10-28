const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quantities = [
  "quantity_sent",
  "quantity_in_transit",
  "quantity_received",
  "quantity_classified",
  "custody_shortage",
  "custody_surplus",
  "quantity_destination_undefined",
  "quantity_discard_declared",
];
const signed = ["quantity_pending_classification", "custody_difference"];
const counts = [
  "collection_count",
  "transfer_count",
  "receipt_count",
  "open_incidents",
];
const keys = [
  "company_id",
  "site_id",
  "house_id",
  "lot_id",
  "lot_code",
  "lot_status",
  "house_name",
  "site_name",
  "origin_business_date",
  "quantity_collected",
  "quantity_at_house",
  ...quantities,
  ...signed,
  ...counts,
]
  .sort()
  .join();
export function validateOriginFlowSummary(value, { companyId, date }) {
  if (
    !uuid.test(companyId ?? "") ||
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    date.startsWith("0000") ||
    !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
    new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date ||
    !value ||
    Object.keys(value).sort().join() !==
      [
        "format",
        "schema_version",
        "company_id",
        "origin_business_date",
        "as_of",
        "purpose",
        "items",
        "next_offset",
      ]
        .sort()
        .join() ||
    value.format !== "tamago.origin-flow-summary" ||
    value.schema_version !== 1 ||
    value.purpose !== "consultation_only" ||
    value.company_id !== companyId ||
    value.origin_business_date !== date ||
    typeof value.as_of !== "string" ||
    !Number.isFinite(Date.parse(value.as_of)) ||
    !Array.isArray(value.items) ||
    value.items.length > 25 ||
    !(
      value.next_offset === null ||
      (Number.isInteger(value.next_offset) &&
        value.next_offset > 0 &&
        value.next_offset <= 100025)
    )
  )
    return false;
  const seen = new Set();
  for (const row of value.items) {
    if (
      !row ||
      Object.keys(row).sort().join() !== keys ||
      row.company_id !== companyId ||
      row.origin_business_date !== date ||
      !["company_id", "site_id", "house_id", "lot_id"].every(
        (key) => typeof row[key] === "string" && uuid.test(row[key]),
      ) ||
      !["lot_code", "lot_status", "house_name", "site_name"].every(
        (key) => typeof row[key] === "string",
      ) ||
      ![...quantities, ...counts].every(
        (key) => Number.isSafeInteger(row[key]) && row[key] >= 0,
      ) ||
      !signed.every((key) => Number.isSafeInteger(row[key]))
    )
      return false;
    if (row.collection_count === 0) {
      if (row.quantity_collected !== null || row.quantity_at_house !== null)
        return false;
    } else if (
      !Number.isSafeInteger(row.quantity_collected) ||
      row.quantity_collected < 0 ||
      row.quantity_at_house !== row.quantity_collected - row.quantity_sent
    )
      return false;
    if (
      row.receipt_count > row.transfer_count ||
      row.quantity_pending_classification !==
        row.quantity_received - row.quantity_classified ||
      row.custody_difference !== row.custody_shortage - row.custody_surplus
    )
      return false;
    const key = [
      row.company_id,
      row.site_id,
      row.house_id,
      row.lot_id,
      date,
    ].join("/");
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}
