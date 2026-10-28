const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEYS = [
  "schema_version",
  "transfer_id",
  "company_id",
  "site_id",
  "house_id",
  "lot_id",
  "origin_business_date",
  "quantity_sent",
  "sent_from",
  "sent_to",
  "sent_at",
]
  .sort()
  .join();
export function validOriginDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000")
  )
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function validateTransferDispatch(value, companyId) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== KEYS ||
    value.schema_version !== 1 ||
    value.company_id !== companyId ||
    !["transfer_id", "company_id", "site_id", "house_id", "lot_id"].every(
      (key) => typeof value[key] === "string" && UUID.test(value[key]),
    ) ||
    !validOriginDate(value.origin_business_date) ||
    !Number.isInteger(value.quantity_sent) ||
    value.quantity_sent < 1 ||
    value.quantity_sent > 2147483647 ||
    !["sent_from", "sent_to"].every(
      (key) =>
        typeof value[key] === "string" &&
        value[key].trim().length > 0 &&
        value[key].length <= 160,
    ) ||
    typeof value.sent_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.sent_at) ||
    value.sent_at.startsWith("0000") ||
    !Number.isFinite(Date.parse(value.sent_at)) ||
    new Date(value.sent_at).toISOString() !== value.sent_at
  )
    return false;
  return true;
}
