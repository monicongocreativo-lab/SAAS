import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { feedDeliveryApi } from "../src/auth-prototype/feed-delivery-api.mjs";
import {
  validateFeedDelivery,
  validateFeedDeliveryReceipt,
} from "../src/shared/feed-delivery-contract.mjs";
import { validateFeedSupply } from "../src/shared/feed-supply-contract.mjs";

const event = () => ({
  format: "tamago.feed-delivery",
  schema_version: 1,
  event_id: randomUUID(),
  company_id: randomUUID(),
  site_id: randomUUID(),
  house_id: randomUUID(),
  lot_id: randomUUID(),
  business_date: "2026-10-28",
  occurred_at: "2026-10-29T04:59:59.000Z",
  product_declared: "SYN-Fórmula",
  quantity: "12.5",
  unit: "BAG_40KG",
  location_declared: "SYN-Bodega galpón",
  supplier_declared: null,
  physical_batch_declared: null,
  delivery_reference_declared: null,
  notes: null,
});
const ajv = new Ajv2020({ strict: true });
const schema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL("../contracts/feed-delivery.v1.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const ackSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/feed-delivery-receipt.v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
test("feed delivery contract preserves exact positive physical quantities and rejects supply/zero/unknown location", () => {
  const e = event();
  assert.equal(schema(e), true);
  assert.equal(validateFeedDelivery(e, e.company_id), true);
  assert.equal(validateFeedSupply(e, e.company_id), false);
  for (const quantity of ["0.000000000000000000001", "9007199254740993.125"])
    assert.equal(validateFeedDelivery({ ...e, quantity }, e.company_id), true);
  for (const bad of [
    { quantity: "0" },
    { quantity: 12.5 },
    { quantity: "-1" },
    { quantity: "1,25" },
    { quantity: "1.00" },
    { location_declared: null },
    { location_declared: " " },
    { supplier_declared: 17 },
    { supplier_declared: "" },
    { delivery_reference_declared: " " },
    { format: "tamago.feed-supply" },
    { recorded_by: randomUUID() },
    { business_date: "2026-10-29" },
    { occurred_at: "2026-02-30T12:00:00.000Z" },
    { unit: "BAG" },
  ])
    assert.equal(
      validateFeedDelivery({ ...e, ...bad }, e.company_id),
      false,
      JSON.stringify(bad),
    );
  assert.equal(validateFeedDelivery(e, randomUUID()), false);
});
test("delivery acknowledgment binds original event and actor without claiming opening or inventory approval", () => {
  const e = event(),
    actor = randomUUID(),
    ack = {
      format: "tamago.feed-delivery-receipt",
      schema_version: 1,
      event: e,
      recorded_by: actor,
      recorded_at: "2026-10-29T12:00:00Z",
      inventory_check: "not_evaluated",
      duplicate: false,
    };
  assert.equal(ackSchema(ack), true);
  assert.equal(validateFeedDeliveryReceipt(ack, e, actor), true);
  assert.equal(
    validateFeedDeliveryReceipt({ ...ack, duplicate: true }, e, actor),
    true,
  );
  for (const bad of [
    { format: "tamago.feed-supply-receipt" },
    { inventory_check: "approved" },
    { opening_balance: "12.5" },
    { event: { ...e, quantity: "12" } },
    { recorded_by: randomUUID() },
  ])
    assert.equal(
      validateFeedDeliveryReceipt({ ...ack, ...bad }, e, actor),
      false,
    );
});
test("delivery API uses only user bearer, rejects wrong event before RPC and rejects malformed acknowledgments", async () => {
  const e = event(),
    actor = randomUUID(),
    calls = [];
  const args = {
    url: new URL(`http://local/v1/companies/${e.company_id}/feed-deliveries`),
    method: "POST",
    body: e,
    companyId: e.company_id,
    userId: actor,
    accessToken: "scoped-user",
    publishableKey: "publishable",
    restBase: "http://127.0.0.1/rest/v1/",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        format: "tamago.feed-delivery-receipt",
        schema_version: 1,
        event: e,
        recorded_by: actor,
        recorded_at: "2026-10-29T12:00:00Z",
        inventory_check: "not_evaluated",
        duplicate: false,
      });
    },
  };
  assert.equal((await feedDeliveryApi(args)).status, 200);
  assert.match(String(calls[0].url), /rpc\/record_feed_delivery$/);
  assert.equal(calls[0].options.headers.authorization, "Bearer scoped-user");
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_event: e });
  assert.equal(
    (await feedDeliveryApi({ ...args, body: { ...e, quantity: "0" } })).status,
    400,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await feedDeliveryApi({
        ...args,
        fetchImpl: async () => Response.json({ accepted: true }),
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await feedDeliveryApi({
        ...args,
        fetchImpl: async () =>
          Response.json({ code: "23505" }, { status: 409 }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await feedDeliveryApi({
        ...args,
        fetchImpl: async () => {
          throw new Error("network");
        },
      })
    ).status,
    503,
  );
  const query = new URL(args.url);
  query.search = "?business_date=2026-02-30";
  assert.equal(
    (await feedDeliveryApi({ ...args, method: "GET", url: query })).status,
    400,
  );
});
