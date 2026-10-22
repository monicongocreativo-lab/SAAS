import assert from "node:assert/strict";
import test from "node:test";
import {
  assertPackage,
  canonical,
  createRecord,
  operationalDate,
  pack,
} from "../src/offline/contract.mjs";

const device = "11111111-1111-4111-8111-111111111111";
const input = {
  company_id: "SYN-TAMAGO",
  lot_id: "SYN-L1",
  shed_id: "SYN-G1",
  actor_id: "SYN-A1",
  business_date: "2026-10-21",
  time: "23:30",
  occurrence: "1",
  quantity_eggs: "9500",
};
export const sample = () =>
  createRecord(input, device, new Date("2026-10-22T04:31:00.000Z"));

test("canonical contract: stable identity, exact quantity, Colombian date, declared identities and pending only", () => {
  const value = pack([sample()]);
  assert.equal(value.records[0].event.occurred_at, "2026-10-22T04:30:00.000Z");
  assert.equal(operationalDate("2026-10-22T04:59:59Z"), "2026-10-21");
  assert.equal(operationalDate("2026-10-22T05:00:00Z"), "2026-10-22");
  assert.equal(value.records[0].event.quantity_eggs, 9500);
  assert.deepEqual(assertPackage(JSON.parse(JSON.stringify(value))), value);
  assert.equal(value.records[0].delivery.status, "pending");
});
test("absence, explicit zero and 1–3 actual occurrences", () => {
  assert.equal(assertPackage(pack([])).records.length, 0);
  for (const occurrence of [1, 2, 3]) {
    const r = createRecord({ ...input, occurrence, quantity_eggs: 0 }, device);
    assert.equal(assertPackage(pack([r])).records[0].event.quantity_eggs, 0);
  }
});
test("reject missing/null/fraction/negative/unsafe quantities, real IDs, unknown versions and fake acknowledgements", () => {
  const changes = [
    (r) => {
      delete r.event.quantity_eggs;
    },
    (r) => {
      r.event.quantity_eggs = null;
    },
    (r) => {
      r.event.quantity_eggs = 1.2;
    },
    (r) => {
      r.event.quantity_eggs = -1;
    },
    (r) => {
      r.event.quantity_eggs = Number.MAX_SAFE_INTEGER + 1;
    },
    (r) => {
      r.event.company_id = "TAMAGO";
    },
    (r) => {
      r.event.schema_version = 2;
    },
    (r) => {
      r.event.occurrence = 4;
    },
    (r) => {
      r.delivery.status = "accepted";
    },
    (r) => {
      r.event.actor.assurance = "authenticated";
    },
    (r) => {
      r.event.server_received_at = "2026-10-22T05:00:00.000Z";
    },
    (r) => {
      r.event.occurred_at = "2026-10-23T04:30:00.000Z";
    },
    (r) => {
      r.event.occurred_at = "2026-02-30T04:30:00.000Z";
    },
  ];
  for (const change of changes) {
    const r = sample();
    change(r);
    assert.throws(() => assertPackage(pack([r])));
  }
});
test("duplicate IDs or occurrences inside an export are rejected; object key order is immaterial", () => {
  const first = sample();
  assert.throws(
    () => assertPackage(pack([first, structuredClone(first)])),
    /CONFLICT/,
  );
  assert.throws(() => assertPackage(pack([first, sample()])), /CONFLICT/);
  assert.equal(
    canonical({ x: 1, z: { a: 2, b: 3 } }),
    canonical({ z: { b: 3, a: 2 }, x: 1 }),
  );
});
