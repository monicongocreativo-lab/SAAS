import { validateBalancePreview } from "./feed-inventory-contract.mjs";

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hash = /^[0-9a-f]{64}$/;
const keys = (v, list) =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join() === list.toSorted().join();
const integer = (v) => Number.isSafeInteger(v) && v >= 0;
const date = (v) => typeof v === "string" && Number.isFinite(Date.parse(v));
const decimal = (v) =>
  typeof v === "string" &&
  v.length <= 256 &&
  /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(v) &&
  v !== "-0";
const positive = (v) => decimal(v) && !v.startsWith("-");
export function ledgerTime(v) {
  return (
    date(v) &&
    !v.startsWith("0000") &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) &&
    new Date(v).toISOString() === v
  );
}
function scaled(v, n) {
  const [whole, f = ""] = v.split(".");
  return BigInt(whole + f.padEnd(n, "0"));
}
export function ledgerEquation(a, b, c) {
  if (![a, b, c].every(decimal)) return false;
  const n = Math.max(...[a, b, c].map((s) => (s.split(".")[1] ?? "").length));
  return scaled(a, n) - scaled(b, n) === scaled(c, n);
}
export function validateLedgerCommand(e, company) {
  const activation = e?.format === "tamago.feed-inventory-activation",
    posting = e?.format === "tamago.feed-inventory-posting";
  if (!activation && !posting) return false;
  return (
    keys(e, [
      "format",
      "schema_version",
      "action_id",
      "company_id",
      "through_at",
      "review_token",
      "reason",
      ...(activation ? ["opening_id"] : ["account_id", "expected_revision"]),
    ]) &&
    e.schema_version === 1 &&
    e.company_id === company &&
    uuid.test(company ?? "") &&
    uuid.test(e.action_id ?? "") &&
    ledgerTime(e.through_at) &&
    hash.test(e.review_token ?? "") &&
    typeof e.reason === "string" &&
    e.reason.trim().length > 0 &&
    e.reason.length <= 2000 &&
    (activation
      ? uuid.test(e.opening_id ?? "")
      : uuid.test(e.account_id ?? "") &&
        Number.isInteger(e.expected_revision) &&
        e.expected_revision >= 1 &&
        e.expected_revision <= 999999999)
  );
}
export function validateLedgerReceipt(r, e, actor) {
  return (
    keys(r, [
      "format",
      "schema_version",
      "event",
      "actor_id",
      "recorded_at",
      "account_id",
      "revision",
      "balance_bags",
      "duplicate",
      "inventory_check",
      "coverage",
    ]) &&
    r.format === "tamago.feed-ledger-receipt" &&
    r.schema_version === 1 &&
    validateLedgerCommand(r.event, e.company_id) &&
    Object.keys(e).every((k) => e[k] === r.event[k]) &&
    r.actor_id === actor &&
    uuid.test(actor ?? "") &&
    date(r.recorded_at) &&
    r.account_id === (e.account_id ?? e.action_id) &&
    r.revision ===
      (e.expected_revision === undefined ? 1 : e.expected_revision + 1) &&
    positive(r.balance_bags) &&
    typeof r.duplicate === "boolean" &&
    r.inventory_check === "applied_to_book" &&
    r.coverage === "server_records_only"
  );
}
export function validateLedgerReview(v, company, opening, offset = 0) {
  if (
    !keys(v, [
      "format",
      "schema_version",
      "company_id",
      "opening_id",
      "through_at",
      "account",
      "revision",
      "book_through_at",
      "anchor",
      "book_balance_bags",
      "proposed_balance_bags",
      "available_bags",
      "status",
      "can_activate",
      "can_post",
      "coverage",
      "inventory_check",
      "preview",
      "source_count",
      "pending_sources",
      "other_applied_sources",
      "review_token",
      "can_manage",
      "items",
      "next_offset",
    ]) ||
    v.format !== "tamago.feed-ledger-review" ||
    v.schema_version !== 1 ||
    v.company_id !== company ||
    v.opening_id !== opening ||
    !uuid.test(company ?? "") ||
    !uuid.test(opening ?? "") ||
    !date(v.through_at) ||
    !hash.test(v.review_token ?? "") ||
    !validateBalancePreview(v.preview, company, opening) ||
    Date.parse(v.preview.through_at) !== Date.parse(v.through_at) ||
    v.coverage !== "server_records_only"
  )
    return false;
  if (
    ![
      "needs_activation",
      "current",
      "pending",
      "blocked",
      "insufficient",
      "already_active",
      "opening_changed",
      "future_window",
      "earlier_window",
      "other_account_pending",
    ].includes(v.status) ||
    ![v.can_manage, v.can_activate, v.can_post].every(
      (n) => typeof n === "boolean",
    ) ||
    ![
      v.revision,
      v.source_count,
      v.pending_sources,
      v.other_applied_sources,
    ].every(integer) ||
    v.pending_sources > v.source_count ||
    v.other_applied_sources > v.source_count
  )
    return false;
  if (v.account === null) {
    if (
      v.revision !== 0 ||
      v.book_balance_bags !== null ||
      v.book_through_at !== null ||
      v.inventory_check !== "not_activated"
    )
      return false;
  } else {
    const a = v.account;
    if (
      !a ||
      a.company_id !== company ||
      ![
        "account_id",
        "company_id",
        "site_id",
        "house_id",
        "lot_id",
        "product_id",
        "location_id",
        "opening_id",
        "count_id",
        "count_binding_id",
        "recorded_by",
      ].every((k) => uuid.test(a[k] ?? "")) ||
      a.unit !== "BAG_40KG" ||
      !positive(a.opening_quantity) ||
      !integer(a.count_binding_revision) ||
      !date(a.cutoff_at) ||
      !date(a.recorded_at) ||
      !validateLedgerCommand(a.event_payload, company) ||
      a.event_payload.format !== "tamago.feed-inventory-activation" ||
      a.event_payload.action_id !== a.account_id ||
      a.event_payload.opening_id !== a.opening_id ||
      v.revision < 1 ||
      !positive(v.book_balance_bags) ||
      !date(v.book_through_at) ||
      v.inventory_check !== "book_recorded"
    )
      return false;
    if (v.status !== "already_active" && a.opening_id !== opening) return false;
  }
  if (v.anchor !== null) {
    const a = v.anchor;
    if (
      !keys(a, [
        "count_id",
        "binding_id",
        "binding_revision",
        "product_id",
        "location_id",
        "cutoff_at",
        "opening_bags",
      ]) ||
      !["count_id", "binding_id", "product_id", "location_id"].every((k) =>
        uuid.test(a[k] ?? ""),
      ) ||
      !integer(a.binding_revision) ||
      !date(a.cutoff_at) ||
      !positive(a.opening_bags) ||
      a.count_id !== v.preview.count_id ||
      a.opening_bags !== v.preview.opening_bags
    )
      return false;
  }
  if (v.proposed_balance_bags !== null && !decimal(v.proposed_balance_bags))
    return false;
  if (
    !Array.isArray(v.items) ||
    v.items.length !== Math.min(25, Math.max(0, v.source_count - offset)) ||
    v.next_offset !== (v.source_count - offset > 25 ? offset + 25 : null) ||
    new Set(v.items.map((i) => `${i.source_kind}/${i.source_id}`)).size !==
      v.items.length
  )
    return false;
  for (const i of v.items) {
    if (
      !keys(i, [
        "source_kind",
        "source_id",
        "quantity_bags",
        "occurred_at",
        "desired_bags",
        "applied_bags",
        "delta_bags",
        "pending",
        "other_applied",
        "context_hash",
      ]) ||
      !["delivery", "supply"].includes(i.source_kind) ||
      !uuid.test(i.source_id ?? "") ||
      !positive(i.quantity_bags) ||
      !date(i.occurred_at) ||
      typeof i.pending !== "boolean" ||
      typeof i.other_applied !== "boolean" ||
      !hash.test(i.context_hash ?? "") ||
      !ledgerEquation(i.desired_bags, i.applied_bags, i.delta_bags) ||
      (!i.pending && i.delta_bags !== "0")
    )
      return false;
  }
  if (
    v.items.filter((i) => i.pending).length > v.pending_sources ||
    v.items.filter((i) => i.other_applied).length > v.other_applied_sources
  )
    return false;
  if (
    v.can_activate !== (v.can_manage && v.status === "needs_activation") ||
    v.can_post !== (v.can_manage && v.status === "pending")
  )
    return false;
  if (
    !["opening_changed", "already_active"].includes(v.status) &&
    v.anchor &&
    v.proposed_balance_bags !== v.preview.diagnostic_balance_bags
  )
    return false;
  if (
    v.can_activate &&
    (!v.can_manage ||
      v.status !== "needs_activation" ||
      v.account !== null ||
      !positive(v.proposed_balance_bags) ||
      !v.anchor)
  )
    return false;
  if (
    v.can_post &&
    (!v.can_manage ||
      v.status !== "pending" ||
      !v.account ||
      v.pending_sources < 1 ||
      !positive(v.proposed_balance_bags))
  )
    return false;
  if (!v.can_manage && (v.can_activate || v.can_post)) return false;
  if (v.status === "current")
    return (
      !!v.account &&
      v.pending_sources === 0 &&
      v.other_applied_sources === 0 &&
      v.preview.status === "resolved" &&
      positive(v.available_bags) &&
      v.available_bags === v.book_balance_bags &&
      v.proposed_balance_bags === v.book_balance_bags &&
      !v.can_activate &&
      !v.can_post
    );
  return (
    v.available_bags === null &&
    (!["needs_activation", "pending"].includes(v.status)
      ? !v.can_activate && !v.can_post
      : true) &&
    (v.status !== "insufficient" ||
      v.proposed_balance_bags?.startsWith("-") === true)
  );
}
export function validateLedgerEntries(v, company, account, offset = 0) {
  if (
    !keys(v, [
      "format",
      "schema_version",
      "company_id",
      "account_id",
      "revision",
      "book_balance_bags",
      "items",
      "next_offset",
    ]) ||
    v.format !== "tamago.feed-ledger-entries" ||
    v.schema_version !== 1 ||
    v.company_id !== company ||
    v.account_id !== account ||
    !uuid.test(account ?? "") ||
    !integer(v.revision) ||
    v.revision < 1 ||
    !positive(v.book_balance_bags) ||
    !Array.isArray(v.items) ||
    v.items.length > 25 ||
    !(v.next_offset === null || v.next_offset === offset + 25) ||
    new Set(v.items.map((i) => i.entry_id)).size !== v.items.length
  )
    return false;
  return v.items.every(
    (i) =>
      i.company_id === company &&
      i.account_id === account &&
      ["entry_id", "source_id", "action_id", "recorded_by"].every((k) =>
        uuid.test(i[k] ?? ""),
      ) &&
      ["opening", "delivery", "supply"].includes(i.source_kind) &&
      decimal(i.delta) &&
      decimal(i.desired_after) &&
      hash.test(i.context_hash ?? "") &&
      integer(i.operation_revision) &&
      i.operation_revision >= 1 &&
      i.operation_revision <= v.revision &&
      date(i.recorded_at) &&
      i.source_snapshot &&
      typeof i.source_snapshot === "object" &&
      validateLedgerCommand(i.operation_payload, company) &&
      i.operation_payload.action_id === i.action_id &&
      (i.operation_payload.account_id ?? i.operation_payload.action_id) ===
        account &&
      i.operation_revision ===
        (i.operation_payload.expected_revision === undefined
          ? 1
          : i.operation_payload.expected_revision + 1),
  );
}
