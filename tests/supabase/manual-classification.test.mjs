import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { startRealCustodyFixture } from "../fixtures/custody-real-server.mjs";

test("manual classification real Auth/Postgres: conservation, partial inputs, custody incidents, scope and retries", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase",
  timeout: 120000,
}, async () => {
  let loseNextClassificationResponse = false;
  const f = await startRealCustodyFixture({
    seedTransfers: false,
    gatewayFetch: async (url, options) => {
      const response = await fetch(url, options);
      if (
        new URL(url).pathname.endsWith("/rpc/record_manual_classification") &&
        response.ok &&
        loseNextClassificationResponse
      ) {
        loseNextClassificationResponse = false;
        await response.arrayBuffer();
        throw new Error("Fictitious transport: committed response discarded");
      }
      return response;
    },
  });
  const { ids, users, rpc, provider } = f;
  const cookies = {};
  async function login(role) {
    const res = await fetch(`${f.origin}/v1/auth/login`, {
      method: "POST",
      headers: { Origin: f.origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: users[role].email,
        password: users[role].password,
      }),
    });
    assert.equal(res.status, 200);
    cookies[role] = res.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
  }
  async function call(
    role,
    path,
    {
      method = "GET",
      body,
      expected = 200,
      actor = users[role]?.id,
      origin = f.origin,
    } = {},
  ) {
    const response = await fetch(
      `${f.origin}/v1/companies/${ids.company}/${path}`,
      {
        method,
        headers: {
          cookie: cookies[role] ?? "",
          Origin: origin,
          "content-type": "application/json",
          "x-tamago-user": actor ?? "",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    const data = await response.json();
    assert.equal(response.status, expected, JSON.stringify(data));
    return data;
  }
  async function transfer(sent, received, date = "2026-10-27") {
    const id = randomUUID();
    await rpc(
      "dispatch_collection_transfer",
      {
        p_transfer: {
          transfer_id: id,
          company_id: ids.company,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: ids.lot,
          origin_business_date: date,
          quantity_sent: sent,
          sent_from: "Galpón ficticio",
          sent_to: "Bodega ficticia",
          sent_at: "2026-10-27T13:00:00Z",
        },
      },
      users.capture.token,
    );
    if (received !== null)
      await rpc(
        "confirm_collection_transfer_receipt",
        {
          p_transfer_id: id,
          p_received_quantity: received,
          p_received_at_location: "Bodega ficticia",
          p_received_at: "2026-10-27T14:00:00Z",
          p_receiver_note: null,
        },
        users.warehouse.token,
      );
    return id;
  }
  const record = (inputs) => ({
    schema_version: 1,
    session_id: randomUUID(),
    company_id: ids.company,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    origin_business_date: "2026-10-27",
    classified_at: "2026-10-28T12:00:00.000Z",
    machine_configuration_reference: "Declaración ficticia sin aprobación",
    notes: null,
    inputs: inputs.map(([transfer_id, quantity_eggs]) => ({
      transfer_id,
      quantity_eggs,
    })),
    lines: [
      {
        line_id: randomUUID(),
        quantity_eggs: inputs.reduce((n, x) => n + x[1], 0),
        typology: "AA",
        condition: "NORMAL",
        destination: "PENDING",
      },
    ],
  });
  try {
    for (const role of ["warehouse", "capture", "director", "foreign"])
      await login(role);
    const a = await transfer(60, 59),
      b = await transfer(30, 29),
      c = await transfer(10, null);
    const initial = await call(
      "warehouse",
      "manual-classification-inputs?business_date=2026-10-27",
    );
    assert.equal(initial.authorized, true);
    assert.equal(initial.items.length, 2);
    assert.equal(
      initial.items.reduce((n, x) => n + x.quantity_available, 0),
      88,
    );
    const catalog = await call("warehouse", "manual-classification-catalog");
    assert.equal(catalog.catalog.automatic_weight_classification, false);
    const first = record([
      [a, 20],
      [b, 10],
    ]);
    first.lines = [
      {
        line_id: randomUUID(),
        quantity_eggs: 20,
        typology: "AA",
        condition: "NORMAL",
        destination: "PENDING",
      },
      {
        line_id: randomUUID(),
        quantity_eggs: 5,
        typology: "UNKNOWN",
        condition: "DIRTY",
        destination: "PENDING",
      },
      {
        line_id: randomUUID(),
        quantity_eggs: 5,
        typology: "PIPO",
        condition: "NORMAL",
        destination: "DISCARD",
      },
    ];
    const receipt = await call("warehouse", "manual-classifications", {
      method: "POST",
      body: first,
    });
    assert.equal(receipt.processed_quantity, 30);
    assert.equal(receipt.duplicate, false);
    assert.equal(receipt.recorded_by, users.warehouse.id);
    assert.equal(receipt.configuration_status, "declared_unverified");
    // Exact retry of a confirmed record must also return its original acknowledgment.
    const retry = await call("warehouse", "manual-classifications", {
      method: "POST",
      body: first,
    });
    assert.deepEqual({ ...retry, duplicate: false }, receipt);
    await call("warehouse", "manual-classifications", {
      method: "POST",
      body: { ...first, notes: "changed" },
      expected: 409,
    });
    await call("warehouse", "manual-classifications", {
      method: "POST",
      body: record([[a, 40]]),
      expected: 409,
    });
    await call("warehouse", "manual-classifications", {
      method: "POST",
      body: record([[c, 1]]),
      expected: 409,
    });
    await call("capture", "manual-classifications", {
      method: "POST",
      body: record([[a, 1]]),
      expected: 403,
    });
    await call("director", "manual-classifications", {
      method: "POST",
      body: record([[a, 1]]),
      expected: 403,
    });
    await call("foreign", "manual-classifications", {
      method: "POST",
      body: record([[a, 1]]),
      expected: 403,
    });
    await call("warehouse", "manual-classifications", {
      method: "POST",
      body: record([[a, 1]]),
      actor: users.capture.id,
      expected: 409,
    });
    await call("warehouse", "manual-classifications", {
      method: "POST",
      body: record([[a, 1]]),
      origin: "http://untrusted.invalid",
      expected: 403,
    });
    const detail = await call(
      "warehouse",
      `manual-classifications/${first.session_id}`,
    );
    assert.deepEqual(detail.session.event_payload, first);
    assert.equal(detail.inputs.length, 2);
    assert.equal(detail.lines.length, 3);
    assert.deepEqual(
      await call("capture", `manual-classifications/${first.session_id}`),
      detail,
    );
    await call("foreign", `manual-classifications/${first.session_id}`, {
      expected: 404,
    });
    await call("warehouse", "manual-classifications?business_date=2026-02-30", {
      expected: 400,
    });
    await call(
      "warehouse",
      "manual-classifications?business_date=2026-10-27&offset=-1",
      { expected: 400 },
    );
    const second = record([[a, 39]]);
    await call("warehouse", "manual-classifications", {
      method: "POST",
      body: second,
    });
    const inputPage = await call(
      "warehouse",
      "manual-classification-inputs?business_date=2026-10-27",
    );
    assert.equal(
      inputPage.items.reduce((n, x) => n + x.quantity_available, 0),
      19,
    );
    assert.equal(
      inputPage.items.filter((x) => x.incident_status === "open").length,
      2,
    );
    const summary = await call(
      "warehouse",
      "manual-classifications?business_date=2026-10-27",
    );
    assert.equal(summary.items.length, 2);
    assert.equal(
      summary.items.reduce((n, x) => n + x.processed_quantity, 0),
      69,
    );
    const sessions = await provider(
      `/rest/v1/manual_classification_sessions?company_id=eq.${ids.company}`,
    );
    assert.equal(sessions.length, 2);
    const events = await provider(
      `/rest/v1/collection_events?company_id=eq.${ids.company}`,
    );
    assert.equal(
      events.reduce((n, x) => n + x.quantity_eggs, 0),
      100,
    );
    const incidents = await provider(
      `/rest/v1/custody_incidents?company_id=eq.${ids.company}`,
    );
    assert.equal(incidents.length, 2);
    assert.ok(incidents.every((x) => x.status === "open"));
    // A line identity collision must roll back parent and consumption atomically.
    const bad = record([[b, 1]]);
    bad.lines[0].line_id = first.lines[0].line_id;
    await call("warehouse", "manual-classifications", {
      method: "POST",
      body: bad,
      expected: 409,
    });
    assert.equal(
      (
        await call(
          "warehouse",
          "manual-classifications?business_date=2026-10-27",
        )
      ).items.length,
      2,
    );
    assert.equal(
      (
        await call(
          "warehouse",
          "manual-classification-inputs?business_date=2026-10-27",
        )
      ).items.reduce((n, x) => n + x.quantity_available, 0),
      19,
    );
    const uncertain = record([[b, 1]]);
    loseNextClassificationResponse = true;
    await call("warehouse", "manual-classifications", {
      method: "POST",
      body: uncertain,
      expected: 503,
    });
    assert.equal(
      loseNextClassificationResponse,
      false,
      "fault must happen after the actual commit",
    );
    const recovered = await call(
      "warehouse",
      `manual-classifications/${uncertain.session_id}`,
    );
    assert.deepEqual(recovered.session.event_payload, uncertain);
    const replay = await call("warehouse", "manual-classifications", {
      method: "POST",
      body: uncertain,
    });
    assert.equal(replay.duplicate, true);
    assert.equal(replay.recorded_at, recovered.session.recorded_at);
    assert.equal(replay.recorded_by, users.warehouse.id);
    assert.equal(
      (
        await call(
          "warehouse",
          "manual-classifications?business_date=2026-10-27",
        )
      ).items.length,
      3,
    );
    assert.equal(
      (
        await call(
          "warehouse",
          "manual-classification-inputs?business_date=2026-10-27",
        )
      ).items.reduce((n, x) => n + x.quantity_available, 0),
      18,
    );
  } finally {
    await f.close();
  }
});

test("classification HTTP pagination is complete and a revoked warehouse cannot spend a previously displayed balance", {
  skip:
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST === "1" &&
    process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
      ? false
      : "Requires disposable local Supabase",
  timeout: 120000,
}, async () => {
  const f = await startRealCustodyFixture({ seedTransfers: false });
  const { ids, users, rpc, provider } = f;
  const root = `${f.origin}/v1/companies/${ids.company}`;
  async function login(role) {
    const response = await fetch(`${f.origin}/v1/auth/login`, {
      method: "POST",
      headers: { Origin: f.origin, "content-type": "application/json" },
      body: JSON.stringify({
        email: users[role].email,
        password: users[role].password,
      }),
    });
    assert.equal(response.status, 200);
    return response.headers
      .getSetCookie()
      .map((x) => x.split(";")[0])
      .join("; ");
  }
  async function request(
    path,
    cookie,
    role = "warehouse",
    body,
    expected = 200,
  ) {
    const response = await fetch(`${root}/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie,
        Origin: f.origin,
        "x-tamago-user": users[role].id,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.equal(response.status, expected, JSON.stringify(result));
    return result;
  }
  async function received(quantity) {
    const id = randomUUID();
    await rpc(
      "dispatch_collection_transfer",
      {
        p_transfer: {
          transfer_id: id,
          company_id: ids.company,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: ids.lot,
          origin_business_date: "2026-10-27",
          quantity_sent: quantity,
          sent_from: "Galpón ficticio",
          sent_to: "Bodega ficticia",
          sent_at: "2026-10-27T13:00:00Z",
        },
      },
      users.capture.token,
    );
    await rpc(
      "confirm_collection_transfer_receipt",
      {
        p_transfer_id: id,
        p_received_quantity: quantity,
        p_received_at_location: "Bodega ficticia",
        p_received_at: "2026-10-27T14:00:00Z",
        p_receiver_note: null,
      },
      users.warehouse.token,
    );
    return id;
  }
  const packet = (transfer) => ({
    schema_version: 1,
    session_id: randomUUID(),
    company_id: ids.company,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
    origin_business_date: "2026-10-27",
    classified_at: "2026-10-28T12:00:00.000Z",
    machine_configuration_reference: null,
    notes: null,
    inputs: [{ transfer_id: transfer, quantity_eggs: 1 }],
    lines: [
      {
        line_id: randomUUID(),
        quantity_eggs: 1,
        typology: "AA",
        condition: "NORMAL",
        destination: "PENDING",
      },
    ],
  });
  try {
    const cookie = await login("warehouse");
    const main = await received(40);
    for (let index = 0; index < 26; index++) {
      await received(1);
      await rpc(
        "record_manual_classification",
        { p_record: packet(main) },
        users.warehouse.token,
      );
    }
    async function pages(resource, key) {
      let offset = 0;
      const all = [];
      const sizes = [];
      for (let iteration = 0; iteration < 10; iteration++) {
        const page = await request(
          `${resource}?business_date=2026-10-27&offset=${offset}`,
          cookie,
        );
        sizes.push(page.items.length);
        all.push(...page.items);
        if (page.next_offset === null) {
          assert.equal(new Set(all.map((x) => x[key])).size, all.length);
          return { all, sizes };
        }
        assert.equal(page.next_offset, offset + 25);
        offset = page.next_offset;
      }
      throw new Error("Pagination did not terminate");
    }
    const inputs = await pages("manual-classification-inputs", "transfer_id");
    assert.deepEqual(inputs.sizes, [25, 2]);
    assert.equal(inputs.all.length, 27);
    assert.equal(
      inputs.all.reduce((n, x) => n + x.quantity_available, 0),
      40,
    );
    const sessions = await pages("manual-classifications", "session_id");
    assert.deepEqual(sessions.sizes, [25, 1]);
    assert.equal(sessions.all.length, 26);
    assert.equal(
      sessions.all.reduce((n, x) => n + x.processed_quantity, 0),
      26,
    );
    const foreign = await login("foreign");
    assert.deepEqual(
      (
        await request(
          "manual-classifications?business_date=2026-10-27",
          foreign,
          "foreign",
        )
      ).items,
      [],
    );
    const foreignInputs = await request(
      "manual-classification-inputs?business_date=2026-10-27",
      foreign,
      "foreign",
    );
    assert.equal(foreignInputs.authorized, false);
    assert.deepEqual(foreignInputs.items, []);
    const [membership] = await provider(
      `/rest/v1/company_memberships?company_id=eq.${ids.company}&user_id=eq.${users.warehouse.id}`,
    );
    await provider(
      `/rest/v1/role_assignments?company_id=eq.${ids.company}&membership_id=eq.${membership.id}`,
      { method: "PATCH", body: { revoked_at: new Date().toISOString() } },
    );
    await request(
      "manual-classifications",
      cookie,
      "warehouse",
      packet(main),
      403,
    );
    const denied = await request(
      "manual-classification-inputs?business_date=2026-10-27",
      cookie,
    );
    assert.equal(denied.authorized, false);
    assert.deepEqual(denied.items, []);
    const consumed = await provider(
      `/rest/v1/manual_classification_inputs?company_id=eq.${ids.company}`,
    );
    assert.equal(
      consumed.reduce((n, x) => n + x.quantity_eggs, 0),
      26,
    );
  } finally {
    await f.close();
  }
});
