import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  assertOfflineCaptureBindings,
  OfflineCaptureEnvelopeError,
} from "../src/offline/capture-envelope.mjs";

const schema = JSON.parse(
  readFileSync(
    new URL(
      "../contracts/offline-collection-bundle.v1.schema.json",
      import.meta.url,
    ),
  ),
);
const eventSchema = JSON.parse(
  readFileSync(
    new URL("../contracts/collection-event.v2.schema.json", import.meta.url),
  ),
);
const ajv = new Ajv2020({ allErrors: true });
ajv.addFormat("date", (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    return (
      new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value
    );
  } catch {
    return false;
  }
});
ajv.addFormat("date-time", (value) => {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
});
ajv.addSchema(eventSchema);
const validate = ajv.compile(schema);

const ids = {
  event: "10000000-0000-4000-8000-000000000001",
  grant: "10000000-0000-4000-8000-000000000002",
  user: "10000000-0000-4000-8000-000000000003",
  company: "a0000000-0000-4000-8000-000000000001",
  site: "a3000000-0000-4000-8000-000000000001",
  house: "a4000000-0000-4000-8000-000000000001",
  lot: "a5000000-0000-4000-8000-000000000001",
  device: "20000000-0000-4000-8000-000000000002",
};

function makeBundle(eventId = ids.event) {
  return {
    format: "tamago.offline-collection-bundle",
    schema_version: 1,
    records: [
      {
        event: {
          schema_version: 2,
          event_id: eventId,
          company_id: ids.company,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: ids.lot,
          business_date: "2026-10-25",
          occurrence: 1,
          quantity_eggs: 300,
          occurred_at: "2026-10-25T12:00:00.000Z",
          captured_at: "2026-10-25T12:01:00.000Z",
          actor_declared_id: ids.user,
          device_id: ids.device,
        },
        identity_binding: {
          grant_id: ids.grant,
          subject_user_id: ids.user,
          attribution_status: "pending_server_verification",
        },
        device_proof: {
          format: "tamago.offline-device-event-proof",
          schema_version: 1,
          jws: "synthetic-proof-not-cryptographically-verified-by-this-schema-test",
        },
        delivery: { status: "pending" },
      },
    ],
  };
}

test("offline bundle contract binds a v2 event to an explicit grant reference", () => {
  const bundle = makeBundle();
  const eventBeforeValidation = structuredClone(bundle.records[0].event);
  assert.equal(validate(bundle), true);
  assert.deepEqual(assertOfflineCaptureBindings(bundle), bundle);
  assert.deepEqual(bundle.records[0].event, eventBeforeValidation);
  assert.equal(bundle.records[0].delivery.status, "pending");
  assert.equal(
    bundle.records[0].identity_binding.attribution_status,
    "pending_server_verification",
  );
});

test("identity subject must equal event actor and repeated event/occurrence conflicts fail", () => {
  const mismatchedActor = makeBundle();
  mismatchedActor.records[0].identity_binding.subject_user_id = ids.site;
  assert.equal(validate(mismatchedActor), true);
  assert.throws(
    () => assertOfflineCaptureBindings(mismatchedActor),
    (error) =>
      error instanceof OfflineCaptureEnvelopeError &&
      error.code === "OFFLINE_IDENTITY_BINDING_MISMATCH",
  );

  const repeatedId = makeBundle();
  repeatedId.records.push(structuredClone(repeatedId.records[0]));
  assert.throws(() => assertOfflineCaptureBindings(repeatedId), /DUPLICATE/);

  const repeatedOccurrence = makeBundle();
  const second = structuredClone(repeatedOccurrence.records[0]);
  second.event.event_id = "10000000-0000-4000-8000-000000000004";
  repeatedOccurrence.records.push(second);
  assert.throws(
    () => assertOfflineCaptureBindings(repeatedOccurrence),
    /DUPLICATE/,
  );
});

test("bundle cannot claim server identity, receipt, acceptance, or carry a grant token", () => {
  for (const mutate of [
    (record) => {
      record.event.captured_by = ids.user;
    },
    (record) => {
      record.delivery.receipt = { receipt_id: ids.event };
    },
    (record) => {
      record.delivery.status = "accepted";
    },
    (record) => {
      record.identity_binding.grant_token = "bearer-secret-must-not-export";
    },
  ]) {
    const bundle = makeBundle();
    mutate(bundle.records[0]);
    assert.equal(validate(bundle), false);
  }
});
