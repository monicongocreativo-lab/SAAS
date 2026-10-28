import { validateOriginFlowSummary } from "../shared/origin-flow-contract.mjs";
import {
  validateTransferDispatch,
  validOriginDate,
} from "./transfer-contract.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const json = (status, body) => ({ status, body });
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
const integerPage = (query, key, max) => {
  if (
    [...query.keys()].some((item) => item !== key) ||
    query.getAll(key).length > 1
  )
    fail("22023");
  const value = query.get(key) ?? "0";
  if (!/^(0|[1-9][0-9]*)$/.test(value) || Number(value) > max) fail("22023");
  return Number(value);
};

// Authentication and Origin checks belong to the shared gateway. Every data
// request below uses only the user's access token, preserving Postgres RLS.
export async function custodyApi({
  url,
  method,
  body,
  companyId,
  accessToken,
  restBase,
  publishableKey,
  fetchImpl,
}) {
  const headers = {
    apikey: publishableKey,
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
  async function call(path, payload) {
    const result = await fetchImpl(new URL(path, restBase), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!result.ok) {
      const error = await result.json().catch(() => ({}));
      fail(result.status === 401 ? "42501" : (error.code ?? "UNAVAILABLE"));
    }
    return result.json();
  }
  async function rows(table, select, filters) {
    const target = new URL(table, restBase);
    target.searchParams.set("select", select);
    for (const [key, value] of Object.entries(filters))
      target.searchParams.set(key, value);
    const result = await fetchImpl(target, { headers });
    if (!result.ok) fail("UNAVAILABLE");
    const value = await result.json();
    if (!Array.isArray(value)) fail("UNAVAILABLE");
    return value;
  }
  try {
    const tail = url.pathname.split("/").slice(4);
    if (
      ["custody-origins", "custody-flow"].includes(tail[0]) &&
      tail.length === 1 &&
      method === "GET"
    ) {
      const date = url.searchParams.get("business_date");
      if (
        !validOriginDate(date) ||
        url.searchParams.getAll("business_date").length !== 1
      )
        fail("22023");
      const query = new URLSearchParams(url.searchParams);
      query.delete("business_date");
      const offset = integerPage(query, "offset", 100000);
      const result = await call(
        tail[0] === "custody-flow"
          ? "rpc/list_origin_flow_summary"
          : "rpc/list_collection_origins",
        {
          p_company_id: companyId,
          p_business_date: date,
          p_offset: offset,
        },
      );
      if (
        tail[0] === "custody-flow" &&
        !validateOriginFlowSummary(result, { companyId, date })
      )
        fail("UNAVAILABLE");
      return json(200, result);
    }
    if (
      tail[0] === "custody-transfers" &&
      tail.length === 1 &&
      method === "POST"
    ) {
      if (url.search || !validateTransferDispatch(body, companyId))
        fail("22023");
      const { schema_version: _version, ...transfer } = body;
      return json(
        200,
        await call("rpc/dispatch_collection_transfer", {
          p_transfer: transfer,
        }),
      );
    }
    if (
      tail[0] === "custody-transfers" &&
      tail.length === 1 &&
      method === "GET"
    ) {
      const offset = integerPage(url.searchParams, "offset", 100000);
      return json(
        200,
        await call("rpc/list_collection_transfers", {
          p_company_id: companyId,
          p_offset: offset,
        }),
      );
    }
    if (
      tail[0] === "custody-transfers" &&
      UUID.test(tail[1] ?? "") &&
      (tail.length === 2 || (tail[2] === "receipt" && tail.length === 3))
    ) {
      if (url.search) fail("22023");
      if (
        (tail.length === 2 && method !== "GET") ||
        (tail.length === 3 && method !== "POST")
      )
        return json(405, { error: "METHOD_NOT_ALLOWED" });
      const context = await call("rpc/get_collection_transfer_context", {
        p_company_id: companyId,
        p_transfer_id: tail[1],
      });
      if (!context) return json(404, { error: "CUSTODY_NOT_FOUND" });
      if (tail.length === 2) return json(200, context);
      if (
        !body ||
        Object.keys(body).sort().join() !==
          "received_at,received_at_location,received_quantity,receiver_note" ||
        !Number.isInteger(body.received_quantity) ||
        body.received_quantity < 0 ||
        body.received_quantity > 2147483647 ||
        typeof body.received_at_location !== "string" ||
        !body.received_at_location.trim() ||
        body.received_at_location.length > 160 ||
        !(
          body.receiver_note === null ||
          (typeof body.receiver_note === "string" &&
            body.receiver_note.length <= 2000)
        ) ||
        typeof body.received_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
          body.received_at,
        ) ||
        !Number.isFinite(Date.parse(body.received_at))
      )
        fail("22023");
      return json(
        200,
        await call("rpc/confirm_collection_transfer_receipt", {
          p_transfer_id: tail[1],
          p_received_quantity: body.received_quantity,
          p_received_at_location: body.received_at_location,
          p_received_at: body.received_at,
          p_receiver_note: body.receiver_note,
        }),
      );
    }
    if (
      tail[0] === "custody-case-actions" &&
      tail.length === 1 &&
      method === "POST"
    ) {
      if (url.search || !body || body.company_id !== companyId) fail("22023");
      return json(
        200,
        await call("rpc/record_custody_case_action", { p_command: body }),
      );
    }
    if (
      tail[0] === "custody-incidents" &&
      tail.length === 3 &&
      UUID.test(tail[1] ?? "") &&
      ["actions", "evidence"].includes(tail[2]) &&
      method === "GET"
    ) {
      const history = tail[2] === "actions";
      const cursor = integerPage(
        url.searchParams,
        history ? "after_revision" : "offset",
        history ? 2147483647 : 100000,
      );
      const incident = await rows("custody_incidents", "incident_id", {
        company_id: `eq.${companyId}`,
        incident_id: `eq.${tail[1]}`,
        limit: "1",
      });
      if (!incident.length) return json(404, { error: "CUSTODY_NOT_FOUND" });
      const result = await rows(
        history ? "custody_case_actions" : "custody_incident_evidence",
        "*",
        {
          company_id: `eq.${companyId}`,
          incident_id: `eq.${tail[1]}`,
          limit: "51",
          ...(history
            ? { revision_after: `gt.${cursor}`, order: "revision_after.asc" }
            : {
                offset: String(cursor),
                order: "recorded_at.asc,evidence_id.asc",
              }),
        },
      );
      const items = result.slice(0, 50);
      return json(200, {
        items,
        next_cursor:
          result.length > 50
            ? history
              ? items.at(-1).revision_after
              : cursor + 50
            : null,
      });
    }
    return json(405, { error: "METHOD_NOT_ALLOWED" });
  } catch (error) {
    const code = error.code;
    return code === "42501"
      ? json(403, { error: "CUSTODY_FORBIDDEN" })
      : typeof code === "string" && code.startsWith("22")
        ? json(400, { error: "INVALID_CUSTODY_REQUEST" })
        : ["40001", "55000", "23505", "23514"].includes(code)
          ? json(409, { error: "CUSTODY_CONFLICT" })
          : json(503, { error: "CUSTODY_UNAVAILABLE" });
  }
}
