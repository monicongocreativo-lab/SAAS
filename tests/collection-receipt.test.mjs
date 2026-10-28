import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  assertCollectionReceipt,
  bindCollectionReceipt,
} from "../src/offline/collection-receipt.mjs";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const record = {
  event: { event_id: id, company_id: id, quantity_eggs: 413 },
  identity_binding: { grant_id: id, subject_user_id: id },
  device_proof: { jws: "test-only" },
  delivery: { status: "pending" },
};
const raw = {
  event_id: id,
  receipt_status: "received",
  review_status: "pending",
  received_at: "2026-10-27T10:00:00+00:00",
  duplicate: false,
};
const extras = {
  identity_status: "verified",
  registry_status: "registry_current_unverified",
};
test("receipt schema and runtime bind the complete original record, company, grant, worker and synchronizer", async () => {
  const receipt = await bindCollectionReceipt(raw, record, id, extras);
  const ajv = new Ajv2020({ validateFormats: false });
  const valid = ajv.compile(
    JSON.parse(
      await readFile(
        new URL(
          "../contracts/offline-collection-receipt.v1.schema.json",
          import.meta.url,
        ),
      ),
    ),
  );
  assert.equal(valid(receipt), true, JSON.stringify(valid.errors));
  assert.deepEqual(await assertCollectionReceipt(receipt, record, id), receipt);
  for (const patch of [
    { event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { company_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { record_digest: "0".repeat(64) },
    { grant_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { capture_subject_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { synchronization_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    { review_status: "approved" },
    { received_at: "not-a-date" },
    { received_at: "2026-10-27T10:00:00" },
    { duplicate: "true" },
    { extra: true },
  ])
    await assert.rejects(
      assertCollectionReceipt({ ...receipt, ...patch }, record, id),
      /COLLECTION_RECEIPT_INVALID/,
    );
  for (const changed of [
    { ...record, event: { ...record.event, quantity_eggs: 414 } },
    { ...record, device_proof: { jws: "changed" } },
  ])
    await assert.rejects(
      assertCollectionReceipt(receipt, changed, id),
      /COLLECTION_RECEIPT_INVALID/,
    );
  await assert.rejects(
    bindCollectionReceipt(
      { ...raw, event_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      record,
      id,
      extras,
    ),
    /COLLECTION_RECEIPT_INVALID/,
  );
  const quarantine = await bindCollectionReceipt(
    {
      ...raw,
      review_status: "review_required",
      proof_status: "verified",
      quarantine_reason: "grant_revoked",
      registry_status: "revoked",
    },
    record,
    id,
    { identity_status: "verified" },
  );
  assert.equal(valid(quarantine), true);
  assert.equal(quarantine.review_status, "review_required");
  await assert.rejects(
    assertCollectionReceipt(
      { ...quarantine, proof_status: "invalid" },
      record,
      id,
    ),
    /COLLECTION_RECEIPT_INVALID/,
  );
});
