const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED_FIELDS = new Set([
  "schema_version",
  "event_id",
  "company_id",
  "site_id",
  "house_id",
  "lot_id",
  "business_date",
  "occurrence",
  "quantity_eggs",
  "occurred_at",
  "captured_at",
  "actor_declared_id",
  "device_id",
]);

export function validateCollectionEventV2(event, routeCompanyId) {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    Object.keys(event).length !== ALLOWED_FIELDS.size ||
    Object.keys(event).some((key) => !ALLOWED_FIELDS.has(key))
  )
    return false;

  if (
    event.schema_version !== 2 ||
    !UUID.test(event.event_id) ||
    !UUID.test(event.company_id) ||
    event.company_id !== routeCompanyId ||
    !UUID.test(event.site_id) ||
    !UUID.test(event.house_id) ||
    !UUID.test(event.lot_id) ||
    !UUID.test(event.device_id) ||
    typeof event.business_date !== "string" ||
    !DATE.test(event.business_date) ||
    !isValidDate(event.business_date) ||
    !Number.isInteger(event.occurrence) ||
    event.occurrence < 1 ||
    event.occurrence > 3 ||
    !Number.isSafeInteger(event.quantity_eggs) ||
    event.quantity_eggs < 0 ||
    typeof event.actor_declared_id !== "string" ||
    event.actor_declared_id.trim().length < 1 ||
    event.actor_declared_id.length > 120 ||
    !isCanonicalTimestamp(event.occurred_at) ||
    !isCanonicalTimestamp(event.captured_at) ||
    operationalDate(event.occurred_at) !== event.business_date
  )
    return false;

  return true;
}

function isValidDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isCanonicalTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function operationalDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
