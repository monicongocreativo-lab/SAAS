import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { feedSupplyApi } from "../src/auth-prototype/feed-supply-api.mjs";
import {
  normalizeFeedQuantity,
  validateFeedReceipt,
  validateFeedSupply,
} from "../src/shared/feed-supply-contract.mjs";

const event = () => ({
  schema_version: 1,
  event_id: randomUUID(),
  company_id: randomUUID(),
  site_id: randomUUID(),
  house_id: randomUUID(),
  lot_id: randomUUID(),
  business_date: "2026-10-28",
  occurred_at: "2026-10-29T04:59:59.000Z",
  product_declared: "Fórmula ficticia",
  quantity: "4.25",
  unit: "BAG_40KG",
  source_declared: null,
  physical_batch_declared: null,
  notes: null,
});
const ajv = new Ajv2020({ strict: true });
const schema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL("../contracts/feed-supply.v1.schema.json", import.meta.url),
      "utf8",
    ),
  ),
);
const receiptSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/feed-supply-receipt.v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

test("feed supply exact decimal, explicit zero, Colombian date and schema agree", () => {
  const e = event();
  assert.equal(schema(e), true);
  assert.equal(validateFeedSupply(e, e.company_id), true);
  for (const quantity of [
    "0",
    "0.125",
    "9007199254740993.123456789",
    "0.000000000000000000001",
  ])
    assert.equal(validateFeedSupply({ ...e, quantity }, e.company_id), true);
  for (const bad of [
    { quantity: 4.25 },
    { quantity: "-1" },
    { quantity: "1e3" },
    { quantity: "01" },
    { quantity: "1.00" },
    { quantity: "0.0" },
    { quantity: "0,5" },
    { quantity: "1".repeat(101) },
    { unit: "BAG" },
    { unit: "KG" },
    { business_date: "2026-10-29" },
    { occurred_at: "2026-02-30T12:00:00.000Z" },
    { recorded_by: randomUUID() },
    { source_declared: " " },
  ])
    assert.equal(
      validateFeedSupply({ ...e, ...bad }, e.company_id),
      false,
      JSON.stringify(bad),
    );
  assert.equal(validateFeedSupply(e, randomUUID()), false);
});
test("feed receipt binds all content to real actor and preserves pending inventory review", () => {
  const e = event(),
    actor = randomUUID();
  const r = {
    format: "tamago.feed-supply-receipt",
    schema_version: 1,
    event: e,
    recorded_by: actor,
    recorded_at: "2026-10-29T12:00:00.000Z",
    inventory_check: "not_evaluated",
    duplicate: false,
  };
  assert.equal(receiptSchema(r), true, JSON.stringify(receiptSchema.errors));
  assert.equal(validateFeedReceipt(r, e, actor), true);
  assert.equal(validateFeedReceipt({ ...r, duplicate: true }, e, actor), true);
  for (const bad of [
    { inventory_check: "approved" },
    { recorded_by: randomUUID() },
    { event: { ...e, quantity: "5" } },
    { accepted: true },
  ])
    assert.equal(validateFeedReceipt({ ...r, ...bad }, e, actor), false);
});
test("feed API uses actor bearer only, validates receipt and rejects malformed or foreign payload before RPC", async () => {
  const e = event(),
    actor = randomUUID(),
    calls = [];
  const args = {
    url: new URL(`http://local/v1/companies/${e.company_id}/feed-supplies`),
    method: "POST",
    body: e,
    companyId: e.company_id,
    userId: actor,
    accessToken: "user-only",
    restBase: "http://127.0.0.1/rest/v1/",
    publishableKey: "publishable",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        format: "tamago.feed-supply-receipt",
        schema_version: 1,
        event: e,
        recorded_by: actor,
        recorded_at: "2026-10-29T12:00:00Z",
        inventory_check: "not_evaluated",
        duplicate: false,
      });
    },
  };
  assert.equal((await feedSupplyApi(args)).status, 200);
  assert.equal(calls[0].options.headers.authorization, "Bearer user-only");
  assert.deepEqual(JSON.parse(calls[0].options.body), { p_event: e });
  assert.equal(
    (await feedSupplyApi({ ...args, body: { ...e, company_id: randomUUID() } }))
      .status,
    400,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (
      await feedSupplyApi({
        ...args,
        fetchImpl: async () => Response.json({ accepted: true }),
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await feedSupplyApi({
        ...args,
        fetchImpl: async () =>
          Response.json({ code: "23505" }, { status: 409 }),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await feedSupplyApi({
        ...args,
        fetchImpl: async () => {
          throw new Error("network");
        },
      })
    ).status,
    503,
  );
});

test("feed input normalizes comma and redundant zeros without floating point or rounding", () => {
  for (const [input, expected] of [
    ["4,25", "4.25"],
    ["004.2500", "4.25"],
    ["0,0000000000000000000010", "0.000000000000000000001"],
    ["000", "0"],
    ["9007199254740993,125", "9007199254740993.125"],
    [" 0,00 ", "0"],
  ])
    assert.equal(normalizeFeedQuantity(input), expected);
  for (const input of [
    "-1",
    "1e3",
    "1.000,25",
    "1 000",
    ".25",
    "1,",
    null,
    "1".repeat(111),
  ])
    assert.equal(normalizeFeedQuantity(input), null);
});

test("feed scope hint remains user-scoped and rejects incompatible permission response", async () => {
  const e = event();
  let seen;
  const args = {
    url: new URL(
      `http://local/v1/companies/${e.company_id}/feed-supply-context`,
    ),
    method: "GET",
    companyId: e.company_id,
    accessToken: "scoped-user",
    publishableKey: "publishable",
    restBase: "http://127.0.0.1/rest/v1/",
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return Response.json({
        company_id: e.company_id,
        lots: [{ lot_id: e.lot_id, can_record: false }],
      });
    },
  };
  assert.equal((await feedSupplyApi(args)).status, 200);
  assert.equal(seen.options.headers.authorization, "Bearer scoped-user");
  assert.deepEqual(JSON.parse(seen.options.body), {
    p_company_id: e.company_id,
  });
  for (const scope of [
    { company_id: randomUUID(), lots: [] },
    {
      company_id: e.company_id,
      lots: [{ lot_id: e.lot_id, can_record: "yes" }],
    },
    {
      company_id: e.company_id,
      lots: [
        { lot_id: e.lot_id, can_record: true },
        { lot_id: e.lot_id, can_record: true },
      ],
    },
  ])
    assert.equal(
      (
        await feedSupplyApi({
          ...args,
          fetchImpl: async () => Response.json(scope),
        })
      ).status,
      503,
    );
});
