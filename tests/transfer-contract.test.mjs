import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  validateTransferDispatch,
  validOriginDate,
} from "../src/auth-prototype/transfer-contract.mjs";

const schema = JSON.parse(
  readFileSync(
    new URL(
      "../contracts/collection-transfer-dispatch.v1.schema.json",
      import.meta.url,
    ),
  ),
);
const validate = new Ajv2020({ strict: true }).compile(schema);
const company = "11111111-1111-4111-8111-111111111111";
const valid = () => ({
  schema_version: 1,
  transfer_id: "22222222-2222-4222-8222-222222222222",
  company_id: company,
  site_id: "33333333-3333-4333-8333-333333333333",
  house_id: "44444444-4444-4444-8444-444444444444",
  lot_id: "55555555-5555-4555-8555-555555555555",
  origin_business_date: "2026-10-25",
  quantity_sent: 40,
  sent_from: "Galpón ficticio",
  sent_to: "Bodega ficticia",
  sent_at: "2026-10-27T12:00:00.000Z",
});
test("transfer contract separates collection origin date from dispatch instant and keeps stable identity", () => {
  const body = valid();
  assert.equal(validate(body), true, JSON.stringify(validate.errors));
  assert.equal(validateTransferDispatch(body, company), true);
  assert.equal(
    validateTransferDispatch(JSON.parse(JSON.stringify(body)), company),
    true,
  );
  assert.equal(body.origin_business_date, "2026-10-25");
});
test("transfer contract rejects invented authority, other company, nonwhole quantities and unsupported versions", () => {
  for (const patch of [
    { schema_version: 2 },
    { sent_by: company },
    { quantity_sent: 0 },
    { quantity_sent: -1 },
    { quantity_sent: 1.2 },
    { quantity_sent: "40" },
    { quantity_sent: null },
    { quantity_sent: 2147483648 },
    { sent_to: "  " },
    { lot_id: "not-a-lot" },
  ]) {
    const body = { ...valid(), ...patch };
    assert.equal(validate(body), false);
    assert.equal(validateTransferDispatch(body, company), false);
  }
  assert.equal(
    validateTransferDispatch(
      { ...valid(), company_id: valid().lot_id },
      company,
    ),
    false,
  );
});
test("semantic validator rejects nonexistent origin dates and noncanonical timestamp rollover", () => {
  for (const date of [
    "2026-02-29",
    "2026-02-31",
    "0000-01-01",
    "2026-13-01",
    "27-10-2026",
  ])
    assert.equal(validOriginDate(date), false);
  assert.equal(validOriginDate("2024-02-29"), true);
  assert.equal(
    validateTransferDispatch(
      { ...valid(), sent_at: "2026-02-31T12:00:00.000Z" },
      company,
    ),
    false,
  );
});
