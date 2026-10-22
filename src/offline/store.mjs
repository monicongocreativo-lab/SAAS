import { openDB } from "idb";
import { assertPackage, canonical, occurrenceKey, pack } from "./contract.mjs";

export const DB_NAME = "tamago:dev002:synthetic";
export const DB_VERSION = 2;

export function openStore(onUnavailable = () => {}) {
  let connection;
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const events = db.createObjectStore("events", { keyPath: "event_id" });
        events.createIndex(
          "occurrence",
          ["company_id", "lot_id", "shed_id", "business_date", "occurrence"],
          { unique: true },
        );
        db.createObjectStore("outbox", { keyPath: "event_id" });
      }
      if (oldVersion < 2) db.createObjectStore("meta");
    },
    blocked() {
      onUnavailable(
        "Otra pestaña impide actualizar. Ciérrala y vuelve a abrir; no borres datos.",
      );
    },
    blocking() {
      connection?.close();
      onUnavailable(
        "Hay una actualización del almacenamiento. Recarga antes de registrar.",
      );
    },
    terminated() {
      onUnavailable(
        "Se interrumpió el almacenamiento. Reabre y verifica pendientes antes de reintentar.",
      );
    },
  }).then((db) => {
    connection = db;
    return db;
  });
}

export async function installationId(db) {
  const tx = db.transaction("meta", "readwrite");
  let id = await tx.store.get("installation_id");
  if (!id) {
    id = crypto.randomUUID();
    await tx.store.put(id, "installation_id");
  }
  await tx.done;
  return id;
}

export async function readPackage(db) {
  const tx = db.transaction(["events", "outbox"], "readonly");
  const [events, queue] = await Promise.all([
    tx.objectStore("events").getAll(),
    tx.objectStore("outbox").getAll(),
  ]);
  await tx.done;
  if (events.length !== queue.length)
    throw new Error(
      "STORAGE_INTEGRITY: evento y cola no coinciden. Conserva el almacenamiento para revisión.",
    );
  const byId = new Map(queue.map((item) => [item.event_id, item]));
  const records = events.map((event) => {
    const item = byId.get(event.event_id);
    if (item?.status !== "pending")
      throw new Error("STORAGE_INTEGRITY: falta cola pendiente.");
    return { event, delivery: { status: item.status } };
  });
  records.sort((a, b) => a.event.event_id.localeCompare(b.event.event_id));
  return assertPackage(pack(records));
}

// Only IndexedDB requests may be awaited inside this transaction (no fetch/timers).
export async function savePackage(db, value) {
  assertPackage(value);
  const tx = db.transaction(["events", "outbox"], "readwrite", {
    durability: "strict",
  });
  const done = tx.done;
  // Attach immediately: an abort can occur before a request promise rejects.
  done.catch(() => {});
  let added = 0;
  try {
    const events = tx.objectStore("events");
    const outbox = tx.objectStore("outbox");
    for (const record of value.records) {
      const event = record.event;
      const previous = await events.get(event.event_id);
      if (previous) {
        const queue = await outbox.get(event.event_id);
        if (canonical(previous) !== canonical(event))
          throw new Error(
            "EVENT_ID_CONFLICT: mismo ID con contenido distinto; no se reemplazó.",
          );
        if (queue?.status !== "pending")
          throw new Error("STORAGE_INTEGRITY: cola inconsistente.");
        continue;
      }
      const key = JSON.parse(occurrenceKey(event));
      if (await events.index("occurrence").getKey(key))
        throw new Error(
          "OCCURRENCE_CONFLICT: ya existe esa recogida. Revisa el registro antes de corregir.",
        );
      await events.add(event);
      await outbox.add({
        event_id: event.event_id,
        status: record.delivery.status,
      });
      added++;
    }
    await done;
    return added;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Transaction may already be aborted. */
    }
    await done.catch(() => {});
    throw error;
  }
}
