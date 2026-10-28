import { readFileSync } from "node:fs";
import { validOriginDate } from "./transfer-contract.mjs";

// Shared accepted vocabulary, not thresholds or machine calibration.
export const manualClassificationCatalog = JSON.parse(
  readFileSync(
    new URL(
      "../../contracts/manual-classification-catalog.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const typologies = new Set(
  manualClassificationCatalog.typologies.map((x) => x.code),
);
const conditions = new Set(
  manualClassificationCatalog.conditions.map((x) => x.code),
);
const destinations = new Set(
  manualClassificationCatalog.destinations.map((x) => x.code),
);
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const shape = (value, keys) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === keys.slice().sort().join();
const quantity = (value) =>
  Number.isInteger(value) && value > 0 && value <= 2147483647;
const nullableText = (value, max, nonempty = false) =>
  value === null ||
  (typeof value === "string" &&
    [...value].length <= max &&
    (!nonempty || value.trim().length > 0));
const colombianDate = (value) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));

export function validateManualClassification(value, companyId) {
  if (
    !shape(value, [
      "schema_version",
      "session_id",
      "company_id",
      "site_id",
      "house_id",
      "lot_id",
      "origin_business_date",
      "classified_at",
      "machine_configuration_reference",
      "notes",
      "inputs",
      "lines",
    ]) ||
    value.schema_version !== 1 ||
    value.company_id !== companyId ||
    !["session_id", "company_id", "site_id", "house_id", "lot_id"].every(
      (key) => typeof value[key] === "string" && UUID.test(value[key]),
    ) ||
    !validOriginDate(value.origin_business_date) ||
    typeof value.classified_at !== "string" ||
    value.classified_at.startsWith("0000") ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      value.classified_at,
    ) ||
    !Number.isFinite(Date.parse(value.classified_at)) ||
    new Date(value.classified_at).toISOString() !== value.classified_at ||
    colombianDate(value.classified_at) < value.origin_business_date ||
    !nullableText(value.machine_configuration_reference, 200, true) ||
    !nullableText(value.notes, 2000) ||
    !Array.isArray(value.inputs) ||
    value.inputs.length < 1 ||
    value.inputs.length > 50 ||
    !Array.isArray(value.lines) ||
    value.lines.length < 1 ||
    value.lines.length > 100
  )
    return false;
  let incoming = 0,
    outgoing = 0;
  const inputs = new Set(),
    lines = new Set();
  for (const item of value.inputs) {
    if (
      !shape(item, ["transfer_id", "quantity_eggs"]) ||
      typeof item.transfer_id !== "string" ||
      !UUID.test(item.transfer_id) ||
      !quantity(item.quantity_eggs) ||
      inputs.has(item.transfer_id)
    )
      return false;
    inputs.add(item.transfer_id);
    incoming += item.quantity_eggs;
  }
  for (const line of value.lines) {
    if (
      !shape(line, [
        "line_id",
        "quantity_eggs",
        "typology",
        "condition",
        "destination",
      ]) ||
      typeof line.line_id !== "string" ||
      !UUID.test(line.line_id) ||
      !quantity(line.quantity_eggs) ||
      lines.has(line.line_id) ||
      !typologies.has(line.typology) ||
      !conditions.has(line.condition) ||
      !destinations.has(line.destination) ||
      (line.typology === "PIPO" && line.destination !== "DISCARD")
    )
      return false;
    lines.add(line.line_id);
    outgoing += line.quantity_eggs;
  }
  return incoming === outgoing;
}
