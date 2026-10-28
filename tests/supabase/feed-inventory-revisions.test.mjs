import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("inventory revisions real HTTP/Auth/Postgres: CAS, lost reply, effective bindings, tie invalidation, immutable audit and pagination", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase",
  timeout: 120000,
}, async () => {
  let drop = false;
  const f = await startRealCustodyFixture({
    seedTransfers: false,
    gatewayFetch: async (url, options) => {
      const r = await fetch(url, options);
      if (
        drop &&
        new URL(url).pathname.endsWith("/rpc/correct_feed_inventory") &&
        r.ok
      ) {
        drop = false;
        await r.arrayBuffer();
        throw new Error("Fictitious committed correction reply lost");
      }
      return r;
    },
  });
  const { ids, users } = f;
  try {
    async function login(role) {
      const r = await fetch(`${f.origin}/v1/auth/login`, {
        method: "POST",
        headers: { origin: f.origin, "content-type": "application/json" },
        body: JSON.stringify({
          email: users[role].email,
          password: users[role].password,
        }),
      });
      assert.equal(r.status, 200);
      return {
        role,
        cookie: r.headers
          .getSetCookie()
          .map((s) => s.split(";")[0])
          .join("; "),
      };
    }
    async function call(s, path, body) {
      const r = await fetch(
        `${f.origin}/v1/companies/${ids.company}/feed-inventory/${path}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            cookie: s.cookie,
            "x-tamago-user": users[s.role].id,
            origin: f.origin,
            "content-type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      return { status: r.status, body: await r.json() };
    }
    const director = await login("director"),
      capture = await login("capture"),
      foreign = await login("foreign");
    const scope = {
      company_id: ids.company,
      site_id: ids.site,
      house_id: ids.house,
      lot_id: ids.lot,
    };
    const count = {
      ...scope,
      format: "tamago.feed-opening-count",
      schema_version: 1,
      opening_id: randomUUID(),
      count_id: randomUUID(),
      business_date: "2026-10-28",
      cutoff_at: "2026-10-28T12:00:00.000Z",
      product_declared: "SYN-Alias capturado",
      location_declared: "SYN-Ubicación capturada",
      quantity: "10",
      unit: "BAG_40KG",
      evidence_reference: "SYN-Conteo físico",
      notes: null,
      expected_revision: 0,
      previous_count_id: null,
    };
    await f.rpc(
      "record_feed_opening_count",
      { p_event: count },
      users.capture.token,
    );
    await f.rpc(
      "approve_feed_opening",
      {
        p_event: {
          format: "tamago.feed-opening-approval",
          schema_version: 1,
          action_id: randomUUID(),
          company_id: ids.company,
          opening_id: count.opening_id,
          count_id: count.count_id,
          expected_revision: 1,
          reason: "SYN-Revisado",
        },
      },
      users.director.token,
    );

    const item = (kind, code) => ({
      format: "tamago.feed-catalog-item",
      schema_version: 1,
      item_id: randomUUID(),
      ...scope,
      kind,
      code,
      label: "SYN-Mismo nombre",
      unit: kind === "product" ? "BAG_40KG" : null,
      reason: "SYN-Alta",
    });
    const p1 = item("product", "F1"),
      p2 = item("product", "F2"),
      loc = item("location", "L1");
    for (const e of [p1, p2, loc])
      assert.equal((await call(director, "catalog", e)).status, 200);
    const delivery = {
      ...scope,
      format: "tamago.feed-delivery",
      schema_version: 1,
      event_id: randomUUID(),
      business_date: "2026-10-28",
      occurred_at: count.cutoff_at,
      product_declared: "SYN-Original recepción",
      location_declared: "SYN-Original ubicación",
      quantity: "3",
      unit: "BAG_40KG",
      supplier_declared: null,
      physical_batch_declared: null,
      delivery_reference_declared: null,
      notes: null,
    };
    await f.rpc(
      "record_feed_delivery",
      { p_event: delivery },
      users.capture.token,
    );
    const binding = (kind, id) => ({
      format: "tamago.feed-fact-binding",
      schema_version: 1,
      binding_id: randomUUID(),
      company_id: ids.company,
      source_kind: kind,
      source_id: id,
      product_id: p1.item_id,
      location_id: loc.item_id,
      reason: "SYN-Vínculo original",
    });
    const countBinding = binding("count", count.count_id),
      movementBinding = binding("delivery", delivery.event_id);
    for (const e of [countBinding, movementBinding])
      assert.equal((await call(director, "bindings", e)).status, 200);
    const decision = {
      format: "tamago.feed-cutoff-decision",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      opening_id: count.opening_id,
      count_id: count.count_id,
      source_kind: "delivery",
      source_id: delivery.event_id,
      classification: "after_count",
      reason: "SYN-Primera revisión",
    };
    assert.equal(
      (await call(director, "cutoff-decisions", decision)).status,
      200,
    );
    const previewPath = `previews/${count.opening_id}?through_at=2026-10-28T17%3A00%3A00.000Z`;
    assert.equal((await call(director, previewPath)).body.balance_bags, "13");
    const sourceBefore = await f.provider(
        `/rest/v1/feed_delivery_events?event_id=eq.${delivery.event_id}`,
      ),
      baseBefore = await f.provider(
        `/rest/v1/feed_fact_bindings?binding_id=eq.${movementBinding.binding_id}`,
      ),
      decisionBefore = await f.provider(
        `/rest/v1/feed_cutoff_decisions?action_id=eq.${decision.action_id}`,
      );
    const common = (kind, id, n = 0, previous = null) => ({
      format: "tamago.feed-inventory-correction",
      schema_version: 1,
      revision_id: randomUUID(),
      company_id: ids.company,
      target_kind: kind,
      target_id: id,
      expected_revision: n,
      previous_revision_id: previous,
      reason: "SYN-Corrección respaldada",
    });
    const dc = {
      ...common("cutoff", decision.action_id),
      classification: "included_in_count",
      expected_opening_binding_revision: 0,
      expected_movement_binding_revision: 0,
    };
    drop = true;
    assert.equal((await call(director, "corrections", dc)).status, 503);
    const r = await call(director, "corrections", dc);
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicate, true);
    assert.deepEqual(r.body.event, dc);
    assert.equal(r.body.actor_id, users.director.id);
    assert.equal((await call(director, previewPath)).body.balance_bags, "10");
    const b1 = {
      ...common("binding", movementBinding.binding_id),
      product_id: p2.item_id,
      location_id: loc.item_id,
    };
    const retries = await Promise.all(
      Array.from({ length: 5 }, () => call(director, "corrections", b1)),
    );
    assert.equal(
      retries.filter((r) => r.status === 200 && !r.body.duplicate).length,
      1,
    );
    assert.equal(
      retries.filter((r) => r.status === 200 && r.body.duplicate).length,
      4,
    );
    const b2 = {
      ...common("binding", movementBinding.binding_id, 1, b1.revision_id),
      product_id: p1.item_id,
      location_id: loc.item_id,
    };
    const competing = {
      ...b2,
      revision_id: randomUUID(),
      reason: "SYN-Otro escritor",
    };
    const writers = await Promise.all([
      call(director, "corrections", b2),
      call(director, "corrections", competing),
    ]);
    assert.deepEqual(writers.map((r) => r.status).sort(), [200, 409]);
    let head = writers.find((r) => r.status === 200).body.event;
    const blocked = await call(director, previewPath);
    assert.equal(blocked.body.balance_bags, null);
    assert.equal(blocked.body.pending_tie_count, 1);
    const effective = await call(
      capture,
      `bindings/delivery/${delivery.event_id}`,
    );
    assert.equal(effective.status, 200);
    assert.equal(effective.body.binding.correction_revision, 2);
    assert.equal(effective.body.binding.current_revision_id, head.revision_id);
    assert.deepEqual(effective.body.binding.event_payload, movementBinding);
    assert.equal((await call(capture, "corrections", dc)).status, 403);
    assert.equal((await call(foreign, "corrections", dc)).status, 403);
    assert.equal(
      (await call(foreign, `history/binding/${movementBinding.binding_id}`))
        .status,
      404,
    );
    const dc2 = {
      ...common("cutoff", decision.action_id, 1, dc.revision_id),
      classification: "included_in_count",
      expected_opening_binding_revision: 0,
      expected_movement_binding_revision: 2,
    };
    assert.equal(
      (
        await call(director, "corrections", {
          ...dc2,
          expected_movement_binding_revision: 0,
        })
      ).status,
      409,
    );
    assert.equal((await call(director, "corrections", dc2)).status, 200);
    assert.equal((await call(director, previewPath)).body.balance_bags, "10");
    assert.equal(
      (await call(director, "corrections", dc)).body.duplicate,
      true,
    );
    assert.equal((await call(director, previewPath)).body.balance_bags, "10");
    assert.equal(
      (await call(director, "corrections", { ...dc, reason: "changed" }))
        .status,
      409,
    );
    assert.equal(
      (
        await call(director, "corrections", {
          ...dc2,
          revision_id: randomUUID(),
          quantity: "99",
        })
      ).status,
      400,
    );
    for (let n = 2; n < 27; n++) {
      const e = {
        ...common("binding", movementBinding.binding_id, n, head.revision_id),
        product_id: n % 2 === 0 ? p2.item_id : p1.item_id,
        location_id: loc.item_id,
      };
      const results = await Promise.all([
        call(director, "corrections", e),
        call(capture, previewPath),
      ]);
      assert.equal(results[0].status, 200);
      assert.equal(results[1].status, 200);
      head = e;
    }
    const first = await call(
      capture,
      `history/binding/${movementBinding.binding_id}`,
    );
    assert.equal(first.status, 200);
    assert.equal(first.body.current_revision, 27);
    assert.equal(first.body.items.length, 25);
    assert.equal(first.body.next_offset, 25);
    assert.equal(first.body.original.product_id, p1.item_id);
    const last = await call(
      capture,
      `history/binding/${movementBinding.binding_id}?offset=25`,
    );
    assert.equal(last.status, 200);
    assert.equal(last.body.items.length, 2);
    assert.equal(last.body.next_offset, null);
    const audit = await call(director, `history/cutoff/${decision.action_id}`);
    assert.equal(audit.status, 200);
    assert.equal(audit.body.current_revision, 2);
    assert.equal(audit.body.original.classification, "after_count");
    assert.equal(audit.body.items[0].classification, "included_in_count");
    assert.deepEqual(
      await f.provider(
        `/rest/v1/feed_delivery_events?event_id=eq.${delivery.event_id}`,
      ),
      sourceBefore,
    );
    assert.deepEqual(
      await f.provider(
        `/rest/v1/feed_fact_bindings?binding_id=eq.${movementBinding.binding_id}`,
      ),
      baseBefore,
    );
    assert.deepEqual(
      await f.provider(
        `/rest/v1/feed_cutoff_decisions?action_id=eq.${decision.action_id}`,
      ),
      decisionBefore,
    );
    const [membership] = await f.provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.director.id}`,
    );
    await f.provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${membership.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    assert.equal((await call(director, "corrections", head)).status, 403);
    assert.equal(
      (await call(director, `history/binding/${movementBinding.binding_id}`))
        .status,
      404,
    );
  } finally {
    await f.close();
  }
});
