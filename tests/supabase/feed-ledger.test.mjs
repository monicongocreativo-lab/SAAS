import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("inventory real HTTP/Auth/Postgres: book activation, concurrent idempotency, pending shortages, compensation, pinned opening and monthly paging", {
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
        new URL(url).pathname.endsWith("/rpc/apply_feed_ledger") &&
        r.ok
      ) {
        drop = false;
        await r.arrayBuffer();
        throw new Error("Fictitious committed book reply lost");
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
      business_date: "2026-10-27",
      cutoff_at: "2026-10-27T12:00:00.000Z",
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

    const time = "2026-10-27T17:00:00.000Z";
    const item = (code) => ({
      format: "tamago.feed-catalog-item",
      schema_version: 1,
      item_id: randomUUID(),
      ...scope,
      kind: "product",
      code,
      label: `SYN-${code}`,
      unit: "BAG_40KG",
      reason: "SYN-Libro",
    });
    const p1 = item("F1"),
      p2 = item("F2"),
      loc = { ...item("L1"), kind: "location", unit: null };
    for (const e of [p1, p2, loc])
      assert.equal((await call(director, "catalog", e)).status, 200);
    const bind = (kind, id, product = p1.item_id) => ({
      format: "tamago.feed-fact-binding",
      schema_version: 1,
      binding_id: randomUUID(),
      company_id: ids.company,
      source_kind: kind,
      source_id: id,
      product_id: product,
      location_id: loc.item_id,
      reason: "SYN-Vínculo",
    });
    const countMap = bind("count", count.count_id);
    await call(director, "bindings", countMap);
    async function move(
      kind,
      q,
      clock = "13:00:00",
      date = "2026-10-27",
      product = p1.item_id,
    ) {
      const e = {
        ...scope,
        schema_version: 1,
        event_id: randomUUID(),
        business_date: date,
        occurred_at: `${date}T${clock}.000Z`,
        product_declared: "SYN-Fuente",
        quantity: q,
        unit: "BAG_40KG",
        physical_batch_declared: null,
        notes: null,
        ...(kind === "delivery"
          ? {
              format: "tamago.feed-delivery",
              location_declared: "SYN-L1",
              supplier_declared: null,
              delivery_reference_declared: null,
            }
          : { source_declared: null }),
      };
      await f.rpc(
        kind === "delivery" ? "record_feed_delivery" : "record_feed_supply",
        { p_event: e },
        users.capture.token,
      );
      const mapping = bind(kind, e.event_id, product);
      assert.equal((await call(director, "bindings", mapping)).status, 200);
      return { e, mapping };
    }
    const incoming = await move("delivery", "3");
    const path = (opening = count.opening_id, t = time, offset = 0) =>
      `ledger-review/${opening}?through_at=${encodeURIComponent(t)}&offset=${offset}`;
    let r = await call(director, path());
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "needs_activation");
    assert.equal(r.body.proposed_balance_bags, "13");
    assert.equal((await call(capture, path())).body.can_activate, false);
    const activation = {
      format: "tamago.feed-inventory-activation",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      opening_id: count.opening_id,
      through_at: time,
      review_token: r.body.review_token,
      reason: "SYN-Apertura efectiva",
    };
    assert.equal(
      (await call(capture, "ledger-activate", activation)).status,
      403,
    );
    const other = { ...activation, action_id: randomUUID() };
    drop = true;
    const initial = await Promise.all([
      call(director, "ledger-activate", activation),
      call(director, "ledger-activate", other),
    ]);
    assert.deepEqual(initial.map((x) => x.status).sort(), [409, 503]);
    const [account] = await f.provider(
      `/rest/v1/feed_inventory_accounts?company_id=eq.${ids.company}`,
    );
    const accepted = [activation, other].find(
      (e) => e.action_id === account.account_id,
    );
    r = await call(director, `ledger-actions/${accepted.action_id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.duplicate, true);
    assert.deepEqual(r.body.event, accepted);
    assert.equal(
      (await call(director, "ledger-activate", accepted)).body.duplicate,
      true,
    );
    assert.equal((await call(director, path())).body.available_bags, "13");
    assert.equal((await call(foreign, path())).status, 404);
    assert.equal(
      (await call(foreign, `ledger-actions/${accepted.action_id}`)).status,
      404,
    );
    const source = await move("supply", "1.25", "14:00:00");
    r = await call(director, path());
    assert.equal(r.body.status, "pending");
    assert.equal(r.body.book_balance_bags, "13");
    assert.equal(r.body.available_bags, null);
    const posting = (v) => ({
      format: "tamago.feed-inventory-posting",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      account_id: account.account_id,
      expected_revision: v.revision,
      through_at: time,
      review_token: v.review_token,
      reason: "SYN-Conjunto revisado",
    });
    const post = posting(r.body);
    const copies = await Promise.all(
      Array.from({ length: 5 }, () => call(director, "ledger-post", post)),
    );
    assert.equal(
      copies.filter((x) => x.status === 200 && !x.body.duplicate).length,
      1,
    );
    assert.equal(
      copies.filter((x) => x.status === 200 && x.body.duplicate).length,
      4,
    );
    assert.equal((await call(director, path())).body.available_bags, "11.75");
    const _a = await move("supply", "0.5", "14:30:00");
    r = await call(director, path());
    const stale = posting(r.body);
    await move("delivery", "2", "15:00:00");
    assert.equal((await call(director, "ledger-post", stale)).status, 409);
    assert.equal(
      (await call(director, `ledger-actions/${stale.action_id}`)).status,
      404,
    );
    r = await call(director, path());
    assert.equal(
      (await call(director, "ledger-post", posting(r.body))).body.balance_bags,
      "13.25",
    );
    const large = await move("supply", "100", "16:00:00");
    r = await call(director, path());
    assert.equal(r.body.status, "insufficient");
    assert.equal(r.body.book_balance_bags, "13.25");
    assert.equal(r.body.proposed_balance_bags, "-86.75");
    assert.equal(
      (await call(director, "ledger-post", posting(r.body))).status,
      409,
    );
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_supply_events?event_id=eq.${large.e.event_id}`,
        )
      ).length,
      1,
    );
    await move("delivery", "100", "16:30:00");
    r = await call(director, path());
    assert.equal(
      (await call(director, "ledger-post", posting(r.body))).body.balance_bags,
      "13.25",
    );
    const correction = {
      format: "tamago.feed-inventory-correction",
      schema_version: 1,
      revision_id: randomUUID(),
      company_id: ids.company,
      target_kind: "binding",
      target_id: incoming.mapping.binding_id,
      expected_revision: 0,
      previous_revision_id: null,
      product_id: p2.item_id,
      location_id: loc.item_id,
      reason: "SYN-Corrección auditada",
    };
    assert.equal((await call(director, "corrections", correction)).status, 200);
    r = await call(director, path());
    assert.equal(r.body.book_balance_bags, "13.25");
    assert.equal(r.body.proposed_balance_bags, "10.25");
    assert.equal(
      (await call(director, "ledger-post", posting(r.body))).body.balance_bags,
      "10.25",
    );
    const history = await call(
      capture,
      `ledger-entries/${account.account_id}?offset=0`,
    );
    assert.equal(history.status, 200);
    assert.equal(history.body.book_balance_bags, "10.25");
    assert.equal(
      history.body.items.filter((e) => e.source_id === incoming.e.event_id)
        .length,
      2,
    );
    assert.ok(
      history.body.items.every(
        (e) => typeof e.delta === "string" && e.operation_payload.reason,
      ),
    );
    assert.equal(
      (await call(director, "ledger-activate", accepted)).body.balance_bags,
      "13",
    );
    assert.equal(
      (await call(director, path())).body.book_balance_bags,
      "10.25",
    );
    const changeOpening = {
      ...correction,
      revision_id: randomUUID(),
      target_id: countMap.binding_id,
      reason: "SYN-Identidad del conteo",
    };
    await call(director, "corrections", changeOpening);
    r = await call(director, path());
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "opening_changed");
    assert.equal(r.body.available_bags, null);
    assert.equal(
      (await call(director, "ledger-post", posting(r.body))).status,
      409,
    );
    // Complete month and real response validation with paginated review/entries.
    const mp = item("MONTH");
    await call(director, "catalog", mp);
    const mc = {
      ...count,
      opening_id: randomUUID(),
      count_id: randomUUID(),
      business_date: "2026-09-01",
      cutoff_at: "2026-09-01T12:00:00.000Z",
      quantity: "10",
    };
    await f.rpc(
      "record_feed_opening_count",
      { p_event: mc },
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
          opening_id: mc.opening_id,
          count_id: mc.count_id,
          expected_revision: 1,
          reason: "SYN-Mes",
        },
      },
      users.director.token,
    );
    await call(director, "bindings", bind("count", mc.count_id, mp.item_id));
    for (let n = 1; n <= 30; n++)
      await move(
        "supply",
        "0.25",
        "14:00:00",
        `2026-09-${String(n).padStart(2, "0")}`,
        mp.item_id,
      );
    const mt = "2026-09-30T23:00:00.000Z",
      page1 = await call(director, path(mc.opening_id, mt)),
      page2 = await call(director, path(mc.opening_id, mt, 25));
    assert.equal(page1.status, 200);
    assert.equal(page1.body.items.length, 25);
    assert.equal(page1.body.next_offset, 25);
    assert.equal(page2.status, 200);
    assert.equal(page2.body.items.length, 5);
    assert.equal(page2.body.review_token, page1.body.review_token);
    assert.equal(page1.body.proposed_balance_bags, "2.5");
    const ma = {
      ...activation,
      action_id: randomUUID(),
      opening_id: mc.opening_id,
      through_at: mt,
      review_token: page1.body.review_token,
    };
    assert.equal(
      (await call(director, "ledger-activate", ma)).body.balance_bags,
      "2.5",
    );
    const hp1 = await call(capture, `ledger-entries/${ma.action_id}`),
      hp2 = await call(capture, `ledger-entries/${ma.action_id}?offset=25`);
    assert.equal(hp1.status, 200);
    assert.equal(hp1.body.items.length, 25);
    assert.equal(hp2.body.items.length, 6);
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_delivery_events?event_id=eq.${incoming.e.event_id}`,
        )
      )[0].event_payload.quantity,
      "3",
    );
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_supply_events?event_id=eq.${source.e.event_id}`,
        )
      )[0].event_payload.quantity,
      "1.25",
    );
    const [membership] = await f.provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.director.id}`,
    );
    await f.provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${membership.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    assert.equal(
      (await call(director, "ledger-activate", accepted)).status,
      403,
    );
    assert.equal((await call(director, path())).status, 404);
  } catch (error) {
    console.error("Ledger test assertion:", error.message);
    throw error;
  } finally {
    await f.close();
  }
});
