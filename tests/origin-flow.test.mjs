import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { custodyApi } from "../src/auth-prototype/custody-api.mjs";
import { validateOriginFlowSummary } from "../src/shared/origin-flow-contract.mjs";

const company = "11111111-1111-4111-8111-111111111111",
  date = "2026-10-27";
const sample = () => ({
  format: "tamago.origin-flow-summary",
  schema_version: 1,
  company_id: company,
  origin_business_date: date,
  as_of: "2026-10-28T12:00:00Z",
  purpose: "consultation_only",
  next_offset: null,
  items: [
    {
      company_id: company,
      site_id: "22222222-2222-4222-8222-222222222222",
      house_id: "33333333-3333-4333-8333-333333333333",
      lot_id: "44444444-4444-4444-8444-444444444444",
      lot_code: "SYN-LOTE",
      lot_status: "active",
      house_name: "Galpón ficticio",
      site_name: "Sede ficticia",
      origin_business_date: date,
      collection_count: 1,
      quantity_collected: 100,
      transfer_count: 3,
      receipt_count: 2,
      quantity_sent: 100,
      quantity_at_house: 0,
      quantity_in_transit: 10,
      quantity_received: 88,
      quantity_classified: 30,
      quantity_pending_classification: 58,
      custody_difference: 2,
      custody_shortage: 2,
      custody_surplus: 0,
      open_incidents: 2,
      quantity_destination_undefined: 25,
      quantity_discard_declared: 5,
    },
  ],
});
const schema = new Ajv2020({ strict: true }).compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/origin-flow-summary.v1.schema.json",
        import.meta.url,
      ),
    ),
  ),
);
test("origin flow contract preserves stage quantities without claiming reconciliation", () => {
  const result = sample();
  assert.equal(schema(result), true, JSON.stringify(schema.errors));
  assert.equal(
    validateOriginFlowSummary(result, { companyId: company, date }),
    true,
  );
  const row = result.items[0];
  assert.equal(
    row.quantity_at_house +
      row.quantity_in_transit +
      row.quantity_pending_classification +
      row.quantity_classified +
      row.custody_difference,
    100,
  );
  row.custody_shortage = 1;
  row.custody_surplus = 1;
  row.custody_difference = 0;
  assert.equal(
    validateOriginFlowSummary(result, { companyId: company, date }),
    true,
  );
  assert.equal(row.open_incidents, 2);
});
test("origin flow distinguishes missing collection from explicit zero and rejects context or derived-value corruption", () => {
  const missing = sample();
  Object.assign(missing.items[0], {
    collection_count: 0,
    quantity_collected: null,
    quantity_at_house: null,
  });
  assert.equal(
    validateOriginFlowSummary(missing, { companyId: company, date }),
    true,
  );
  const zero = sample();
  Object.assign(zero.items[0], {
    quantity_collected: 0,
    quantity_at_house: -100,
  });
  assert.equal(
    validateOriginFlowSummary(zero, { companyId: company, date }),
    true,
    "negative historical balance must remain visible, not clamped",
  );
  for (const mutate of [
    (x) => (x.company_id = x.items[0].site_id),
    (x) => (x.items[0].company_id = x.items[0].site_id),
    (x) => (x.items[0].quantity_pending_classification = 59),
    (x) => (x.items[0].quantity_at_house = 1),
    (x) => (x.items[0].quantity_collected = null),
    (x) => (x.items[0].custody_difference = 0),
    (x) => x.items.push(structuredClone(x.items[0])),
    (x) => (x.purpose = "approved"),
    (x) => (x.approved = true),
  ]) {
    const result = sample();
    mutate(result);
    assert.equal(
      validateOriginFlowSummary(result, { companyId: company, date }),
      false,
      String(mutate),
    );
  }
});
test("origin flow API only forwards the user token and rejects invalid dates or mismatched report", async () => {
  const base = {
    companyId: company,
    accessToken: "synthetic-user",
    publishableKey: "synthetic-public",
    restBase: new URL("http://localhost/rest/v1/"),
    method: "GET",
  };
  const request = (url) => ({ ...base, url: new URL(url) });
  const url = `http://localhost/v1/companies/${company}/custody-flow?business_date=${date}`;
  const result = await custodyApi({
    ...request(url),
    fetchImpl: async (target, options) => {
      assert.equal(target.pathname, "/rest/v1/rpc/list_origin_flow_summary");
      assert.equal(options.headers.authorization, "Bearer synthetic-user");
      assert.deepEqual(JSON.parse(options.body), {
        p_company_id: company,
        p_business_date: date,
        p_offset: 0,
      });
      return Response.json(sample());
    },
  });
  assert.equal(result.status, 200);
  const bad = sample();
  bad.company_id = bad.items[0].site_id;
  assert.equal(
    (
      await custodyApi({
        ...request(url),
        fetchImpl: async () => Response.json(bad),
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await custodyApi({
        ...request(url.replace(date, "2026-02-30")),
        fetchImpl: async () => {
          throw new Error("must not request");
        },
      })
    ).status,
    400,
  );
});
