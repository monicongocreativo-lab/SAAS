import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { validateCollectionEventV2 } from "../src/auth-prototype/collection-contract.mjs";

const companyId = "a0000000-0000-4000-8000-000000000001";
const event = {
  schema_version: 2,
  event_id: "10000000-0000-4000-8000-000000000001",
  company_id: companyId,
  site_id: "a3000000-0000-4000-8000-000000000001",
  house_id: "a4000000-0000-4000-8000-000000000001",
  lot_id: "a5000000-0000-4000-8000-000000000001",
  business_date: "2026-10-23",
  occurrence: 1,
  quantity_eggs: 300,
  occurred_at: "2026-10-23T12:00:00.000Z",
  captured_at: "2026-10-23T12:01:00.000Z",
  actor_declared_id: "galponero-dispositivo-sintetico",
  device_id: "20000000-0000-4000-8000-000000000002",
};

test("collection v2 contract matches its checked-in schema and accepts valid capture", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL("../contracts/collection-event.v2.schema.json", import.meta.url),
    ),
  );
  assert.deepEqual(Object.keys(event).sort(), [...schema.required].sort());
  assert.equal(validateCollectionEventV2(event, companyId), true);
});

test("collection v2 rejects client claims that can change tenant, identity, or event meaning", () => {
  for (const invalid of [
    { ...event, company_id: "b0000000-0000-4000-8000-000000000002" },
    { ...event, quantity_eggs: -1 },
    { ...event, occurrence: 4 },
    { ...event, actor_user_id: "a1111111-1111-4111-8111-111111111111" },
    { ...event, business_date: "2026-10-22" },
    { ...event, occurred_at: "2026-02-30T12:00:00.000Z" },
    { ...event, event_id: "not-a-uuid" },
  ])
    assert.equal(validateCollectionEventV2(invalid, companyId), false);
  assert.equal(
    validateCollectionEventV2(event, "b0000000-0000-4000-8000-000000000002"),
    false,
  );
});
