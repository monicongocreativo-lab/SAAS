import validate from "../../.generated/collection-validator.mjs";

export function operationalDate(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Bogota",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function pack(records) {
  return {
    format: "tamago.collection-export",
    schema_version: 1,
    environment: "synthetic",
    records,
  };
}

export function occurrenceKey(event) {
  return JSON.stringify([
    event.company_id,
    event.lot_id,
    event.shed_id,
    event.business_date,
    event.occurrence,
  ]);
}

export function assertPackage(value) {
  if (!validate(value))
    throw new Error(
      `INVALID_FIELDS: ${validate.errors?.[0]?.instancePath || "/"}; contrato v1 requerido.`,
    );
  const ids = new Set();
  const occurrences = new Set();
  for (const { event } of value.records) {
    for (const field of ["occurred_at", "captured_at"]) {
      if (
        !Number.isFinite(Date.parse(event[field])) ||
        new Date(event[field]).toISOString() !== event[field]
      ) {
        throw new Error(`INVALID_FIELDS: ${field} inválido.`);
      }
    }
    if (operationalDate(event.occurred_at) !== event.business_date)
      throw new Error(
        "INVALID_FIELDS: fecha del hecho distinta del día colombiano.",
      );
    if (ids.has(event.event_id) || occurrences.has(occurrenceKey(event)))
      throw new Error(
        "OCCURRENCE_CONFLICT: paquete con identidades u ocurrencias repetidas.",
      );
    ids.add(event.event_id);
    occurrences.add(occurrenceKey(event));
  }
  return value;
}

// Equality independent of JSON object key order. Arrays retain order.
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

export function createRecord(input, installationId, now = new Date()) {
  const record = {
    event: {
      event_id: crypto.randomUUID(),
      schema_version: 1,
      event_type: "collection.recorded",
      environment: "synthetic",
      company_id: input.company_id,
      lot_id: input.lot_id,
      shed_id: input.shed_id,
      business_date: input.business_date,
      time_zone: "America/Bogota",
      occurred_at: new Date(
        `${input.business_date}T${input.time}:00-05:00`,
      ).toISOString(),
      captured_at: now.toISOString(),
      occurrence: Number(input.occurrence),
      quantity_eggs: Number(input.quantity_eggs),
      actor: { declared_id: input.actor_id, assurance: "declared-unverified" },
      device: {
        installation_id: installationId,
        assurance: "local-installation-unverified",
      },
      capture_status: "provisional",
    },
    delivery: { status: "pending" },
  };
  assertPackage(pack([record]));
  return record;
}
