import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { feedOpeningApi } from "../src/auth-prototype/feed-opening-api.mjs";
import {
  validateOpeningContext,
  validateOpeningList,
} from "../src/shared/feed-opening-context.mjs";
import {
  validateOpeningApproval,
  validateOpeningCount,
  validateOpeningReceipt,
} from "../src/shared/feed-opening-contract.mjs";

const count = () => ({
  format: "tamago.feed-opening-count",
  schema_version: 1,
  opening_id: randomUUID(),
  count_id: randomUUID(),
  company_id: randomUUID(),
  site_id: randomUUID(),
  house_id: randomUUID(),
  lot_id: randomUUID(),
  business_date: "2026-10-28",
  cutoff_at: "2026-10-29T04:59:59.000Z",
  product_declared: "SYN-Fórmula",
  location_declared: "SYN-Bodega",
  quantity: "0",
  unit: "BAG_40KG",
  evidence_reference: "SYN-Acta de conteo físico",
  notes: null,
  expected_revision: 0,
  previous_count_id: null,
});
const approval = (c) => ({
  format: "tamago.feed-opening-approval",
  schema_version: 1,
  action_id: randomUUID(),
  company_id: c.company_id,
  opening_id: c.opening_id,
  count_id: c.count_id,
  expected_revision: 1,
  reason: "SYN-Soporte y conteo revisados",
});
const ajv = new Ajv2020({ strict: true });
const schema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/feed-opening-count.v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const approveSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/feed-opening-approval.v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const receiptSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/feed-opening-receipt.v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
test("opening counts preserve explicit zero, evidence and version chain; authority is never client data", () => {
  const c = count();
  assert.equal(schema(c), true);
  assert.equal(validateOpeningCount(c, c.company_id), true);
  assert.equal(
    validateOpeningCount(
      {
        ...c,
        quantity: "0.000000000000001",
        expected_revision: 1,
        previous_count_id: c.count_id,
      },
      c.company_id,
    ),
    true,
  );
  for (const bad of [
    { evidence_reference: " " },
    { quantity: 0 },
    { quantity: "-1" },
    { expected_revision: 1 },
    { previous_count_id: randomUUID() },
    { company_id: randomUUID() },
    { approved_by: randomUUID() },
    { business_date: "2026-10-29" },
    { location_declared: null },
  ])
    assert.equal(validateOpeningCount({ ...c, ...bad }, c.company_id), false);
  const a = approval(c);
  assert.equal(approveSchema(a), true);
  assert.equal(validateOpeningApproval(a, c.company_id), true);
  assert.equal(
    validateOpeningApproval({ ...a, reason: "" }, c.company_id),
    false,
  );
});
test("opening receipt binds exact version/content/actor and reports not_applied even after approval", () => {
  const c = count(),
    actor = randomUUID();
  for (const approved of [false, true]) {
    const event = approved ? approval(c) : c;
    const r = {
      format: `tamago.feed-opening-${approved ? "approval" : "count"}-receipt`,
      schema_version: 1,
      event,
      actor_id: actor,
      recorded_at: "2026-10-29T12:00:00Z",
      revision: 1,
      state_at_recording: approved ? "approved" : "pending",
      inventory_check: "not_applied",
      duplicate: false,
    };
    assert.equal(receiptSchema(r), true, JSON.stringify(receiptSchema.errors));
    assert.equal(validateOpeningReceipt(r, event, actor, approved), true);
    for (const bad of [
      { inventory_check: "applied" },
      { revision: 2 },
      { actor_id: randomUUID() },
      { event: { ...event, notes: "changed" } },
    ])
      assert.equal(
        validateOpeningReceipt({ ...r, ...bad }, event, actor, approved),
        false,
      );
  }
});
test("opening API uses user token and rejects wrong receipt or forged authority before SQL", async () => {
  const c = count(),
    actor = randomUUID();
  let calls = 0;
  const args = {
    url: new URL(
      `http://local/v1/companies/${c.company_id}/feed-opening-counts`,
    ),
    method: "POST",
    body: c,
    companyId: c.company_id,
    userId: actor,
    accessToken: "user-only",
    publishableKey: "publishable",
    restBase: "http://127.0.0.1/rest/v1/",
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.headers.authorization, "Bearer user-only");
      return Response.json({
        format: "tamago.feed-opening-count-receipt",
        schema_version: 1,
        event: c,
        actor_id: actor,
        recorded_at: "2026-10-29T12:00:00Z",
        revision: 1,
        state_at_recording: "pending",
        inventory_check: "not_applied",
        duplicate: false,
      });
    },
  };
  assert.equal((await feedOpeningApi(args)).status, 200);
  assert.equal(
    (await feedOpeningApi({ ...args, body: { ...c, approved: true } })).status,
    400,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await feedOpeningApi({
        ...args,
        fetchImpl: async () => Response.json({ accepted: true }),
      })
    ).status,
    503,
  );
  assert.equal(
    (
      await feedOpeningApi({
        ...args,
        fetchImpl: async () =>
          Response.json({ code: "40001" }, { status: 409 }),
      })
    ).status,
    409,
  );
});

test("opening context/list require real typed permissions, scope, history and not_applied", () => {
  const c = count(),
    actor = randomUUID(),
    header = {
      opening_id: c.opening_id,
      company_id: c.company_id,
      site_id: c.site_id,
      house_id: c.house_id,
      lot_id: c.lot_id,
      product_declared: c.product_declared,
      location_declared: c.location_declared,
      unit: c.unit,
      current_revision: 1,
      status: "pending",
    };
  const context = {
    format: "tamago.feed-opening-context",
    schema_version: 1,
    inventory_check: "not_applied",
    opening: header,
    can_count: true,
    can_approve: false,
    counts: [
      {
        event_payload: c,
        revision: 1,
        recorded_by: actor,
        recorded_at: "2026-10-29T12:00:00Z",
      },
    ],
    approval: null,
    next_offset: null,
  };
  const args = { companyId: c.company_id, id: c.opening_id };
  assert.equal(validateOpeningContext(context, args), true);
  for (const bad of [
    { can_approve: "yes" },
    { inventory_check: "applied" },
    { counts: [] },
    { opening: { ...header, company_id: randomUUID() } },
    { counts: [...context.counts, ...context.counts] },
  ])
    assert.equal(validateOpeningContext({ ...context, ...bad }, args), false);
  const list = {
    format: "tamago.feed-opening-list",
    schema_version: 1,
    company_id: c.company_id,
    inventory_check: "not_applied",
    items: [header],
    next_offset: null,
  };
  assert.equal(validateOpeningList(list, c.company_id), true);
  assert.equal(
    validateOpeningList({ ...list, items: [header, header] }, c.company_id),
    false,
  );
});
test("opening list API sends user token and company and rejects incompatible response", async () => {
  const c = count();
  let sent;
  const args = {
    url: new URL(
      `http://local/v1/companies/${c.company_id}/feed-openings?offset=0`,
    ),
    method: "GET",
    companyId: c.company_id,
    accessToken: "user-only",
    publishableKey: "publishable",
    restBase: "http://127.0.0.1/rest/v1/",
    fetchImpl: async (_url, options) => {
      sent = options;
      return Response.json({
        format: "tamago.feed-opening-list",
        schema_version: 1,
        company_id: c.company_id,
        inventory_check: "not_applied",
        items: [],
        next_offset: null,
      });
    },
  };
  assert.equal((await feedOpeningApi(args)).status, 200);
  assert.equal(sent.headers.authorization, "Bearer user-only");
  assert.deepEqual(JSON.parse(sent.body), {
    p_company_id: c.company_id,
    p_offset: 0,
  });
  assert.equal(
    (
      await feedOpeningApi({
        ...args,
        fetchImpl: async () => Response.json({ approved: true }),
      })
    ).status,
    503,
  );
});
