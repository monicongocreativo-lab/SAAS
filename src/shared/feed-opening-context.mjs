import {
  validateOpeningApproval,
  validateOpeningCount,
} from "./feed-opening-contract.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validOpeningHeader(h, companyId) {
  return (
    !!h &&
    h.company_id === companyId &&
    ["opening_id", "company_id", "site_id", "house_id", "lot_id"].every((k) =>
      uuid.test(h[k] ?? ""),
    ) &&
    h.unit === "BAG_40KG" &&
    ["product_declared", "location_declared"].every(
      (k) =>
        typeof h[k] === "string" &&
        h[k].trim().length > 0 &&
        h[k].length <= 200,
    ) &&
    ["pending", "approved"].includes(h.status) &&
    Number.isSafeInteger(h.current_revision) &&
    h.current_revision >= 1
  );
}
export function validateOpeningContext(context, { companyId, id, offset = 0 }) {
  try {
    if (
      !context ||
      !validOpeningHeader(context.opening, companyId) ||
      typeof context.can_approve !== "boolean" ||
      typeof context.can_count !== "boolean"
    )
      return false;
    const h = context.opening;
    if (
      context.format !== "tamago.feed-opening-context" ||
      context.schema_version !== 1 ||
      context.inventory_check !== "not_applied" ||
      !h ||
      h.company_id !== companyId ||
      h.opening_id !== id ||
      !["site_id", "house_id", "lot_id"].every((k) => uuid.test(h[k] ?? "")) ||
      h.unit !== "BAG_40KG" ||
      !["product_declared", "location_declared"].every(
        (k) =>
          typeof h[k] === "string" &&
          h[k].trim().length > 0 &&
          h[k].length <= 200,
      ) ||
      !["pending", "approved"].includes(h.status) ||
      !Number.isInteger(h.current_revision) ||
      h.current_revision < 1 ||
      !Array.isArray(context.counts) ||
      context.counts.length > 25 ||
      !(context.next_offset === null || context.next_offset === offset + 25) ||
      (h.status === "approved") !== !!context.approval
    )
      return false;
    const seen = new Set();
    for (const row of [
      ...context.counts,
      ...(context.approval ? [context.approval] : []),
    ]) {
      const e = row.event_payload,
        approval = row === context.approval;
      if (
        !(approval
          ? validateOpeningApproval(e, companyId)
          : validateOpeningCount(e, companyId)) ||
        e.opening_id !== id ||
        !uuid.test(row.recorded_by ?? "") ||
        typeof row.recorded_at !== "string" ||
        !Number.isFinite(Date.parse(row.recorded_at)) ||
        row.revision !== e.expected_revision + (approval ? 0 : 1)
      )
        return false;
      if (!approval) {
        if (
          e.site_id !== h.site_id ||
          e.house_id !== h.house_id ||
          e.lot_id !== h.lot_id ||
          e.product_declared !== h.product_declared ||
          e.location_declared !== h.location_declared ||
          e.unit !== h.unit ||
          seen.has(row.revision)
        )
          return false;
        seen.add(row.revision);
      } else if (row.revision !== h.current_revision) return false;
    }
    if (offset === 0 && context.counts[0]?.revision !== h.current_revision)
      return false;

    return true;
  } catch {
    return false;
  }
}
export function validateOpeningList(v, companyId, offset = 0) {
  return (
    !!v &&
    v.format === "tamago.feed-opening-list" &&
    v.schema_version === 1 &&
    v.company_id === companyId &&
    v.inventory_check === "not_applied" &&
    Array.isArray(v.items) &&
    v.items.length <= 25 &&
    v.items.every((h) => validOpeningHeader(h, companyId)) &&
    new Set(v.items.map((h) => h.opening_id)).size === v.items.length &&
    (v.next_offset === null || v.next_offset === offset + 25)
  );
}
