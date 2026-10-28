import { openDB } from "idb";
import { validateCollectionEventV2 } from "../auth-prototype/collection-contract.mjs";
import { assertOfflineCaptureBindings } from "./capture-envelope.mjs";
import { assertCollectionReceipt } from "./collection-receipt.mjs";
import { canonical } from "./contract.mjs";
import { verifyOfflineDeviceEventProof } from "./device-event-proof.mjs";

function bundle(records) {
  return {
    format: "tamago.offline-collection-bundle",
    schema_version: 1,
    records,
  };
}
function metadata(event) {
  return {
    event_id: event.event_id,
    company_id: event.company_id,
    site_id: event.site_id,
    house_id: event.house_id,
    lot_id: event.lot_id,
    business_date: event.business_date,
    occurrence: event.occurrence,
  };
}
function validate(record) {
  if (
    Object.keys(record ?? {})
      .sort()
      .join() !== "delivery,device_proof,event,identity_binding" ||
    record.delivery?.status !== "pending" ||
    Object.keys(record.delivery).length !== 1 ||
    !validateCollectionEventV2(record.event, record.event?.company_id)
  )
    throw new Error("PROTECTED_QUEUE_INVALID_RECORD");
  assertOfflineCaptureBindings(bundle([record]));
}
function matches(event, scope) {
  return (
    ["company_id", "site_id", "house_id", "lot_id", "device_id"].every(
      (field) => event[field] === scope[field],
    ) && event.actor_declared_id === scope.subject_user_id
  );
}

export async function openProtectedCollectionQueue() {
  const db = await openDB("tamago-protected-collections-lab-v1", 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 2)
        database.createObjectStore("receipts", { keyPath: "event_id" });
      if (oldVersion >= 1) return;
      const events = database.createObjectStore("events", {
        keyPath: "event_id",
      });
      events.createIndex(
        "occurrence",
        ["company_id", "lot_id", "house_id", "business_date", "occurrence"],
        { unique: true },
      );
      events.createIndex("actor_scope", [
        "subject_user_id",
        "device_id",
        "company_id",
        "site_id",
        "house_id",
        "lot_id",
      ]);
      database.createObjectStore("outbox", { keyPath: "event_id" });
    },
  });

  async function read(row, scope, session) {
    if (
      !row ||
      row.subject_user_id !== scope.subject_user_id ||
      row.device_id !== scope.device_id
    )
      throw new Error("PROTECTED_QUEUE_CONTEXT_MISMATCH");
    const record = await session.openLocalPayload(row.sealed);
    validate(record);
    if (
      !matches(record.event, scope) ||
      canonical(metadata(record.event)) !== canonical(row.sealed.metadata) ||
      row.event_id !== record.event.event_id ||
      [
        "company_id",
        "site_id",
        "house_id",
        "lot_id",
        "business_date",
        "occurrence",
      ].some((field) => row[field] !== record.event[field])
    )
      throw new Error("PROTECTED_QUEUE_INVALID_RECORD");
    const pending = await db.get("outbox", row.event_id);
    if (!["pending", "received", "review_required"].includes(pending?.status))
      throw new Error("PROTECTED_QUEUE_INCOMPLETE");
    return record;
  }

  async function deliveries(scope, session) {
    const source = await db.getAllFromIndex("events", "actor_scope", [
      scope.subject_user_id,
      scope.device_id,
      scope.company_id,
      scope.site_id,
      scope.house_id,
      scope.lot_id,
    ]);
    return Promise.all(
      source.map(async (row) => {
        const record = await read(row, scope, session);
        const ack = await db.get("receipts", row.event_id);
        const pending = await db.get("outbox", row.event_id);
        if (!ack) {
          if (pending.status !== "pending")
            throw new Error("PROTECTED_QUEUE_INCOMPLETE");
          return { record, status: "pending", receipt: null };
        }
        const receipt = await session.openLocalPayload(ack.sealed);
        await assertCollectionReceipt(receipt, record);
        const status =
          receipt.review_status === "review_required"
            ? "review_required"
            : "received";
        if (pending.status !== status)
          throw new Error("PROTECTED_QUEUE_INCOMPLETE");
        return { record, status, receipt };
      }),
    );
  }

  return Object.freeze({
    deliveries,
    async acknowledge(record, receipt, scope, session, synchronizer) {
      receipt = await assertCollectionReceipt(receipt, record, synchronizer);
      const row = await db.get("events", record.event.event_id);
      const original = await read(row, scope, session);
      if (canonical(original) !== canonical(record))
        throw new Error("PROTECTED_QUEUE_EVENT_CONFLICT");
      const sealed = await session.sealLocalPayload(
        receipt,
        metadata(record.event),
      );
      const tx = db.transaction(["receipts", "outbox"], "readwrite");
      try {
        // First valid durable receipt wins; concurrent/repeated sends never
        // replace its evidence or remove the source event.
        if (!(await tx.objectStore("receipts").get(record.event.event_id))) {
          await tx
            .objectStore("receipts")
            .add({ event_id: record.event.event_id, sealed });
          await tx.objectStore("outbox").put({
            event_id: record.event.event_id,
            status:
              receipt.review_status === "review_required"
                ? "review_required"
                : "received",
          });
        }
        await tx.done;
      } catch {
        try {
          tx.abort();
        } catch {
          /* Already completed. */
        }
        await tx.done.catch(() => {});
        throw new Error("COLLECTION_RECEIPT_NOT_SAVED");
      }
    },
    close() {
      db.close();
    },
    async save(record, grant, session) {
      record = structuredClone(record);
      validate(record);
      if (!matches(record.event, grant))
        throw new Error("PROTECTED_QUEUE_CONTEXT_MISMATCH");
      await verifyOfflineDeviceEventProof(
        record.device_proof,
        record.event,
        grant,
      );
      const sealed = await session.sealLocalPayload(
        record,
        metadata(record.event),
      );
      const row = {
        ...metadata(record.event),
        subject_user_id: record.event.actor_declared_id,
        device_id: record.event.device_id,
        sealed,
      };
      for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await db.get("events", row.event_id);
        if (existing) {
          const previous = await read(existing, grant, session);
          if (canonical(previous.event) !== canonical(record.event))
            throw new Error("PROTECTED_QUEUE_EVENT_CONFLICT");
          return previous;
        }
        const tx = db.transaction(["events", "outbox"], "readwrite");
        try {
          if (await tx.objectStore("events").get(row.event_id)) {
            tx.abort();
            await tx.done.catch(() => {});
            continue;
          }
          await tx.objectStore("events").add(row);
          await tx
            .objectStore("outbox")
            .add({ event_id: row.event_id, status: "pending" });
          await tx.done;
          return record;
        } catch (error) {
          try {
            tx.abort();
          } catch {
            /* Already aborted by IndexedDB. */
          }
          await tx.done.catch(() => {});
          throw new Error(
            error.name === "ConstraintError"
              ? "PROTECTED_QUEUE_OCCURRENCE_CONFLICT"
              : "PROTECTED_QUEUE_NOT_SAVED",
          );
        }
      }
      throw new Error("PROTECTED_QUEUE_RETRY");
    },
    async export(scope, session) {
      const rows = await db.getAllFromIndex("events", "actor_scope", [
        scope.subject_user_id,
        scope.device_id,
        scope.company_id,
        scope.site_id,
        scope.house_id,
        scope.lot_id,
      ]);
      const records = await Promise.all(
        rows.map((row) => read(row, scope, session)),
      );
      records.sort(
        (a, b) =>
          a.event.business_date.localeCompare(b.event.business_date) ||
          a.event.occurrence - b.event.occurrence ||
          a.event.event_id.localeCompare(b.event.event_id),
      );
      return assertOfflineCaptureBindings(bundle(records));
    },
  });
}
