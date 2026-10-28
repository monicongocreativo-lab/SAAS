import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { makeServer } from "../../scripts/serve.mjs";
import { createAuthPrototypeServer } from "../../src/auth-prototype/server.mjs";

export async function startRealCustodyFixture({
  seedTransfers = true,
  offlineIdentity = false,
  cleanupOffline,
  gatewayFetch = fetch,
} = {}) {
  if (offlineIdentity && typeof cleanupOffline !== "function")
    throw new Error("Offline fixture requires scoped privileged cleanup.");
  if (
    process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST !== "1" ||
    !process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
  )
    throw new Error("Explicit local Supabase test required.");
  const env = JSON.parse(
    await readFile(process.env.TAMAGO_CUSTODY_TEST_ENV_FILE, "utf8"),
  );
  const base = new URL(env.API_URL);
  if (
    base.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(base.hostname) ||
    ![
      "tamago-dev009c",
      "tamago-dev010a",
      "tamago-dev010b",
      "tamago-dev011a",
      "tamago-dev010c",
      "tamago-dev010d",
      "tamago-dev010e",
      "tamago-dev012a",
      "tamago-dev012b",
      "tamago-dev012c",
      "tamago-dev012d",
      "tamago-dev012e",
      "tamago-dev012f",
      "tamago-dev012g",
      "tamago-dev012l",
    ].includes(env.TEST_STACK)
  )
    throw new Error("Disposable DEV-009C loopback provider required.");
  const pub = env.PUBLISHABLE_KEY ?? env.ANON_KEY,
    service = env.SERVICE_ROLE_KEY;
  const ids = {
    company: randomUUID(),
    foreign: randomUUID(),
    site: randomUUID(),
    house: randomUUID(),
    lot: randomUUID(),
    transfer: randomUUID(),
  };
  const users = {},
    extra = [];
  const directory = await mkdtemp(join(tmpdir(), "tamago-custody-http-"));
  const key = randomBytes(32);
  let gateway, app;
  async function provider(
    path,
    { method = "GET", body, token = service } = {},
  ) {
    const result = await fetch(new URL(path, base), {
      method,
      headers: {
        apikey: pub,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": "application/json",
        prefer: "return=representation",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await result.json().catch(() => null);
    assert.equal(
      result.ok,
      true,
      `${path}: ${result.status} ${JSON.stringify(data)}`,
    );
    return data;
  }
  const insert = (table, body) =>
    provider(`/rest/v1/${table}`, { method: "POST", body });
  const rpc = (name, body, token) =>
    provider(`/rest/v1/rpc/${name}`, { method: "POST", body, token });
  async function close() {
    for (const server of [app, gateway])
      if (server?.listening)
        await new Promise((resolve) => server.close(resolve));
    for (const companyId of [ids.company, ids.foreign]) {
      if (offlineIdentity) await cleanupOffline(companyId);
      for (const table of [
        ...(env.TEST_STACK === "tamago-dev012l"
          ? [
              "feed_ledger_entries",
              "feed_ledger_operations",
              "feed_inventory_accounts",
            ]
          : []),
        ...(["tamago-dev012g", "tamago-dev012l"].includes(env.TEST_STACK)
          ? [
              "feed_inventory_revisions",
              "feed_cutoff_decisions",
              "feed_fact_bindings",
              "feed_catalog_items",
            ]
          : []),
        ...([
          "tamago-dev010b",
          "tamago-dev010d",
          "tamago-dev010e",
          "tamago-dev012a",
          "tamago-dev012b",
          "tamago-dev012c",
          "tamago-dev012d",
          "tamago-dev012e",
          "tamago-dev012f",
          "tamago-dev012g",
          "tamago-dev012l",
        ].includes(env.TEST_STACK)
          ? [
              "manual_classification_lines",
              "manual_classification_inputs",
              "manual_classification_sessions",
            ]
          : []),
        ...([
          "tamago-dev012b",
          "tamago-dev012c",
          "tamago-dev012d",
          "tamago-dev012e",
          "tamago-dev012f",
          "tamago-dev012g",
          "tamago-dev012l",
        ].includes(env.TEST_STACK)
          ? ["feed_supply_events"]
          : []),
        ...([
          "tamago-dev012d",
          "tamago-dev012e",
          "tamago-dev012f",
          "tamago-dev012g",
          "tamago-dev012l",
        ].includes(env.TEST_STACK)
          ? ["feed_delivery_events"]
          : []),
        ...([
          "tamago-dev012e",
          "tamago-dev012f",
          "tamago-dev012g",
          "tamago-dev012l",
        ].includes(env.TEST_STACK)
          ? ["feed_opening_approvals", "feed_opening_counts", "feed_openings"]
          : []),

        "custody_case_actions",
        "custody_incident_evidence",
        "custody_incidents",
        "collection_transfers",
        "collection_events",
        "role_assignments",
        "company_memberships",
        "lots",
        "houses",
        "sites",
      ])
        await provider(`/rest/v1/${table}?company_id=eq.${companyId}`, {
          method: "DELETE",
        });
      await provider(`/rest/v1/companies?id=eq.${companyId}`, {
        method: "DELETE",
      });
    }
    for (const user of Object.values(users))
      await provider(`/auth/v1/admin/users/${user.id}`, { method: "DELETE" });
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
  try {
    for (const role of ["capture", "warehouse", "director", "foreign"]) {
      const email = `${randomUUID()}@example.invalid`,
        password = `Ficticia-${randomUUID()}`;
      const created = await provider("/auth/v1/admin/users", {
        method: "POST",
        body: { email, password, email_confirm: true },
      });
      const auth = await provider("/auth/v1/token?grant_type=password", {
        method: "POST",
        body: { email, password },
        token: null,
      });
      users[role] = {
        id: created.id,
        email,
        password,
        token: auth.access_token,
      };
    }
    await insert("companies", [
      {
        id: ids.company,
        code: `TEST-CUSTODY-${ids.company.slice(0, 8).toUpperCase()}`,
        legal_name: "Tamago ficticio · recepción",
      },
      {
        id: ids.foreign,
        code: `TEST-FOREIGN-${ids.foreign.slice(0, 8).toUpperCase()}`,
        legal_name: "Otra empresa ficticia",
      },
    ]);
    await insert("sites", {
      id: ids.site,
      company_id: ids.company,
      code: "SYN-SITE",
      name: "Sede ficticia",
    });
    await insert("houses", {
      id: ids.house,
      company_id: ids.company,
      site_id: ids.site,
      code: "SYN-HOUSE",
      name: "Galpón ficticio",
    });
    await insert("lots", {
      id: ids.lot,
      company_id: ids.company,
      site_id: ids.site,
      house_id: ids.house,
      code: "SYN-LOTE",
      status: "active",
    });
    for (const [role, user] of Object.entries(users)) {
      const company = role === "foreign" ? ids.foreign : ids.company;
      const membership = randomUUID();
      await insert("company_memberships", {
        id: membership,
        company_id: company,
        user_id: user.id,
        status: "active",
      });
      await insert("role_assignments", {
        company_id: company,
        membership_id: membership,
        role_key: role === "foreign" ? "warehouse" : role,
        ...(role !== "foreign"
          ? { site_id: ids.site, house_id: ids.house, lot_id: ids.lot }
          : {}),
      });
    }
    await rpc(
      "receive_collection_event",
      {
        p_event: {
          schema_version: 2,
          event_id: randomUUID(),
          company_id: ids.company,
          site_id: ids.site,
          house_id: ids.house,
          lot_id: ids.lot,
          business_date: "2026-10-27",
          occurrence: 1,
          quantity_eggs: seedTransfers ? 126 : 100,
          occurred_at: "2026-10-27T12:00:00Z",
          captured_at: "2026-10-27T12:01:00Z",
          actor_declared_id: "Ficticio",
          device_id: randomUUID(),
        },
      },
      users.capture.token,
    );
    for (let index = 0; seedTransfers && index < 27; index++) {
      const id = index === 26 ? ids.transfer : randomUUID();
      if (index < 26) extra.push(id);
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
            quantity_sent: index === 26 ? 100 : 1,
            sent_from: "Galpón ficticio",
            sent_to: "Bodega ficticia",
            sent_at: "2026-10-27T13:00:00Z",
          },
        },
        users.capture.token,
      );
    }
    const listen = (server) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
    app = createServer();
    await listen(app);
    const origin = `http://localhost:${app.address().port}`;
    const issuer = offlineIdentity
      ? await generateKeyPair("ES256", { extractable: false })
      : null;
    gateway = createAuthPrototypeServer({
      apiUrl: base.href,
      restUrl: new URL("/rest/v1/", base).href,
      publishableKey: pub,
      fetchImpl: gatewayFetch,
      allowedOrigins: [origin],
      sessionDbPath: join(directory, "sessions.sqlite"),
      sessionEncryptionKey: key,
      ...(issuer
        ? {
            serviceRoleKey: service,
            offlineGrantSigningKey: issuer.privateKey,
            offlineGrantKeyId: "dev010c-fictitious",
            offlineGrantPublicJwk: await exportJWK(issuer.publicKey),
          }
        : {}),
    });
    await listen(gateway);
    const proxy = makeServer({
      authUpstream: `http://127.0.0.1:${gateway.address().port}`,
    });
    app.on("request", (req, res) => proxy.emit("request", req, res));
    return { origin, users, ids, extra, provider, rpc, close };
  } catch (error) {
    await close();
    throw error;
  }
}
