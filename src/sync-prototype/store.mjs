import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { canonical, occurrenceKey } from "../offline/contract.mjs";

export function openSyncStore(path) {
  const database = new DatabaseSync(path, { timeout: 1000 });
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE IF NOT EXISTS collection_event (
      event_id TEXT PRIMARY KEY,
      company_id TEXT NOT NULL,
      lot_id TEXT NOT NULL,
      shed_id TEXT NOT NULL,
      business_date TEXT NOT NULL,
      occurrence INTEGER NOT NULL,
      canonical_event TEXT NOT NULL,
      content_sha256 TEXT NOT NULL,
      receipt_id TEXT NOT NULL UNIQUE,
      server_received_at TEXT NOT NULL,
      result_revision INTEGER NOT NULL,
      UNIQUE (company_id, lot_id, shed_id, business_date, occurrence)
    ) STRICT;
  `);

  const byId = database.prepare(
    "SELECT * FROM collection_event WHERE event_id = ?",
  );
  const byOccurrence = database.prepare(`
    SELECT event_id FROM collection_event
    WHERE company_id = ? AND lot_id = ? AND shed_id = ?
      AND business_date = ? AND occurrence = ?
  `);
  const insert = database.prepare(`
    INSERT INTO collection_event (
      event_id, company_id, lot_id, shed_id, business_date, occurrence,
      canonical_event, content_sha256, receipt_id, server_received_at, result_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  return {
    receive(event, principal, now = new Date()) {
      if (event.company_id !== principal.company_id)
        return { status: "rejected", code: "OUT_OF_SCOPE" };

      const serialized = canonical(event);
      const digest = createHash("sha256").update(serialized).digest("hex");
      const key = JSON.parse(occurrenceKey(event));
      database.exec("BEGIN IMMEDIATE");
      try {
        const existing = byId.get(event.event_id);
        if (existing) {
          database.exec("ROLLBACK");
          if (existing.canonical_event !== serialized)
            return { status: "rejected", code: "EVENT_ID_CONFLICT" };
          return receipt(existing);
        }

        if (byOccurrence.get(...key)) {
          database.exec("ROLLBACK");
          return { status: "rejected", code: "OCCURRENCE_CONFLICT" };
        }

        const stored = {
          event_id: event.event_id,
          company_id: event.company_id,
          lot_id: event.lot_id,
          shed_id: event.shed_id,
          business_date: event.business_date,
          occurrence: event.occurrence,
          canonical_event: serialized,
          content_sha256: digest,
          receipt_id: randomUUID(),
          server_received_at: now.toISOString(),
          result_revision: 1,
        };
        insert.run(
          stored.event_id,
          stored.company_id,
          stored.lot_id,
          stored.shed_id,
          stored.business_date,
          stored.occurrence,
          stored.canonical_event,
          stored.content_sha256,
          stored.receipt_id,
          stored.server_received_at,
          stored.result_revision,
        );
        database.exec("COMMIT");
        return receipt(stored);
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // The transaction may already have rolled back.
        }
        throw error;
      }
    },
    get(eventId) {
      const row = byId.get(eventId);
      return row ? receipt(row) : undefined;
    },
    count() {
      return database
        .prepare("SELECT count(*) AS count FROM collection_event")
        .get().count;
    },
    close() {
      database.close();
    },
  };
}

function receipt(row) {
  return {
    status: "received",
    receipt: {
      event_id: row.event_id,
      company_id: row.company_id,
      receipt_id: row.receipt_id,
      server_received_at: row.server_received_at,
      content_sha256: row.content_sha256,
      result_revision: row.result_revision,
    },
  };
}
