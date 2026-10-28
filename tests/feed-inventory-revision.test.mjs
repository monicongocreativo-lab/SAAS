import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { feedInventoryApi } from "../src/auth-prototype/feed-inventory-api.mjs";
import {
  assessCorrectionOutcome,
  validateCorrectionReceipt,
  validateEffectiveBinding,
  validateInventoryCorrection,
  validateInventoryHistory,
} from "../src/shared/feed-inventory-revision.mjs";

const c = randomUUID(),
  actor = randomUUID(),
  target = randomUUID(),
  product = randomUUID(),
  location = randomUUID();
const correction = () => ({
  format: "tamago.feed-inventory-correction",
  schema_version: 1,
  revision_id: randomUUID(),
  company_id: c,
  target_kind: "binding",
  target_id: target,
  expected_revision: 0,
  previous_revision_id: null,
  product_id: product,
  location_id: location,
  reason: "SYN-Corrección respaldada",
});
const base = () => ({
  format: "tamago.feed-fact-binding",
  schema_version: 1,
  binding_id: target,
  company_id: c,
  source_kind: "delivery",
  source_id: randomUUID(),
  product_id: randomUUID(),
  location_id: location,
  reason: "SYN-Original",
});
const ack = (e) => ({
  format: "tamago.feed-inventory-command-receipt",
  schema_version: 1,
  event: e,
  actor_id: actor,
  recorded_at: "2026-10-28T17:00:00Z",
  duplicate: false,
  inventory_check: "not_applied",
});
const ajv = new Ajv2020({ strict: true });
for (const name of ["correction", "correction-receipt", "history"])
  ajv.addSchema(
    JSON.parse(
      readFileSync(
        new URL(
          `../contracts/feed-inventory-${name}.v1.schema.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    ),
  );
test("inventory correction contract binds expected version, chain, actor and original immutability", () => {
  const e = correction();
  assert.equal(
    ajv.getSchema("urn:tamago:feed-inventory-correction:v1")(e),
    true,
  );
  assert.equal(validateInventoryCorrection(e, c), true);
  for (const bad of [
    { ...e, reason: " " },
    { ...e, previous_revision_id: randomUUID() },
    { ...e, expected_revision: 1 },
    { ...e, expected_revision: 0.5 },
    { ...e, company_id: randomUUID() },
    { ...e, quantity: "7" },
  ])
    assert.equal(validateInventoryCorrection(bad, c), false);
  const d = {
    ...e,
    target_kind: "cutoff",
    classification: "after_count",
    expected_opening_binding_revision: 0,
    expected_movement_binding_revision: 2,
  };
  delete d.product_id;
  delete d.location_id;
  assert.equal(validateInventoryCorrection(d, c), true);
  assert.equal(
    ajv.getSchema("urn:tamago:feed-inventory-correction:v1")(d),
    true,
  );
  assert.equal(
    validateInventoryCorrection(
      { ...d, expected_movement_binding_revision: -1 },
      c,
    ),
    false,
  );
  assert.equal(validateCorrectionReceipt(ack(e), e, actor), true);
  assert.equal(
    ajv.getSchema("urn:tamago:feed-inventory-correction-receipt:v1")(ack(e)),
    true,
  );
  assert.equal(
    validateCorrectionReceipt({ ...ack(e), actor_id: randomUUID() }, e, actor),
    false,
  );
  assert.equal(
    validateCorrectionReceipt(
      { ...ack(e), event: { ...e, reason: "changed" } },
      e,
      actor,
    ),
    false,
  );
});
test("history validates current head and chain, effective binding separates original and corrected state", () => {
  const e = correction(),
    b = base(),
    row = {
      revision_id: e.revision_id,
      company_id: c,
      target_kind: "binding",
      target_id: target,
      version: 1,
      previous_revision_id: null,
      product_id: product,
      location_id: location,
      event_payload: e,
      recorded_by: actor,
      recorded_at: "2026-10-28T17:00:00Z",
    };
  const original = {
    company_id: c,
    binding_id: target,
    event_payload: b,
    recorded_by: actor,
    recorded_at: row.recorded_at,
  };
  const h = {
    format: "tamago.feed-inventory-history",
    schema_version: 1,
    company_id: c,
    target_kind: "binding",
    target_id: target,
    current_revision: 1,
    original,
    items: [row],
    next_offset: null,
    inventory_check: "not_applied",
  };
  assert.equal(validateInventoryHistory(h, c, "binding", target), true);
  assert.equal(ajv.getSchema("urn:tamago:feed-inventory-history:v1")(h), true);
  assert.equal(
    validateInventoryHistory(
      { ...h, current_revision: 2 },
      c,
      "binding",
      target,
    ),
    false,
  );
  assert.equal(
    validateInventoryHistory({ ...h, items: [] }, c, "binding", target),
    false,
  );
  assert.equal(
    validateInventoryHistory(h, randomUUID(), "binding", target),
    false,
  );
  const effective = {
    ...original,
    source_kind: b.source_kind,
    source_id: b.source_id,
    product_id: product,
    location_id: location,
    correction_revision: 1,
    current_revision_id: e.revision_id,
    current_event: e,
    effective_actor: actor,
    effective_recorded_at: row.recorded_at,
  };
  assert.equal(
    validateEffectiveBinding(effective, c, b.source_kind, b.source_id),
    true,
  );
  assert.equal(
    validateEffectiveBinding(
      { ...effective, product_id: b.product_id },
      c,
      b.source_kind,
      b.source_id,
    ),
    false,
  );
  assert.equal(
    validateEffectiveBinding(
      {
        ...effective,
        correction_revision: 0,
        current_revision_id: null,
        current_event: b,
        product_id: b.product_id,
      },
      c,
      b.source_kind,
      b.source_id,
    ),
    true,
  );
});
test("revision API validates command and actor-bound receipt; history page must agree with requested target", async () => {
  const e = correction(),
    args = {
      url: new URL(`http://local/v1/companies/${c}/feed-inventory/corrections`),
      method: "POST",
      body: e,
      companyId: c,
      userId: actor,
      accessToken: "individual",
      publishableKey: "public",
      restBase: "http://127.0.0.1/rest/v1/",
      fetchImpl: async (url, o) => {
        assert.match(url.pathname, /correct_feed_inventory$/);
        assert.equal(o.headers.authorization, "Bearer individual");
        assert.deepEqual(JSON.parse(o.body), { p_event: e });
        return Response.json(ack(e));
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
  assert.equal(
    (
      await feedInventoryApi({
        ...args,
        fetchImpl: async () =>
          Response.json({
            ...ack(e),
            event: { ...e, product_id: randomUUID() },
          }),
      })
    ).status,
    503,
  );
  const history = {
    ...args,
    url: new URL(
      `http://local/v1/companies/${c}/feed-inventory/history/binding/${target}`,
    ),
    method: "GET",
    fetchImpl: async () => Response.json(null),
  };
  assert.equal((await feedInventoryApi(history)).status, 404);
  assert.equal(
    (
      await feedInventoryApi({
        ...history,
        fetchImpl: async () => Response.json({ items: [] }),
      })
    ).status,
    503,
  );
});

test("correction recovery never retires uncertainty or forges an acknowledgment", () => {
  const e = correction(),
    row = {
      revision_id: e.revision_id,
      company_id: c,
      target_kind: "binding",
      target_id: target,
      version: 1,
      previous_revision_id: null,
      product_id: e.product_id,
      location_id: e.location_id,
      event_payload: e,
      recorded_by: actor,
      recorded_at: "2026-10-28T17:00:00Z",
    };
  const original = {
    company_id: c,
    binding_id: target,
    event_payload: base(),
    recorded_by: actor,
    recorded_at: row.recorded_at,
  };
  const h = {
    format: "tamago.feed-inventory-history",
    schema_version: 1,
    company_id: c,
    target_kind: "binding",
    target_id: target,
    current_revision: 1,
    original,
    items: [row],
    next_offset: null,
    inventory_check: "not_applied",
  };
  assert.equal(assessCorrectionOutcome(h, e, actor), "recorded");
  assert.equal(
    assessCorrectionOutcome({ ...h, current_revision: 0, items: [] }, e, actor),
    "unknown",
  );
  assert.equal(assessCorrectionOutcome(h, e, randomUUID()), "unknown");
  const other = {
    ...e,
    revision_id: randomUUID(),
    reason: "SYN-Otro escritor",
  };
  assert.equal(
    assessCorrectionOutcome(
      {
        ...h,
        items: [
          { ...row, revision_id: other.revision_id, event_payload: other },
        ],
      },
      e,
      actor,
    ),
    "rejected",
  );
  assert.equal(
    assessCorrectionOutcome({ ...h, company_id: randomUUID() }, e, actor),
    "unknown",
  );
});
