const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class OfflineCaptureEnvelopeError extends Error {
  constructor(code) {
    super(code);
    this.name = "OfflineCaptureEnvelopeError";
    this.code = code;
  }
}

/**
 * Check cross-field invariants after the bundle has passed its JSON Schema.
 * This does not prove grant issuance or authorize an event; only the server can
 * resolve the grant and re-check membership, revocation, expiry, and scope.
 */
export function assertOfflineCaptureBindings(bundle) {
  if (
    bundle?.format !== "tamago.offline-collection-bundle" ||
    bundle.schema_version !== 1 ||
    !Array.isArray(bundle.records)
  )
    throw new OfflineCaptureEnvelopeError("OFFLINE_BUNDLE_INVALID");

  const eventIds = new Set();
  const occurrenceKeys = new Set();
  for (const record of bundle.records) {
    const {
      event,
      identity_binding: binding,
      device_proof: proof,
    } = record ?? {};
    if (
      !event ||
      !binding ||
      proof?.format !== "tamago.offline-device-event-proof" ||
      proof.schema_version !== 1 ||
      typeof proof.jws !== "string" ||
      proof.jws.length < 1 ||
      proof.jws.length > 8192 ||
      typeof event.event_id !== "string" ||
      !UUID.test(event.event_id) ||
      typeof binding.grant_id !== "string" ||
      !UUID.test(binding.grant_id) ||
      typeof binding.subject_user_id !== "string" ||
      !UUID.test(binding.subject_user_id) ||
      event.actor_declared_id !== binding.subject_user_id
    )
      throw new OfflineCaptureEnvelopeError(
        "OFFLINE_IDENTITY_BINDING_MISMATCH",
      );

    const occurrenceKey = JSON.stringify([
      event.company_id,
      event.lot_id,
      event.house_id,
      event.business_date,
      event.occurrence,
    ]);
    if (eventIds.has(event.event_id) || occurrenceKeys.has(occurrenceKey))
      throw new OfflineCaptureEnvelopeError("OFFLINE_EVENT_DUPLICATE");
    eventIds.add(event.event_id);
    occurrenceKeys.add(occurrenceKey);
  }
  return bundle;
}
