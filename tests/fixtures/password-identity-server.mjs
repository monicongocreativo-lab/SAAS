import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair } from "jose";
import { makeServer } from "../../scripts/serve.mjs";
import { createAuthPrototypeServer } from "../../src/auth-prototype/server.mjs";

export const fixtureIds = {
  company: "11111111-1111-4111-8111-111111111111",
  site: "22222222-2222-4222-8222-222222222222",
  house: "33333333-3333-4333-8333-333333333333",
  lot: "44444444-4444-4444-8444-444444444444",
};
export const fixtureUsers = [
  {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "a@example.invalid",
    password: "Ficticia-personal-A-2026",
  },
  {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    email: "b@example.invalid",
    password: "Ficticia-personal-B-2026",
  },
];
const listen = (server) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// Auth and RPC are explicit stubs; HTTP gateway, encrypted sessions, request
// proofs, grant signatures and browser storage run their real implementations.
export async function startPasswordIdentityFixture({
  hostname = "localhost",
} = {}) {
  if (!["localhost", "127.0.0.1"].includes(hostname))
    throw new Error("FIXTURE_LOOPBACK_ONLY");
  const directory = await mkdtemp(
    join(tmpdir(), "tamago-password-identity-http-"),
  );
  const app = createServer();
  await listen(app);
  const origin = `http://${hostname}:${app.address().port}`;
  const issuer = await generateKeyPair("ES256", { extractable: false });
  const state = {
    offset: 0,
    get now() {
      return Date.now() + this.offset;
    },
    set now(value) {
      this.offset = value - Date.now();
    },
    pending: false,
    mismatch: false,
    deny: false,
    hold: null,
    providerEmails: [],
    grants: new Map(),
    receipts: new Map(),
    quarantines: new Map(),
    registryStatus: "registry_current_unverified",
  };
  const company = {
    id: fixtureIds.company,
    code: "SYN-TAMAGO",
    legal_name: "Empresa ficticia",
    status: "active",
  };
  const key = randomBytes(32);
  const gateway = createAuthPrototypeServer({
    apiUrl: "http://127.0.0.1:54321",
    restUrl: "http://127.0.0.1:54321/rest/v1",
    publishableKey: "synthetic-publishable",
    serviceRoleKey: "synthetic-service-role-local-fixture",
    allowedOrigins: [origin],
    sessionDbPath: join(directory, "sessions.sqlite"),
    sessionEncryptionKey: key,
    now: () => state.now,
    offlineGrantSigningKey: issuer.privateKey,
    offlineGrantKeyId: "synthetic-password-issuer",
    offlineGrantPublicJwk: await exportJWK(issuer.publicKey),
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input);
      const actor = fixtureUsers.find(
        (user) => init.headers?.authorization === `Bearer access-${user.id}`,
      );
      const userBody = (user) => ({
        id: user.id,
        email: user.email,
        app_metadata: state.pending
          ? { tamago_initial_access_state: "pending" }
          : {},
      });
      if (url.pathname === "/auth/v1/token") {
        const credentials = JSON.parse(init.body);
        state.providerEmails.push(credentials.email);
        const user = fixtureUsers.find(
          (item) =>
            item.email === credentials.email &&
            item.password === credentials.password,
        );
        if (!user) return json(400, { error: "invalid_grant" });
        if (state.hold) await state.hold();
        return json(200, {
          access_token: `access-${user.id}`,
          refresh_token: `refresh-${user.id}`,
          expires_in: 3600,
          user: userBody(state.mismatch ? fixtureUsers[1] : user),
        });
      }
      if (url.pathname === "/auth/v1/user")
        return actor ? json(200, userBody(actor)) : json(401, {});
      if (url.pathname === "/auth/v1/logout") return json(200, {});
      if (url.pathname === "/rest/v1/companies")
        return json(200, actor ? [company] : []);
      if (url.pathname === "/rest/v1/sites")
        return json(200, [
          {
            id: fixtureIds.site,
            code: "SEDE-A",
            name: "Sede de prueba",
            status: "active",
          },
        ]);
      if (url.pathname === "/rest/v1/houses")
        return json(200, [
          {
            id: fixtureIds.house,
            site_id: fixtureIds.site,
            code: "GALPON-A",
            name: "Galpón de prueba",
            status: "active",
          },
        ]);
      if (url.pathname === "/rest/v1/lots")
        return json(200, [
          {
            id: fixtureIds.lot,
            site_id: fixtureIds.site,
            house_id: fixtureIds.house,
            code: "LOTE-A",
            status: "active",
          },
        ]);
      if (url.pathname === "/rest/v1/rpc/register_offline_capture_grant_v2") {
        const body = JSON.parse(init.body);
        if (
          !actor ||
          state.deny ||
          body.p_company_id !== fixtureIds.company ||
          body.p_site_id !== fixtureIds.site ||
          body.p_house_id !== fixtureIds.house ||
          body.p_lot_id !== fixtureIds.lot
        )
          return json(403, { code: "42501" });
        const previous = state.grants.get(body.p_request_id);
        if (previous) return json(200, previous);
        const row = {
          grant_id: randomUUID(),
          subject_user_id: actor.id,
          company_id: body.p_company_id,
          device_id: body.p_device_id,
          site_id: body.p_site_id,
          house_id: body.p_house_id,
          lot_id: body.p_lot_id,
          permission: "collection.capture",
          device_key_thumbprint: body.p_device_key_thumbprint,
          issued_at: new Date(state.now).toISOString(),
          not_before: new Date(state.now).toISOString(),
          expires_at: new Date(state.now + 86_400_000).toISOString(),
          registry_status: "registered",
          signed_capability_issued: false,
        };
        state.grants.set(body.p_request_id, row);
        return json(200, row);
      }
      if (url.pathname === "/rest/v1/rpc/resolve_offline_capture_grant_v2") {
        const body = JSON.parse(init.body);
        const row = [...state.grants.values()].find(
          (item) => item.grant_id === body.p_grant_id,
        );
        if (
          !actor ||
          !row ||
          actor.id !== row.subject_user_id ||
          row.company_id !== body.p_company_id
        )
          return json(403, { code: "42501" });
        return json(200, {
          ...row,
          registry_status: state.registryStatus,
          expires_at:
            state.registryStatus === "expired"
              ? new Date(state.now - 1000).toISOString()
              : row.expires_at,
        });
      }
      if (
        [
          "/rest/v1/rpc/receive_offline_collection_event",
          "/rest/v1/rpc/quarantine_offline_collection_event",
        ].includes(url.pathname)
      ) {
        const body = JSON.parse(init.body);
        const quarantine = url.pathname.includes("quarantine");
        const rows = quarantine ? state.quarantines : state.receipts;
        const previous = rows.get(body.p_event.event_id);
        if (previous) {
          if (JSON.stringify(previous.body) !== JSON.stringify(body))
            return json(400, { code: "22023" });
          return json(200, { ...previous.receipt, duplicate: true });
        }
        const receipt = {
          event_id: body.p_event.event_id,
          receipt_status: "received",
          review_status: quarantine ? "review_required" : "pending",
          received_at: new Date(state.now).toISOString(),
          duplicate: false,
          ...(quarantine
            ? {
                registry_status: body.p_grant_status,
                proof_status: body.p_proof_status,
                quarantine_reason: body.p_quarantine_reason,
              }
            : {
                identity_status: "verified",
                capture_subject_id: body.p_subject_user_id,
                grant_id: body.p_grant_id,
                synchronization_user_id: body.p_received_by_user_id,
              }),
        };
        rows.set(body.p_event.event_id, { body, receipt });
        return json(200, receipt);
      }
      throw new Error(`UNEXPECTED_FIXTURE_REQUEST:${url.pathname}`);
    },
  });
  await listen(gateway);
  const gatewayUrl = `http://127.0.0.1:${gateway.address().port}`;
  const proxy = makeServer({ authUpstream: gatewayUrl });
  app.on("request", (request, response) =>
    proxy.emit("request", request, response),
  );
  return {
    origin,
    gatewayUrl,
    state,
    async close() {
      await new Promise((resolve) => app.close(resolve));
      await new Promise((resolve) => gateway.close(resolve));
      key.fill(0);
      await rm(directory, { recursive: true, force: true });
    },
  };
}
