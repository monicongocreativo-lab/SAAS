import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { feedInventoryApi } from "../src/auth-prototype/feed-inventory-api.mjs";
import {
  ledgerEquation,
  validateLedgerCommand,
  validateLedgerEntries,
  validateLedgerReceipt,
  validateLedgerReview,
} from "../src/shared/feed-ledger-contract.mjs";

const c = randomUUID(),
  o = randomUUID(),
  actor = randomUUID(),
  hash = "a".repeat(64),
  time = "2026-10-27T17:00:00.000Z";
const activation = () => ({
  format: "tamago.feed-inventory-activation",
  schema_version: 1,
  action_id: randomUUID(),
  company_id: c,
  opening_id: o,
  through_at: time,
  review_token: hash,
  reason: "SYN-Apertura revisada",
});
const ajv = new Ajv2020({ strict: true });
ajv.addSchema(
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
for (const name of ["activation", "posting", "receipt", "review", "entries"])
  ajv.addSchema(
    JSON.parse(
      readFileSync(
        new URL(
          `../contracts/feed-ledger-${name}.v1.schema.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
const receipt = (e) => ({
  format: "tamago.feed-ledger-receipt",
  schema_version: 1,
  event: e,
  actor_id: actor,
  recorded_at: time,
  account_id: e.account_id ?? e.action_id,
  revision: e.expected_revision === undefined ? 1 : e.expected_revision + 1,
  balance_bags: "13",
  duplicate: false,
  inventory_check: "applied_to_book",
  coverage: "server_records_only",
});
function review() {
  const count = randomUUID(),
    product = randomUUID(),
    loc = randomUUID();
  return {
    format: "tamago.feed-ledger-review",
    schema_version: 1,
    company_id: c,
    opening_id: o,
    through_at: time,
    account: null,
    revision: 0,
    book_through_at: null,
    anchor: {
      count_id: count,
      binding_id: randomUUID(),
      binding_revision: 0,
      product_id: product,
      location_id: loc,
      cutoff_at: "2026-10-27T12:00:00Z",
      opening_bags: "10",
    },
    book_balance_bags: null,
    proposed_balance_bags: "13",
    available_bags: null,
    status: "needs_activation",
    can_activate: true,
    can_post: false,
    can_manage: true,
    coverage: "server_records_only",
    inventory_check: "not_activated",
    preview: {
      format: "tamago.feed-balance-preview",
      schema_version: 1,
      company_id: c,
      opening_id: o,
      purpose: "reconciliation_preview",
      inventory_check: "not_applied",
      coverage: "server_records_only",
      through_at: time,
      status: "resolved",
      reason: null,
      product_id: product,
      location_id: loc,
      count_id: count,
      cutoff_at: "2026-10-27T12:00:00Z",
      opening_bags: "10",
      known_receipts_bags: "3",
      known_supplied_bags: "0",
      diagnostic_balance_bags: "13",
      balance_bags: "13",
      unmapped_count: 0,
      pending_tie_count: 0,
      blockers: [],
      blockers_truncated: false,
    },
    source_count: 1,
    pending_sources: 1,
    other_applied_sources: 0,
    review_token: hash,
    items: [
      {
        source_kind: "delivery",
        source_id: randomUUID(),
        quantity_bags: "3",
        occurred_at: "2026-10-27T13:00:00Z",
        desired_bags: "3",
        applied_bags: "0",
        delta_bags: "3",
        pending: true,
        other_applied: false,
        context_hash: hash,
      },
    ],
    next_offset: null,
  };
}
test("ledger command and actor-bound receipt never confuse approved count with applied book", () => {
  const e = activation();
  assert.equal(validateLedgerCommand(e, c), true);
  assert.equal(ajv.getSchema("urn:tamago:feed-ledger-activation:v1")(e), true);
  for (const bad of [
    { ...e, reason: " " },
    { ...e, actor_id: actor },
    { ...e, company_id: randomUUID() },
    { ...e, through_at: "2026-02-30T17:00:00.000Z" },
    { ...e, review_token: "bad" },
  ])
    assert.equal(validateLedgerCommand(bad, c), false);
  assert.equal(validateLedgerReceipt(receipt(e), e, actor), true);
  assert.equal(
    ajv.getSchema("urn:tamago:feed-ledger-receipt:v1")(receipt(e)),
    true,
  );
  assert.equal(
    validateLedgerReceipt({ ...receipt(e), actor_id: randomUUID() }, e, actor),
    false,
  );
  assert.equal(
    validateLedgerReceipt(
      { ...receipt(e), inventory_check: "not_applied" },
      e,
      actor,
    ),
    false,
  );
  const p = {
    ...e,
    format: "tamago.feed-inventory-posting",
    account_id: randomUUID(),
    expected_revision: 2,
  };
  delete p.opening_id;
  assert.equal(validateLedgerCommand(p, c), true);
  assert.equal(ajv.getSchema("urn:tamago:feed-ledger-posting:v1")(p), true);
  assert.equal(validateLedgerReceipt(receipt(p), p, actor), true);
  assert.equal(
    validateLedgerReceipt({ ...receipt(p), revision: 2 }, p, actor),
    false,
  );
});
test("ledger review binds whole context, exact source deltas and availability to real book state", () => {
  const r = review();
  assert.equal(validateLedgerReview(r, c, o), true);
  assert.equal(ajv.getSchema("urn:tamago:feed-ledger-review:v1")(r), true);
  assert.equal(
    validateLedgerReview({ ...r, available_bags: "13" }, c, o),
    false,
  );
  assert.equal(
    validateLedgerReview({ ...r, proposed_balance_bags: "999" }, c, o),
    false,
  );
  assert.equal(validateLedgerReview({ ...r, can_manage: false }, c, o), false);
  assert.equal(
    validateLedgerReview(
      { ...r, can_manage: false, can_activate: false },
      c,
      o,
    ),
    true,
  );
  assert.equal(
    validateLedgerReview(
      { ...r, items: [{ ...r.items[0], delta_bags: "4" }] },
      c,
      o,
    ),
    false,
  );
  assert.equal(validateLedgerReview({ ...r, source_count: 2 }, c, o), false);
  assert.equal(
    ledgerEquation(
      "9007199254740993.000000000000000000001",
      "0.000000000000000000001",
      "9007199254740993",
    ),
    true,
  );
  assert.equal(ledgerEquation("0", "0.125", "-0.125"), true);
  assert.equal(
    validateLedgerEntries(
      {
        format: "tamago.feed-ledger-entries",
        schema_version: 1,
        company_id: c,
        account_id: randomUUID(),
        revision: 1,
        book_balance_bags: 13,
        items: [],
        next_offset: null,
      },
      c,
      randomUUID(),
    ),
    false,
  );
});
test("ledger API uses individual bearer, rejects changed receipt and validates requested window", async () => {
  const e = activation(),
    args = {
      url: new URL(
        `http://local/v1/companies/${c}/feed-inventory/ledger-activate`,
      ),
      method: "POST",
      body: e,
      companyId: c,
      userId: actor,
      accessToken: "individual-only",
      publishableKey: "public",
      restBase: "http://127.0.0.1/rest/v1/",
      fetchImpl: async (url, opts) => {
        assert.match(url.pathname, /apply_feed_ledger$/);
        assert.equal(opts.headers.authorization, "Bearer individual-only");
        assert.deepEqual(JSON.parse(opts.body), { p_event: e });
        return Response.json(receipt(e));
      },
    };
  assert.equal((await feedInventoryApi(args)).status, 200);
  assert.equal(
    (await feedInventoryApi({ ...args, body: { ...e, expected_revision: 0 } }))
      .status,
    400,
  );
  assert.equal(
    (
      await feedInventoryApi({
        ...args,
        fetchImpl: async () =>
          Response.json({ ...receipt(e), balance_bags: -1 }),
      })
    ).status,
    503,
  );
  const get = {
    ...args,
    url: new URL(
      `http://local/v1/companies/${c}/feed-inventory/ledger-review/${o}?through_at=${encodeURIComponent(time)}`,
    ),
    method: "GET",
    fetchImpl: async () => Response.json(review()),
  };
  assert.equal((await feedInventoryApi(get)).status, 200);
  assert.equal(
    (
      await feedInventoryApi({
        ...get,
        fetchImpl: async () =>
          Response.json({ ...review(), through_at: "2026-10-27T18:00:00Z" }),
      })
    ).status,
    503,
  );
});
