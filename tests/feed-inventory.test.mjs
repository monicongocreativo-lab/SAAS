import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { feedInventoryApi } from "../src/auth-prototype/feed-inventory-api.mjs";
import {
  validateBalancePreview,
  validateInventoryCommand,
  validateInventoryReceipt,
} from "../src/shared/feed-inventory-contract.mjs";

const c = randomUUID(),
  lot = randomUUID(),
  op = randomUUID(),
  actor = randomUUID();
const catalog = () => ({
  format: "tamago.feed-catalog-item",
  schema_version: 1,
  item_id: randomUUID(),
  company_id: c,
  site_id: randomUUID(),
  house_id: randomUUID(),
  lot_id: lot,
  kind: "product",
  code: "SYN_FEED",
  label: "SYN-Fórmula",
  unit: "BAG_40KG",
  reason: "SYN-Identidad confirmada",
});
const ajv = new Ajv2020({ strict: true }),
  schemas = {};
for (const k of ["catalog", "binding", "cutoff"])
  schemas[k] = ajv.compile(
    JSON.parse(
      readFileSync(
        new URL(
          `../contracts/feed-inventory-${k}.v1.schema.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
const ackSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/feed-inventory-receipt.v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const balanceSchema = ajv.compile(
  JSON.parse(
    readFileSync(
      new URL(
        "../contracts/feed-balance-preview.v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const preview = () => ({
  format: "tamago.feed-balance-preview",
  schema_version: 1,
  company_id: c,
  opening_id: op,
  purpose: "reconciliation_preview",
  inventory_check: "not_applied",
  coverage: "server_records_only",
  through_at: "2026-10-28T17:00:00Z",
  status: "resolved",
  reason: null,
  product_id: randomUUID(),
  location_id: randomUUID(),
  count_id: randomUUID(),
  cutoff_at: "2026-10-28T12:00:00Z",
  opening_bags: "9007199254740993.125",
  known_receipts_bags: "0.000000000000000000001",
  known_supplied_bags: "0.125",
  diagnostic_balance_bags: "9007199254740993.000000000000000000001",
  balance_bags: "9007199254740993.000000000000000000001",
  unmapped_count: 0,
  pending_tie_count: 0,
  blockers: [],
  blockers_truncated: false,
});
test("inventory command schemas enforce typed identities, reasons and idempotent acknowledgments", () => {
  const p = catalog(),
    events = {
      catalog: p,
      binding: {
        format: "tamago.feed-fact-binding",
        schema_version: 1,
        binding_id: randomUUID(),
        company_id: c,
        source_kind: "count",
        source_id: randomUUID(),
        product_id: p.item_id,
        location_id: randomUUID(),
        reason: "SYN-Vínculo revisado",
      },
      cutoff: {
        format: "tamago.feed-cutoff-decision",
        schema_version: 1,
        action_id: randomUUID(),
        company_id: c,
        opening_id: op,
        count_id: randomUUID(),
        source_kind: "delivery",
        source_id: randomUUID(),
        classification: "included_in_count",
        reason: "SYN-Estaba contado",
      },
    };
  for (const [kind, e] of Object.entries(events)) {
    assert.equal(schemas[kind](e), true, JSON.stringify(schemas[kind].errors));
    assert.equal(validateInventoryCommand(e, c, kind), true);
    assert.equal(
      validateInventoryCommand({ ...e, reason: " " }, c, kind),
      false,
    );
    assert.equal(
      validateInventoryCommand({ ...e, actor_id: actor }, c, kind),
      false,
    );
    assert.equal(validateInventoryCommand(e, randomUUID(), kind), false);
    const r = {
      format: "tamago.feed-inventory-command-receipt",
      schema_version: 1,
      event: e,
      actor_id: actor,
      recorded_at: "2026-10-28T17:00:00Z",
      inventory_check: "not_applied",
      duplicate: false,
    };
    assert.equal(ackSchema(r), true);
    assert.equal(validateInventoryReceipt(r, e, actor, kind), true);
    assert.equal(
      validateInventoryReceipt(
        { ...r, inventory_check: "applied" },
        e,
        actor,
        kind,
      ),
      false,
    );
  }
  assert.equal(
    validateInventoryCommand({ ...p, kind: "location" }, c, "catalog"),
    false,
  );
  assert.equal(
    validateInventoryCommand(
      { ...p, kind: "location", unit: null },
      c,
      "catalog",
    ),
    true,
  );
  assert.equal(
    validateInventoryCommand({ ...p, code: "with spaces" }, c, "catalog"),
    false,
  );
});
test("balance preview validates exact arithmetic beyond Number, blockers and negative diagnostics without claiming stock", () => {
  const v = preview();
  assert.equal(balanceSchema(v), true);
  assert.equal(validateBalancePreview(v, c, op), true);
  assert.equal(
    validateBalancePreview({ ...v, balance_bags: "9007199254740993" }, c, op),
    false,
  );
  assert.equal(
    validateBalancePreview({ ...v, diagnostic_balance_bags: "1" }, c, op),
    false,
  );
  const blocked = {
    ...v,
    status: "blocked",
    balance_bags: null,
    pending_tie_count: 1,
    blockers: [
      {
        source_kind: "delivery",
        source_id: randomUUID(),
        problem: "cutoff_tie",
      },
    ],
  };
  assert.equal(validateBalancePreview(blocked, c, op), true);
  assert.equal(
    validateBalancePreview({ ...blocked, balance_bags: v.balance_bags }, c, op),
    false,
  );
  assert.equal(
    validateBalancePreview({ ...v, blockers: blocked.blockers }, c, op),
    false,
  );
  const negative = {
    ...v,
    status: "negative",
    opening_bags: "0",
    known_receipts_bags: "0",
    known_supplied_bags: "0.125",
    diagnostic_balance_bags: "-0.125",
    balance_bags: null,
  };
  assert.equal(validateBalancePreview(negative, c, op), true);
  assert.equal(validateBalancePreview({ ...v, available: true }, c, op), false);
  assert.equal(
    validateBalancePreview({ ...v, coverage: "all_physical_activity" }, c, op),
    false,
  );
});
test("inventory API uses actor bearer, validates commands and binds preview scope/window", async () => {
  const e = catalog();
  let calls = 0;
  const args = {
    url: new URL(`http://local/v1/companies/${c}/feed-inventory/catalog`),
    method: "POST",
    body: e,
    companyId: c,
    userId: actor,
    accessToken: "user-only",
    publishableKey: "publishable",
    restBase: "http://127.0.0.1/rest/v1/",
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(options.headers.authorization, "Bearer user-only");
      assert.deepEqual(JSON.parse(options.body), { p_event: e });
      return Response.json({
        format: "tamago.feed-inventory-command-receipt",
        schema_version: 1,
        event: e,
        actor_id: actor,
        recorded_at: "2026-10-28T17:00:00Z",
        inventory_check: "not_applied",
        duplicate: false,
      });
    },
  };
  assert.equal((await feedInventoryApi(args)).status, 200);
  assert.equal(
    (
      await feedInventoryApi({
        ...args,
        body: { ...e, company_id: randomUUID() },
      })
    ).status,
    400,
  );
  assert.equal(calls, 1);
  assert.equal(
    (
      await feedInventoryApi({
        ...args,
        fetchImpl: async () => Response.json({ accepted: true }),
      })
    ).status,
    503,
  );
  const url = new URL(
    `http://local/v1/companies/${c}/feed-inventory/previews/${op}?through_at=2026-10-28T17%3A00%3A00.000Z`,
  );
  assert.equal(
    (
      await feedInventoryApi({
        ...args,
        url,
        method: "GET",
        fetchImpl: async () => Response.json(preview()),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await feedInventoryApi({
        ...args,
        url,
        method: "GET",
        fetchImpl: async () =>
          Response.json({ ...preview(), through_at: "2026-10-28T18:00:00Z" }),
      })
    ).status,
    503,
  );
});
