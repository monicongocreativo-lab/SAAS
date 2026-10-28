import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { manualClassificationApi } from "../src/auth-prototype/manual-classification-api.mjs";
import {
  manualClassificationCatalog,
  validateManualClassification,
} from "../src/auth-prototype/manual-classification-contract.mjs";

const company = randomUUID();
const record = () => ({
  schema_version: 1,
  session_id: randomUUID(),
  company_id: company,
  site_id: randomUUID(),
  house_id: randomUUID(),
  lot_id: randomUUID(),
  origin_business_date: "2026-10-27",
  classified_at: "2026-10-28T04:59:59.000Z",
  machine_configuration_reference: null,
  notes: null,
  inputs: [{ transfer_id: randomUUID(), quantity_eggs: 30 }],
  lines: [
    {
      line_id: randomUUID(),
      quantity_eggs: 20,
      typology: "AA",
      condition: "NORMAL",
      destination: "PENDING",
    },
    {
      line_id: randomUUID(),
      quantity_eggs: 10,
      typology: "PIPO",
      condition: "DIRTY",
      destination: "DISCARD",
    },
  ],
});
const schema = JSON.parse(
  readFileSync(
    new URL(
      "../contracts/manual-classification.v1.schema.json",
      import.meta.url,
    ),
  ),
);
const ajv = new Ajv2020({ strict: true });
const schemaValid = ajv.compile(schema);
const receiptValid = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/manual-classification-receipt.v1.schema.json",
        import.meta.url,
      ),
    ),
  ),
);
test("manual classification contract accepts balanced factual counts, not a weight approval", () => {
  const value = record();
  assert.equal(validateManualClassification(value, company), true);
  assert.equal(schemaValid(value), true, JSON.stringify(schemaValid.errors));
  assert.equal(
    manualClassificationCatalog.automatic_weight_classification,
    false,
  );
  for (const [name, key] of [
    ["typologies", "typology"],
    ["conditions", "condition"],
    ["destinations", "destination"],
  ])
    assert.deepEqual(
      manualClassificationCatalog[name].map((x) => x.code),
      schema.properties.lines.items.properties[key].enum,
    );
  value.machine_configuration_reference = "Configuración declarada";
  assert.equal(validateManualClassification(value, company), true);
});
test("manual classification rejects malformed, duplicate and unbalanced inputs", () => {
  const changes = [
    (x) => x.inputs[0].quantity_eggs++,
    (x) => (x.inputs[0].quantity_eggs = 0),
    (x) => (x.lines[0].quantity_eggs = 1.5),
    (x) => (x.lines[0].quantity_eggs = -1),
    (x) => x.inputs.push({ ...x.inputs[0] }),
    (x) => x.lines.push({ ...x.lines[0] }),
    (x) => (x.lines[0].condition = ["DIRTY", "BROKEN"]),
    (x) => (x.lines[1].destination = "PENDING"),
    (x) => (x.lines[0].typology = "ZZ"),
    (x) => (x.recorded_by = randomUUID()),
    (x) => (x.review_status = "approved"),
    (x) => (x.schema_version = 2),
    (x) => (x.inputs = []),
    (x) => (x.lines = []),
    (x) => (x.company_id = randomUUID()),
    (x) => (x.classified_at = "2026-10-27T04:59:59.000Z"),
    (x) => (x.classified_at = "2026-02-30T12:00:00.000Z"),
    (x) => (x.origin_business_date = "2026-02-30"),
    (x) => (x.classified_at = "2026-10-28T24:00:00.000Z"),
    (x) => (x.machine_configuration_reference = " "),
    (x) => (x.notes = "a".repeat(2001)),
    (x) => (x.inputs[0].quantity_eggs = 2147483648),
  ];
  for (const change of changes) {
    const value = record();
    change(value);
    assert.equal(
      validateManualClassification(value, company),
      false,
      String(change),
    );
  }
});
test("manual classification allows partial outputs with all accepted conditions and safe large totals", () => {
  for (const condition of ["NORMAL", "DIRTY", "BROKEN", "YOLK"]) {
    const value = record();
    value.lines[0].condition = condition;
    assert.equal(validateManualClassification(value, company), true);
  }
  const value = record();
  value.inputs = Array.from({ length: 50 }, () => ({
    transfer_id: randomUUID(),
    quantity_eggs: 2147483647,
  }));
  value.lines = value.inputs.map((x) => ({
    line_id: randomUUID(),
    quantity_eggs: x.quantity_eggs,
    typology: "UNKNOWN",
    condition: "NORMAL",
    destination: "PENDING",
  }));
  assert.equal(validateManualClassification(value, company), true);
});
test("manual classification API binds real actor and receipt, preserves pending status and retry", async () => {
  const body = record(),
    userId = randomUUID();
  const base = {
    url: new URL(
      `http://localhost/v1/companies/${company}/manual-classifications`,
    ),
    method: "POST",
    body,
    companyId: company,
    userId,
    accessToken: "fictitious-user-token",
    publishableKey: "fictitious-public",
    restBase: new URL("http://localhost/rest/v1/"),
  };
  const receipt = {
    format: "tamago.manual-classification-receipt",
    schema_version: 1,
    session_id: body.session_id,
    company_id: company,
    origin_business_date: body.origin_business_date,
    processed_quantity: 30,
    recorded_by: userId,
    recorded_at: "2026-10-28T12:00:00Z",
    review_status: "pending",
    configuration_status: "declared_unverified",
    duplicate: true,
  };
  assert.equal(
    receiptValid(receipt),
    true,
    JSON.stringify(receiptValid.errors),
  );
  const run = (patch) =>
    manualClassificationApi({
      ...base,
      fetchImpl: async (_url, options) => {
        assert.equal(
          options.headers.authorization,
          "Bearer fictitious-user-token",
        );
        assert.deepEqual(JSON.parse(options.body), { p_record: body });
        return new Response(JSON.stringify({ ...receipt, ...patch }));
      },
    });
  assert.equal((await run({})).body.duplicate, true);
  for (const patch of [
    { recorded_by: randomUUID() },
    { company_id: randomUUID() },
    { processed_quantity: 31 },
    { review_status: "approved" },
    { configuration_status: "approved" },
  ])
    assert.equal((await run(patch)).status, 503);
  assert.equal(
    (
      await manualClassificationApi({
        ...base,
        fetchImpl: async () => {
          throw new Error("lost response");
        },
      })
    ).status,
    503,
  );
  for (const [code, status] of [
    ["42501", 403],
    ["22023", 400],
    ["23514", 409],
    ["55000", 409],
    ["23505", 409],
  ])
    assert.equal(
      (
        await manualClassificationApi({
          ...base,
          fetchImpl: async () =>
            new Response(JSON.stringify({ code }), { status: 400 }),
        })
      ).status,
      status,
    );
});
