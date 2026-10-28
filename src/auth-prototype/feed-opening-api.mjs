import {
  validateOpeningContext,
  validateOpeningList,
} from "../shared/feed-opening-context.mjs";
import {
  validateOpeningApproval,
  validateOpeningCount,
  validateOpeningReceipt,
} from "../shared/feed-opening-contract.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export async function feedOpeningApi({
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
  async function call(name, payload) {
    const r = await fetchImpl(new URL(`rpc/${name}`, restBase), {
      method: "POST",
      headers: {
        apikey: publishableKey,
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      fail(r.status === 401 ? "42501" : (e.code ?? "UNAVAILABLE"));
    }
    return r.json();
  }
  try {
    const resource = url.pathname.split("/")[4],
      id = url.pathname.split("/")[5];
    if (
      ["feed-opening-counts", "feed-opening-approvals"].includes(resource) &&
      !id &&
      method === "POST"
    ) {
      const approval = resource === "feed-opening-approvals";
      if (
        url.search ||
        !(approval
          ? validateOpeningApproval(body, companyId)
          : validateOpeningCount(body, companyId))
      )
        fail("22023");
      const receipt = await call(
        approval ? "approve_feed_opening" : "record_feed_opening_count",
        { p_event: body },
      );
      if (!validateOpeningReceipt(receipt, body, userId, approval))
        fail("UNAVAILABLE");
      return send(200, receipt);
    }
    if (resource === "feed-openings" && !id && method === "GET") {
      const page = url.searchParams.get("offset") ?? "0";
      if (
        [...url.searchParams.keys()].some((k) => k !== "offset") ||
        url.searchParams.getAll("offset").length > 1 ||
        !/^(0|[1-9][0-9]*)$/.test(page) ||
        Number(page) > 100000
      )
        fail("22023");
      const list = await call("list_feed_openings", {
        p_company_id: companyId,
        p_offset: Number(page),
      });
      if (!validateOpeningList(list, companyId, Number(page)))
        fail("UNAVAILABLE");
      return send(200, list);
    }
    if (
      resource === "feed-openings" &&
      uuid.test(id ?? "") &&
      method === "GET"
    ) {
      const page = url.searchParams.get("offset") ?? "0";
      if (
        [...url.searchParams.keys()].some((k) => k !== "offset") ||
        url.searchParams.getAll("offset").length > 1 ||
        !/^(0|[1-9][0-9]*)$/.test(page) ||
        Number(page) > 100000
      )
        fail("22023");
      const context = await call("get_feed_opening", {
        p_company_id: companyId,
        p_opening_id: id,
        p_offset: Number(page),
      });
      if (!context) return send(404, { error: "FEED_OPENING_NOT_FOUND" });
      if (
        !validateOpeningContext(context, {
          companyId,
          id,
          offset: Number(page),
        })
      )
        fail("UNAVAILABLE");
      return send(200, context);
    }
    return send(405, { error: "METHOD_NOT_ALLOWED" });
  } catch (e) {
    return e.code === "42501"
      ? send(403, { error: "FEED_OPENING_FORBIDDEN" })
      : typeof e.code === "string" && e.code.startsWith("22")
        ? send(400, { error: "INVALID_FEED_OPENING" })
        : ["40001", "23505", "23514", "55000"].includes(e.code)
          ? send(409, { error: "FEED_OPENING_CONFLICT" })
          : send(503, { error: "FEED_OPENING_UNAVAILABLE" });
  }
}
