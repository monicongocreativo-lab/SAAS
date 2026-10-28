import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

const enabled =
  process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
  process.env.TAMAGO_CUSTODY_TEST_ENV_FILE;
test("feed delivery / real HTTP Auth/Postgres: exact concurrent retries, lost acknowledgment recovery, scopes and pagination", {
  skip: enabled ? false : "Requires disposable local Supabase",
  timeout: 120000,
}, async () => {
  let discardNextCommittedReply = false;
  const f = await startRealCustodyFixture({
    seedTransfers: false,
    gatewayFetch: async (url, options) => {
      const response = await fetch(url, options);
      if (
        discardNextCommittedReply &&
        new URL(url).pathname.endsWith("/rpc/record_feed_delivery") &&
        response.ok
      ) {
        discardNextCommittedReply = false;
        await response.arrayBuffer();
        throw new Error(
          "Fictitious transport failure after committed delivery",
        );
      }
      return response;
    },
  });
  const { ids, users } = f;
  try {
    async function login(role) {
      const response = await fetch(`${f.origin}/v1/auth/login`, {
        method: "POST",
        headers: { origin: f.origin, "content-type": "application/json" },
        body: JSON.stringify({
          email: users[role].email,
          password: users[role].password,
        }),
      });
      assert.equal(response.status, 200);
      const cookies = response.headers
        .getSetCookie()
        .map((x) => x.split(";")[0])
        .join("; ");
      assert.ok(cookies.includes("__Host-tamago_dev_session="));
      return { cookie: cookies, role };
    }
    const capture = await login("capture");
    const event = (quantity = "12.5") => ({
      format: "tamago.feed-delivery",
      schema_version: 1,
      event_id: randomUUID(),
      company_id: ids.company,
      site_id: ids.site,
      house_id: ids.house,
      lot_id: ids.lot,
      business_date: "2026-10-28",
      occurred_at: "2026-10-28T12:00:00.000Z",
      product_declared: "SYN-Fórmula",
      quantity,
      unit: "BAG_40KG",
      location_declared: "SYN-Bodega galpón",
      supplier_declared: null,
      delivery_reference_declared: null,
      physical_batch_declared: null,
      notes: null,
    });
    async function call(
      session,
      tail = "",
      body,
      company = ids.company,
      override = {},
    ) {
      const response = await fetch(
        `${f.origin}/v1/companies/${company}/feed-deliveries${tail}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            cookie: session.cookie,
            "x-tamago-user": users[session.role].id,
            origin: f.origin,
            "content-type": "application/json",
            ...override,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      );
      return { status: response.status, body: await response.json() };
    }
    const sentinel = {
      schema_version: 1,
      event_id: randomUUID(),
      company_id: ids.company,
      site_id: ids.site,
      house_id: ids.house,
      lot_id: ids.lot,
      business_date: "2026-10-28",
      occurred_at: "2026-10-28T12:00:00.000Z",
      product_declared: "SYN-Fórmula",
      quantity: "4.25",
      unit: "BAG_40KG",
      source_declared: null,
      physical_batch_declared: null,
      notes: null,
    };
    await f.rpc(
      "record_feed_supply",
      { p_event: sentinel },
      users.capture.token,
    );
    const beforeSupply = await f.provider(
      `/rest/v1/feed_supply_events?company_id=eq.${ids.company}`,
    );
    const e = event();
    const concurrent = await Promise.all(
      Array.from({ length: 6 }, () => call(capture, "", e)),
    );
    for (const r of concurrent) {
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.event, e);
      assert.equal(r.body.inventory_check, "not_evaluated");
    }
    assert.equal(concurrent.filter((r) => !r.body.duplicate).length, 1);
    assert.equal(
      (
        await f.provider(
          `/rest/v1/feed_delivery_events?company_id=eq.${ids.company}`,
        )
      ).length,
      1,
    );
    const lost = event("0.125");
    discardNextCommittedReply = true;
    assert.equal((await call(capture, "", lost)).status, 503); // SQL committed; gateway cannot deliver its acknowledgment.
    const recovered = await call(capture, "", lost);
    assert.equal(recovered.body.duplicate, true);
    const reopened = await login("capture");
    const exact = await call(reopened, `/${lost.event_id}`);
    assert.deepEqual(exact.body.event, lost);
    assert.equal(exact.body.recorded_at, recovered.body.recorded_at);
    assert.equal(
      (await call(capture, "", { ...e, quantity: "5" })).status,
      409,
    );
    assert.equal(
      (await call(capture, "", { ...event(), recorded_by: users.capture.id }))
        .status,
      400,
    );
    assert.equal(
      (
        await call(capture, "", event(), ids.company, {
          "x-tamago-user": users.director.id,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await call(capture, "", event(), ids.company, {
          origin: "https://untrusted.invalid",
        })
      ).status,
      403,
    );
    const collision = event("1");
    const competing = await Promise.all([
      call(capture, "", collision),
      call(capture, "", { ...collision, quantity: "2" }),
    ]);
    assert.deepEqual(competing.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await call(capture, "", event("0"))).status, 400);
    const zero = event("12.5");
    assert.equal((await call(capture, "", zero)).status, 200);
    assert.equal(
      (await call(capture, "?business_date=2026-10-27")).body.items.length,
      0,
    );
    const director = await login("director");
    assert.equal((await call(director, `/${e.event_id}`)).status, 200);
    assert.equal((await call(director, "", event())).status, 403);
    const warehouse = await login("warehouse");
    assert.equal((await call(warehouse, `/${e.event_id}`)).status, 404);
    assert.equal((await call(warehouse, "", event())).status, 403);
    const foreign = await login("foreign");
    assert.equal((await call(foreign, `/${e.event_id}`)).status, 404);
    assert.equal((await call(foreign, "", e)).status, 403);
    for (let i = 0; i < 23; i++)
      assert.equal((await call(capture, "", event("1"))).status, 200);
    const first = await call(capture, "?business_date=2026-10-28"),
      last = await call(capture, "?business_date=2026-10-28&offset=25");
    assert.equal(first.body.items.length, 25);
    assert.equal(first.body.next_offset, 25);
    assert.equal(last.body.items.length, 2);
    assert.equal(last.body.next_offset, null);
    assert.equal(
      new Set(
        [...first.body.items, ...last.body.items].map((r) => r.event.event_id),
      ).size,
      27,
    );
    assert.deepEqual(
      await f.provider(
        `/rest/v1/feed_supply_events?company_id=eq.${ids.company}`,
      ),
      beforeSupply,
    );
    assert.equal((await call(capture, "", sentinel)).status, 400);
    await f.provider(
      `/rest/v1/lots?id=eq.${ids.lot}&company_id=eq.${ids.company}`,
      { method: "PATCH", body: { status: "closed" } },
    );
    assert.equal((await call(capture, "", e)).body.duplicate, true);
    assert.equal((await call(capture, "", event())).status, 403);
    const [membership] = await f.provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.capture.id}`,
    );
    await f.provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${membership.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    assert.equal((await call(capture, "", e)).status, 403);
    assert.equal((await call(capture, `/${e.event_id}`)).status, 404);
  } finally {
    await f.close();
  }
});
