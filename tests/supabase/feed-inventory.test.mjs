import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("inventory real HTTP/Auth/Postgres: stable catalog, source retention, cutoff blockers, exact preview and idempotency", {
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
        new URL(url).pathname.endsWith("/rpc/bind_feed_fact") &&
        r.ok
      ) {
        drop = false;
        await r.arrayBuffer();
        throw new Error("Fictitious committed binding reply lost");
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
    const previewPath = `previews/${count.opening_id}?through_at=2026-10-28T17%3A00%3A00.000Z`;
    assert.equal(
      (await call(capture, previewPath)).body.reason,
      "opening_not_linked",
    );
    const item = (kind, code) => ({
      ...scope,
      format: "tamago.feed-catalog-item",
      schema_version: 1,
      item_id: randomUUID(),
      kind,
      code,
      label: "SYN-Mismo nombre",
      unit: kind === "product" ? "BAG_40KG" : null,
      reason: "SYN-Identidad verificada",
    });
    const product = item("product", "F1"),
      location = item("location", "L1");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(director, "catalog", product)),
    );
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(results.filter((r) => !r.body.duplicate).length, 1);
    assert.equal((await call(director, "catalog", location)).status, 200);
    assert.equal(
      (await call(capture, "catalog", item("product", "DENIED"))).status,
      403,
    );
    const binding = (kind, id) => ({
      format: "tamago.feed-fact-binding",
      schema_version: 1,
      binding_id: randomUUID(),
      company_id: ids.company,
      source_kind: kind,
      source_id: id,
      product_id: product.item_id,
      location_id: location.item_id,
      reason: "SYN-Alias y ubicación revisados",
    });
    const countLink = binding("count", count.count_id);
    drop = true;
    assert.equal((await call(director, "bindings", countLink)).status, 503);
    assert.equal(
      (await call(director, "bindings", countLink)).body.duplicate,
      true,
    );
    const read = await call(capture, `bindings/count/${count.count_id}`);
    assert.equal(read.status, 200);
    assert.equal(
      read.body.binding.source_snapshot.event_payload.product_declared,
      "SYN-Alias capturado",
    );
    assert.equal(read.body.binding.event_payload.product_id, product.item_id);
    async function move(kind, q, time) {
      const e = {
        ...scope,
        schema_version: 1,
        event_id: randomUUID(),
        business_date: "2026-10-28",
        occurred_at: time,
        product_declared: "SYN-Alias capturado",
        quantity: q,
        unit: "BAG_40KG",
        physical_batch_declared: null,
        notes: null,
        ...(kind === "supply"
          ? { source_declared: null }
          : {
              format: "tamago.feed-delivery",
              location_declared: "SYN-Ubicación capturada",
              supplier_declared: null,
              delivery_reference_declared: null,
            }),
      };
      await f.rpc(
        kind === "supply" ? "record_feed_supply" : "record_feed_delivery",
        { p_event: e },
        users.capture.token,
      );
      return e;
    }
    const prior = await move("delivery", "100", "2026-10-28T10:00:00.000Z"),
      after = await move("delivery", "2.5", "2026-10-28T13:00:00.000Z"),
      supply = await move("supply", "1.25", "2026-10-28T14:00:00.000Z"),
      tie = await move("delivery", "3", "2026-10-28T12:00:00.000Z");
    const snapshot = await f.provider(
      `/rest/v1/feed_delivery_events?event_id=eq.${after.event_id}`,
    );
    const blocked = await call(capture, previewPath);
    assert.equal(blocked.body.status, "blocked");
    assert.equal(blocked.body.unmapped_count, 3);
    assert.equal(blocked.body.balance_bags, null);
    for (const [kind, e] of [
      ["delivery", after],
      ["supply", supply],
      ["delivery", tie],
    ])
      assert.equal(
        (await call(director, "bindings", binding(kind, e.event_id))).status,
        200,
      );
    let preview = await call(capture, previewPath);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.pending_tie_count, 1);
    assert.equal(preview.body.diagnostic_balance_bags, "11.25");
    assert.equal(preview.body.balance_bags, null);
    const decision = {
      format: "tamago.feed-cutoff-decision",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      opening_id: count.opening_id,
      count_id: count.count_id,
      source_kind: "delivery",
      source_id: tie.event_id,
      classification: "included_in_count",
      reason: "SYN-La recepción ya estaba en el conteo",
    };
    const decisions = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(director, "cutoff-decisions", decision),
      ),
    );
    assert.ok(decisions.every((r) => r.status === 200));
    assert.equal(decisions.filter((r) => !r.body.duplicate).length, 1);
    preview = await call(capture, previewPath);
    assert.equal(preview.body.status, "resolved");
    assert.equal(preview.body.balance_bags, "11.25");
    assert.equal(preview.body.coverage, "server_records_only");
    assert.equal(preview.body.inventory_check, "not_applied");
    assert.deepEqual(
      await f.provider(
        `/rest/v1/feed_delivery_events?event_id=eq.${after.event_id}`,
      ),
      snapshot,
    );
    assert.equal(
      (
        await call(director, "bindings", {
          ...binding("delivery", after.event_id),
          product_id: location.item_id,
        })
      ).status,
      409,
    );
    assert.equal(
      (await call(capture, "cutoff-decisions", decision)).status,
      403,
    );
    assert.equal((await call(foreign, previewPath)).status, 404);
    assert.equal((await call(foreign, "bindings", countLink)).status, 403);
    assert.equal(
      (await call(foreign, `catalog?lot_id=${ids.lot}`)).status,
      403,
    );
    // The untouched prior record remains physical evidence, not a second opening entry.
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_delivery_events?event_id=eq.${prior.event_id}`,
        )
      )[0].quantity,
      "100",
    );
    for (let i = 0; i < 25; i++)
      assert.equal(
        (await call(director, "catalog", item("product", `P${i}`))).status,
        200,
      );
    const first = await call(capture, `catalog?lot_id=${ids.lot}`),
      last = await call(capture, `catalog?lot_id=${ids.lot}&offset=25`);
    assert.equal(first.body.items.length, 25);
    assert.equal(first.body.next_offset, 25);
    assert.equal(last.body.items.length, 2);
    assert.ok(first.body.items.every((row) => !("event_payload" in row)));
    const [member] = await f.provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.director.id}`,
    );
    await f.provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${member.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    assert.equal((await call(director, "bindings", countLink)).status, 403);
  } finally {
    await f.close();
  }
});
