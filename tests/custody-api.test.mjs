import assert from "node:assert/strict";
import { test } from "node:test";
import { custodyApi } from "../src/auth-prototype/custody-api.mjs";

const company = "11111111-1111-4111-8111-111111111111";
const transfer = "22222222-2222-4222-8222-222222222222";
const base = {
  companyId: company,
  accessToken: "synthetic-user-token",
  publishableKey: "synthetic-public",
  restBase: new URL("http://localhost/rest/v1/"),
};
const result = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
test("custody API binds the company before writes and preserves explicit zero receipt", async () => {
  let calls = 0;
  const mismatch = await custodyApi({
    ...base,
    url: new URL(
      `http://localhost/v1/companies/${company}/custody-case-actions`,
    ),
    method: "POST",
    body: { company_id: transfer },
    fetchImpl: async () => {
      calls++;
      throw new Error("must not send");
    },
  });
  assert.equal(mismatch.status, 400);
  assert.equal(calls, 0);
  const response = await custodyApi({
    ...base,
    url: new URL(
      `http://localhost/v1/companies/${company}/custody-transfers/${transfer}/receipt`,
    ),
    method: "POST",
    body: {
      received_quantity: 0,
      received_at_location: "Bodega",
      received_at: "2026-10-27T12:00:00Z",
      receiver_note: null,
    },
    fetchImpl: async (url, options) => {
      assert.equal(
        options.headers.authorization,
        "Bearer synthetic-user-token",
      );
      if (url.pathname.endsWith("get_collection_transfer_context"))
        return result(200, { transfer: { transfer_id: transfer } });
      const body = JSON.parse(options.body);
      assert.equal(body.p_received_quantity, 0);
      assert.equal(body.p_received_at, "2026-10-27T12:00:00Z");
      assert.equal("actor_id" in body, false);
      return result(200, { status: "received" });
    },
  });
  assert.equal(response.status, 200);
});
test("custody API distinguishes invalid SQL dates from uncertain provider failures", async () => {
  const request = {
    ...base,
    url: new URL(
      `http://localhost/v1/companies/${company}/custody-transfers/${transfer}/receipt`,
    ),
    method: "POST",
    body: {
      received_quantity: 1,
      received_at_location: "Bodega",
      received_at: "2026-02-31T12:00:00Z",
      receiver_note: null,
    },
  };
  const invalid = await custodyApi({
    ...request,
    fetchImpl: async (url) =>
      url.pathname.endsWith("get_collection_transfer_context")
        ? result(200, {})
        : result(400, { code: "22008" }),
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error, "INVALID_CUSTODY_REQUEST");
  const uncertain = await custodyApi({
    ...request,
    fetchImpl: async () => {
      throw new Error("synthetic response loss");
    },
  });
  assert.equal(uncertain.status, 503);
  assert.equal(uncertain.body.error, "CUSTODY_UNAVAILABLE");
});
