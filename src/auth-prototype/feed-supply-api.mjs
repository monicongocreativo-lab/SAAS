import {
  validateFeedReceipt,
  validateFeedSupply,
} from "../shared/feed-supply-contract.mjs";
import { validOriginDate } from "./transfer-contract.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function feedSupplyApi({
  url,
  method,
  body,
  companyId,
  userId,
  accessToken,
  restBase,
  publishableKey,
  fetchImpl,
}) {
  const send = (status, body) => ({ status, body });
  const fail = (code) => {
    throw Object.assign(new Error(code), { code });
  };
  const headers = {
    apikey: publishableKey,
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
  async function call(target, payload) {
    const response = await fetchImpl(target, {
      headers,
      ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      fail(response.status === 401 ? "42501" : (error.code ?? "UNAVAILABLE"));
    }
    return response.json();
  }
  try {
    if (url.pathname.endsWith("/feed-supply-context")) {
      if (method !== "GET") return send(405, { error: "METHOD_NOT_ALLOWED" });
      if (url.search) fail("22023");
      const scope = await call(new URL("rpc/get_feed_supply_scope", restBase), {
        p_company_id: companyId,
      });
      if (
        scope?.company_id !== companyId ||
        !Array.isArray(scope.lots) ||
        scope.lots.some(
          (row) =>
            !uuid.test(row?.lot_id ?? "") ||
            typeof row.can_record !== "boolean",
        ) ||
        new Set(scope.lots.map((row) => row.lot_id)).size !== scope.lots.length
      )
        fail("UNAVAILABLE");
      return send(200, scope);
    }
    const tail = url.pathname.split("/").slice(5);
    if (method === "POST" && tail.length === 0) {
      if (url.search || !validateFeedSupply(body, companyId)) fail("22023");
      const receipt = await call(new URL("rpc/record_feed_supply", restBase), {
        p_event: body,
      });
      if (!validateFeedReceipt(receipt, body, userId)) fail("UNAVAILABLE");
      return send(200, receipt);
    }
    if (method !== "GET") return send(405, { error: "METHOD_NOT_ALLOWED" });
    const target = new URL("feed_supply_events", restBase);
    target.searchParams.set("select", "event_payload,recorded_by,recorded_at");
    target.searchParams.set("company_id", `eq.${companyId}`);
    let date,
      offset = 0;
    if (tail.length === 1 && uuid.test(tail[0])) {
      if (url.search) fail("22023");
      target.searchParams.set("event_id", `eq.${tail[0]}`);
      target.searchParams.set("limit", "1");
    } else if (tail.length === 0) {
      date = url.searchParams.get("business_date");
      if (
        !validOriginDate(date) ||
        url.searchParams.getAll("business_date").length !== 1 ||
        url.searchParams.getAll("offset").length > 1 ||
        [...url.searchParams.keys()].some(
          (k) => !["business_date", "offset"].includes(k),
        )
      )
        fail("22023");
      const page = url.searchParams.get("offset") ?? "0";
      if (!/^(0|[1-9][0-9]*)$/.test(page) || Number(page) > 100000)
        fail("22023");
      offset = Number(page);
      target.searchParams.set("business_date", `eq.${date}`);
      target.searchParams.set("offset", String(offset));
      target.searchParams.set("limit", "26");
      target.searchParams.set("order", "recorded_at.asc,event_id.asc");
    } else fail("22023");
    const rows = await call(target);
    if (!Array.isArray(rows) || rows.length > (date ? 26 : 1))
      fail("UNAVAILABLE");
    const receipts = rows.map((row) => ({
      format: "tamago.feed-supply-receipt",
      schema_version: 1,
      event: row.event_payload,
      recorded_by: row.recorded_by,
      recorded_at: row.recorded_at,
      inventory_check: "not_evaluated",
      duplicate: false,
    }));
    for (const row of receipts)
      if (
        !validateFeedSupply(row.event, companyId) ||
        !uuid.test(row.recorded_by ?? "") ||
        !validateFeedReceipt(row, row.event, row.recorded_by) ||
        (date
          ? row.event.business_date !== date
          : row.event.event_id !== tail[0])
      )
        fail("UNAVAILABLE");
    if (!date)
      return receipts.length
        ? send(200, receipts[0])
        : send(404, { error: "FEED_SUPPLY_NOT_FOUND" });
    return send(200, {
      format: "tamago.feed-supply-list",
      schema_version: 1,
      company_id: companyId,
      business_date: date,
      items: receipts.slice(0, 25),
      next_offset: rows.length > 25 ? offset + 25 : null,
    });
  } catch (error) {
    return error.code === "42501"
      ? send(403, { error: "FEED_SUPPLY_FORBIDDEN" })
      : typeof error.code === "string" && error.code.startsWith("22")
        ? send(400, { error: "INVALID_FEED_SUPPLY" })
        : ["23505", "23514", "40001"].includes(error.code)
          ? send(409, { error: "FEED_SUPPLY_CONFLICT" })
          : send(503, { error: "FEED_SUPPLY_UNAVAILABLE" });
  }
}
