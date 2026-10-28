import {
  validateBalancePreview,
  validateInventoryCommand,
  validateInventoryReceipt,
} from "../shared/feed-inventory-contract.mjs";
import {
  validateCorrectionReceipt,
  validateEffectiveBinding,
  validateInventoryCorrection,
  validateInventoryHistory,
} from "../shared/feed-inventory-revision.mjs";
import {
  ledgerTime,
  validateLedgerCommand,
  validateLedgerEntries,
  validateLedgerReceipt,
  validateLedgerReview,
} from "../shared/feed-ledger-contract.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const validTime = (v) =>
  typeof v === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
  !v.startsWith("0000") &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
export async function feedInventoryApi({
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
    const tail = url.pathname.split("/").slice(5),
      resource = tail[0];
    const modes = {
      catalog: ["catalog", "record_feed_catalog_item"],
      bindings: ["binding", "bind_feed_fact"],
      "cutoff-decisions": ["cutoff", "record_feed_cutoff_decision"],
    };
    if (
      method === "POST" &&
      ["ledger-activate", "ledger-post"].includes(resource) &&
      tail.length === 1
    ) {
      if (
        url.search ||
        !validateLedgerCommand(body, companyId) ||
        body.format !==
          (resource === "ledger-activate"
            ? "tamago.feed-inventory-activation"
            : "tamago.feed-inventory-posting")
      )
        fail("22023");
      const r = await call("apply_feed_ledger", { p_event: body });
      if (!validateLedgerReceipt(r, body, userId)) fail("UNAVAILABLE");
      return send(200, r);
    }
    if (
      method === "GET" &&
      resource === "ledger-actions" &&
      tail.length === 2 &&
      uuid.test(tail[1])
    ) {
      if (url.search) fail("22023");
      const r = await call("get_feed_ledger_action", {
        p_company_id: companyId,
        p_action_id: tail[1],
      });
      if (!r) return send(404, { error: "FEED_INVENTORY_NOT_FOUND" });
      if (
        r.event?.action_id !== tail[1] ||
        r.event?.company_id !== companyId ||
        !validateLedgerReceipt(r, r.event, r.actor_id)
      )
        fail("UNAVAILABLE");
      return send(200, r);
    }
    if (
      method === "GET" &&
      ["ledger-review", "ledger-entries"].includes(resource) &&
      tail.length === 2 &&
      uuid.test(tail[1])
    ) {
      const page = url.searchParams.get("offset") ?? "0",
        time = url.searchParams.get("through_at");
      if (
        url.searchParams.getAll("offset").length > 1 ||
        !/^(0|[1-9][0-9]*)$/.test(page) ||
        Number(page) > 100000 ||
        [...url.searchParams.keys()].some(
          (k) =>
            ![
              "offset",
              ...(resource === "ledger-review" ? ["through_at"] : []),
            ].includes(k),
        ) ||
        (resource === "ledger-review" &&
          (url.searchParams.getAll("through_at").length !== 1 ||
            !ledgerTime(time)))
      )
        fail("22023");
      const v = await call(
        resource === "ledger-review"
          ? "get_feed_ledger_review"
          : "get_feed_ledger_entries",
        {
          p_company_id: companyId,
          ...(resource === "ledger-review"
            ? { p_opening_id: tail[1], p_through_at: time }
            : { p_account_id: tail[1] }),
          p_offset: Number(page),
        },
      );
      if (!v) return send(404, { error: "FEED_INVENTORY_NOT_FOUND" });
      if (
        !(resource === "ledger-review"
          ? validateLedgerReview(v, companyId, tail[1], Number(page)) &&
            Date.parse(v.through_at) === Date.parse(time)
          : validateLedgerEntries(v, companyId, tail[1], Number(page)))
      )
        fail("UNAVAILABLE");
      return send(200, v);
    }
    if (method === "POST" && resource === "corrections" && tail.length === 1) {
      if (url.search || !validateInventoryCorrection(body, companyId))
        fail("22023");
      const r = await call("correct_feed_inventory", { p_event: body });
      if (!validateCorrectionReceipt(r, body, userId)) fail("UNAVAILABLE");
      return send(200, r);
    }
    if (
      method === "GET" &&
      resource === "history" &&
      tail.length === 3 &&
      ["binding", "cutoff"].includes(tail[1]) &&
      uuid.test(tail[2])
    ) {
      const page = url.searchParams.get("offset") ?? "0";
      if (
        [...url.searchParams.keys()].some((k) => k !== "offset") ||
        url.searchParams.getAll("offset").length > 1 ||
        !/^(0|[1-9][0-9]*)$/.test(page) ||
        Number(page) > 100000
      )
        fail("22023");
      const v = await call("get_feed_inventory_history", {
        p_company_id: companyId,
        p_target_kind: tail[1],
        p_target_id: tail[2],
        p_offset: Number(page),
      });
      if (!v) return send(404, { error: "FEED_INVENTORY_NOT_FOUND" });
      if (
        !validateInventoryHistory(v, companyId, tail[1], tail[2], Number(page))
      )
        fail("UNAVAILABLE");
      return send(200, v);
    }
    if (method === "POST" && tail.length === 1 && modes[resource]) {
      const [kind, rpc] = modes[resource];
      if (url.search || !validateInventoryCommand(body, companyId, kind))
        fail("22023");
      const receipt = await call(rpc, { p_event: body });
      if (!validateInventoryReceipt(receipt, body, userId, kind))
        fail("UNAVAILABLE");
      return send(200, receipt);
    }
    if (method === "GET" && resource === "context" && tail.length === 1) {
      const lot = url.searchParams.get("lot_id");
      if (
        !uuid.test(lot ?? "") ||
        [...url.searchParams.keys()].some((k) => k !== "lot_id") ||
        url.searchParams.getAll("lot_id").length !== 1
      )
        fail("22023");
      const v = await call("get_feed_inventory_context", {
        p_company_id: companyId,
        p_lot_id: lot,
      });
      if (
        v?.company_id !== companyId ||
        v.lot_id !== lot ||
        typeof v.can_manage !== "boolean"
      )
        fail("UNAVAILABLE");
      return send(200, v);
    }
    if (method === "GET" && resource === "catalog" && tail.length === 1) {
      const lot = url.searchParams.get("lot_id"),
        page = url.searchParams.get("offset") ?? "0";
      if (
        !uuid.test(lot ?? "") ||
        url.searchParams.getAll("lot_id").length !== 1 ||
        url.searchParams.getAll("offset").length > 1 ||
        [...url.searchParams.keys()].some(
          (k) => !["lot_id", "offset"].includes(k),
        ) ||
        !/^(0|[1-9][0-9]*)$/.test(page) ||
        Number(page) > 100000
      )
        fail("22023");
      const v = await call("list_feed_catalog", {
        p_company_id: companyId,
        p_lot_id: lot,
        p_offset: Number(page),
      });
      if (
        v?.format !== "tamago.feed-catalog" ||
        v.schema_version !== 1 ||
        v.company_id !== companyId ||
        v.lot_id !== lot ||
        !Array.isArray(v.items) ||
        v.items.length > 25 ||
        !(v.next_offset === null || v.next_offset === Number(page) + 25) ||
        v.items.some(
          (i) =>
            !uuid.test(i?.item_id ?? "") ||
            i.company_id !== companyId ||
            !["product", "location"].includes(i.kind) ||
            typeof i.code !== "string" ||
            typeof i.label !== "string" ||
            (i.kind === "product" ? i.unit !== "BAG_40KG" : i.unit !== null),
        ) ||
        new Set(v.items.map((i) => i.item_id)).size !== v.items.length
      )
        fail("UNAVAILABLE");
      return send(200, v);
    }
    if (
      method === "GET" &&
      resource === "bindings" &&
      tail.length === 3 &&
      ["supply", "delivery", "count"].includes(tail[1]) &&
      uuid.test(tail[2])
    ) {
      if (url.search) fail("22023");
      const b = await call("get_feed_fact_binding", {
        p_company_id: companyId,
        p_source_kind: tail[1],
        p_source_id: tail[2],
      });
      if (!b) return send(404, { error: "FEED_INVENTORY_NOT_FOUND" });
      if (
        !validateEffectiveBinding(b, companyId, tail[1], tail[2]) ||
        b.event_payload.source_kind !== tail[1] ||
        b.event_payload.source_id !== tail[2] ||
        !uuid.test(b.recorded_by ?? "") ||
        b.company_id !== companyId ||
        !b.source_snapshot ||
        typeof b.recorded_at !== "string" ||
        !Number.isFinite(Date.parse(b.recorded_at))
      )
        fail("UNAVAILABLE");
      return send(200, {
        format: "tamago.feed-binding-context",
        schema_version: 1,
        binding: b,
      });
    }
    if (
      method === "GET" &&
      resource === "previews" &&
      tail.length === 2 &&
      uuid.test(tail[1])
    ) {
      const time = url.searchParams.get("through_at");
      if (
        [...url.searchParams.keys()].some((k) => k !== "through_at") ||
        url.searchParams.getAll("through_at").length > 1 ||
        (time !== null && !validTime(time))
      )
        fail("22023");
      const v = await call("get_feed_balance_preview", {
        p_company_id: companyId,
        p_opening_id: tail[1],
        ...(time ? { p_through_at: time } : {}),
      });
      if (!v) return send(404, { error: "FEED_INVENTORY_NOT_FOUND" });
      if (
        (time !== null && Date.parse(v.through_at) !== Date.parse(time)) ||
        !validateBalancePreview(v, companyId, tail[1])
      )
        fail("UNAVAILABLE");
      return send(200, v);
    }
    return send(405, { error: "METHOD_NOT_ALLOWED" });
  } catch (e) {
    return e.code === "42501"
      ? send(403, { error: "FEED_INVENTORY_FORBIDDEN" })
      : typeof e.code === "string" && e.code.startsWith("22")
        ? send(400, { error: "INVALID_FEED_INVENTORY" })
        : ["23505", "23514", "40001", "55000"].includes(e.code)
          ? send(409, { error: "FEED_INVENTORY_CONFLICT" })
          : send(503, { error: "FEED_INVENTORY_UNAVAILABLE" });
  }
}
