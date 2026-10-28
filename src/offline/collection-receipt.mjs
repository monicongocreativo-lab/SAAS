import { canonical } from "./contract.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REASONS = [
  "proof_scope_mismatch",
  "proof_invalid",
  "grant_missing",
  "grant_revoked",
  "grant_expired",
  "grant_not_yet_valid",
  "authorization_no_longer_current",
  "receiver_capture_forbidden",
  "collection_occurrence_conflict",
  "collection_event_conflict",
];
export async function collectionRecordDigest(record) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(record)),
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

// An authenticated transport receipt, not a signed offline certificate or an
// operational approval. The caller must obtain it from the configured gateway.
export async function assertCollectionReceipt(receipt, record, synchronizer) {
  const quarantine = receipt?.review_status === "review_required";
  const required = [
    "format",
    "schema_version",
    "event_id",
    "company_id",
    "record_digest",
    "receipt_status",
    "review_status",
    "received_at",
    "duplicate",
    "identity_status",
    "registry_status",
    "synchronization_user_id",
    "capture_subject_id",
    "grant_id",
  ];
  const keys = quarantine
    ? [...required, "proof_status", "quarantine_reason"]
    : required;
  if (
    !receipt ||
    Object.keys(receipt).sort().join() !== keys.sort().join() ||
    receipt.format !== "tamago.offline-collection-receipt" ||
    receipt.schema_version !== 1 ||
    receipt.event_id !== record.event.event_id ||
    receipt.company_id !== record.event.company_id ||
    receipt.grant_id !== record.identity_binding.grant_id ||
    receipt.capture_subject_id !== record.identity_binding.subject_user_id ||
    !UUID.test(receipt.synchronization_user_id) ||
    (synchronizer && receipt.synchronization_user_id !== synchronizer) ||
    receipt.receipt_status !== "received" ||
    typeof receipt.duplicate !== "boolean" ||
    typeof receipt.received_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      receipt.received_at,
    ) ||
    !Number.isFinite(Date.parse(receipt.received_at)) ||
    ![
      "registry_current_unverified",
      "not_found",
      "scope_mismatch",
      "revoked",
      "expired",
      "not_yet_valid",
      "authorization_no_longer_current",
    ].includes(receipt.registry_status) ||
    (quarantine
      ? !REASONS.includes(receipt.quarantine_reason) ||
        !["verified", "invalid", "unresolved"].includes(receipt.proof_status) ||
        receipt.identity_status !== receipt.proof_status
      : receipt.review_status !== "pending" ||
        receipt.identity_status !== "verified" ||
        receipt.registry_status !== "registry_current_unverified") ||
    receipt.record_digest !== (await collectionRecordDigest(record))
  )
    throw new Error("COLLECTION_RECEIPT_INVALID");
  return structuredClone(receipt);
}

export async function bindCollectionReceipt(raw, record, synchronizer, extras) {
  const receipt = {
    ...raw,
    ...extras,
    format: "tamago.offline-collection-receipt",
    schema_version: 1,
    company_id: record.event.company_id,
    record_digest: await collectionRecordDigest(record),
    capture_subject_id: record.identity_binding.subject_user_id,
    grant_id: record.identity_binding.grant_id,
    synchronization_user_id: synchronizer,
  };
  // Do not turn a mismatched RPC result into an acknowledgement of this event.
  if (
    raw.event_id !== record.event.event_id ||
    (raw.grant_id && raw.grant_id !== record.identity_binding.grant_id) ||
    (raw.capture_subject_id &&
      raw.capture_subject_id !== record.identity_binding.subject_user_id)
  )
    throw new Error("COLLECTION_RECEIPT_INVALID");
  return assertCollectionReceipt(receipt, record, synchronizer);
}
