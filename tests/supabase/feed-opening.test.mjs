import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("opening real HTTP/Auth/Postgres: immutable versions, stale approval, lost reply, concurrent count/approval and isolation", {
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
        new URL(url).pathname.endsWith("/rpc/approve_feed_opening") &&
        r.ok
      ) {
        drop = false;
        await r.arrayBuffer();
        throw new Error("Fictitious lost committed approval");
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
      const r = await fetch(`${f.origin}/v1/companies/${ids.company}/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          cookie: s.cookie,
          "x-tamago-user": users[s.role].id,
          origin: f.origin,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: await r.json() };
    }
    const capture = await login("capture"),
      director = await login("director"),
      foreign = await login("foreign");
    const count = () => ({
      format: "tamago.feed-opening-count",
      schema_version: 1,
      opening_id: randomUUID(),
      count_id: randomUUID(),
      company_id: ids.company,
      site_id: ids.site,
      house_id: ids.house,
      lot_id: ids.lot,
      business_date: "2026-10-28",
      cutoff_at: "2026-10-28T12:00:00.000Z",
      product_declared: "SYN-Fórmula",
      location_declared: "SYN-Bodega",
      quantity: "0",
      unit: "BAG_40KG",
      evidence_reference: "SYN-Acta conteo",
      notes: null,
      expected_revision: 0,
      previous_count_id: null,
    });
    const approve = (c) => ({
      format: "tamago.feed-opening-approval",
      schema_version: 1,
      action_id: randomUUID(),
      company_id: ids.company,
      opening_id: c.opening_id,
      count_id: c.count_id,
      expected_revision: c.expected_revision + 1,
      reason: "SYN-Acta revisada",
    });
    const c1 = count();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => call(capture, "feed-opening-counts", c1)),
    );
    assert.equal(
      results.filter((r) => r.status === 200 && !r.body.duplicate).length,
      1,
    );
    assert.ok(results.every((r) => r.status === 200));
    const c2 = {
      ...c1,
      count_id: randomUUID(),
      previous_count_id: c1.count_id,
      expected_revision: 1,
      quantity: "12.5",
      evidence_reference: "SYN-Recuento",
    };
    assert.equal((await call(capture, "feed-opening-counts", c2)).status, 200);
    assert.equal(
      (await call(director, "feed-opening-approvals", approve(c1))).status,
      409,
    );
    assert.equal(
      (await call(capture, "feed-opening-approvals", approve(c2))).status,
      403,
    );
    const command = approve(c2);
    drop = true;
    assert.equal(
      (await call(director, "feed-opening-approvals", command)).status,
      503,
    );
    const retry = await call(director, "feed-opening-approvals", command);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.duplicate, true);
    assert.equal(retry.body.inventory_check, "not_applied");
    const fresh = await login("director");
    const detail = await call(fresh, `feed-openings/${c1.opening_id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.inventory_check, "not_applied");
    assert.equal(detail.body.opening.status, "approved");
    assert.equal(detail.body.counts.length, 2);
    assert.equal(detail.body.counts[1].event_payload.quantity, "0");
    assert.equal(detail.body.approval.event_payload.count_id, c2.count_id);
    assert.equal(
      (
        await call(capture, "feed-opening-counts", {
          ...c2,
          count_id: randomUUID(),
          expected_revision: 2,
          previous_count_id: c2.count_id,
        })
      ).status,
      409,
    );
    assert.equal(
      (await call(foreign, `feed-openings/${c1.opening_id}`)).status,
      404,
    );
    assert.equal(
      (await call(foreign, "feed-opening-approvals", command)).status,
      403,
    );
    // A simultaneous new count and approval must serialize to one valid outcome.
    const race = count();
    assert.equal(
      (await call(capture, "feed-opening-counts", race)).status,
      200,
    );
    const next = {
      ...race,
      count_id: randomUUID(),
      previous_count_id: race.count_id,
      expected_revision: 1,
      quantity: "1",
    };
    const raced = await Promise.all([
      call(capture, "feed-opening-counts", next),
      call(director, "feed-opening-approvals", approve(race)),
    ]);
    assert.deepEqual(raced.map((r) => r.status).sort(), [200, 409]);
    const after = (await call(director, `feed-openings/${race.opening_id}`))
      .body;
    if (after.opening.status === "approved") {
      assert.equal(after.opening.current_revision, 1);
      assert.equal(after.approval.event_payload.count_id, race.count_id);
    } else {
      assert.equal(after.opening.current_revision, 2);
      assert.equal(after.approval, null);
    }
    // History pages preserve immutable revisions, including zero.
    let pageCount = count();
    assert.equal(
      (await call(capture, "feed-opening-counts", pageCount)).status,
      200,
    );
    for (let revision = 1; revision < 27; revision++) {
      pageCount = {
        ...pageCount,
        previous_count_id: pageCount.count_id,
        count_id: randomUUID(),
        expected_revision: revision,
        quantity: String(revision),
      };
      assert.equal(
        (await call(capture, "feed-opening-counts", pageCount)).status,
        200,
      );
    }
    const first = await call(director, `feed-openings/${pageCount.opening_id}`),
      last = await call(
        director,
        `feed-openings/${pageCount.opening_id}?offset=25`,
      );
    assert.equal(first.body.counts.length, 25);
    assert.equal(first.body.next_offset, 25);
    assert.equal(last.body.counts.length, 2);
    assert.equal(last.body.next_offset, null);
    assert.equal(
      new Set(
        [...first.body.counts, ...last.body.counts].map((c) => c.revision),
      ).size,
      27,
    );
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_supply_events?company_id=eq.${ids.company}`,
        )
      ).length,
      0,
    );
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_delivery_events?company_id=eq.${ids.company}`,
        )
      ).length,
      0,
    );
    await f.provider(`/rest/v1/lots?id=eq.${ids.lot}`, {
      method: "PATCH",
      body: { status: "closed" },
    });
    const closedRecount = {
      ...pageCount,
      count_id: randomUUID(),
      previous_count_id: pageCount.count_id,
      expected_revision: 27,
    };
    assert.equal(
      (await call(capture, "feed-opening-counts", closedRecount)).status,
      403,
    );
    assert.equal(
      (await call(capture, "feed-opening-counts", pageCount)).body.duplicate,
      true,
    );
    const [member] = await f.provider(
      "/rest/v1/company_memberships?company_id=eq." +
        ids.company +
        "&user_id=eq." +
        users.director.id,
    );
    await f.provider(
      "/rest/v1/role_assignments?company_id=eq." +
        ids.company +
        "&membership_id=eq." +
        member.id,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    assert.equal(
      (await call(director, "feed-opening-approvals", command)).status,
      403,
    );
    assert.equal(
      (await call(director, `feed-openings/${c1.opening_id}`)).status,
      404,
    );
  } finally {
    await f.close();
  }
});
