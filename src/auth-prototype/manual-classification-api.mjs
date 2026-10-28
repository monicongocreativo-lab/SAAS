import {
  manualClassificationCatalog,
  validateManualClassification,
} from "./manual-classification-contract.mjs";
import { validOriginDate } from "./transfer-contract.mjs";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const json = (status, body) => ({ status, body });
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
export async function manualClassificationApi({
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
  const headers = {
    apikey: publishableKey,
    authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
  };
  async function call(name, payload) {
    const response = await fetchImpl(new URL(`rpc/${name}`, restBase), {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      fail(response.status === 401 ? "42501" : (error.code ?? "UNAVAILABLE"));
    }
    return response.json();
  }
  const route = url.pathname.split("/").slice(4);
  try {
    if (
      route[0] === "manual-classification-catalog" &&
      route.length === 1 &&
      method === "GET"
    ) {
      if (url.search) fail("22023");
      const target = new URL("companies", restBase);
      target.searchParams.set("select", "id");
      target.searchParams.set("id", `eq.${companyId}`);
      target.searchParams.set("limit", "1");
      const response = await fetchImpl(target, { headers });
      if (!response.ok) fail("UNAVAILABLE");
      const rows = await response.json();
      if (!Array.isArray(rows)) fail("UNAVAILABLE");
      if (!rows.length) return json(404, { error: "CLASSIFICATION_NOT_FOUND" });
      return json(200, {
        company_id: companyId,
        catalog: manualClassificationCatalog,
      });
    }
    if (
      route[0] === "manual-classifications" &&
      route.length === 1 &&
      method === "POST"
    ) {
      if (url.search || !validateManualClassification(body, companyId))
        fail("22023");
      const receipt = await call("record_manual_classification", {
        p_record: body,
      });
      const total = body.inputs.reduce(
        (sum, input) => sum + input.quantity_eggs,
        0,
      );
      if (
        receipt?.format !== "tamago.manual-classification-receipt" ||
        receipt.schema_version !== 1 ||
        receipt.session_id !== body.session_id ||
        receipt.company_id !== companyId ||
        receipt.origin_business_date !== body.origin_business_date ||
        receipt.recorded_by !== userId ||
        receipt.processed_quantity !== total ||
        receipt.review_status !== "pending" ||
        receipt.configuration_status !== "declared_unverified" ||
        typeof receipt.duplicate !== "boolean" ||
        typeof receipt.recorded_at !== "string" ||
        !Number.isFinite(Date.parse(receipt.recorded_at))
      )
        fail("UNAVAILABLE");
      return json(200, receipt);
    }
    if (
      route[0] === "manual-classifications" &&
      route.length === 2 &&
      method === "GET"
    ) {
      if (!UUID.test(route[1]) || url.search) fail("22023");
      const result = await call("get_manual_classification", {
        p_company_id: companyId,
        p_session_id: route[1],
      });
      return result
        ? json(200, result)
        : json(404, { error: "CLASSIFICATION_NOT_FOUND" });
    }
    if (
      ["manual-classifications", "manual-classification-inputs"].includes(
        route[0],
      ) &&
      route.length === 1 &&
      method === "GET"
    ) {
      const date = url.searchParams.get("business_date"),
        offset = url.searchParams.get("offset") ?? "0";
      if (
        [...url.searchParams.keys()].some(
          (key) => !["business_date", "offset"].includes(key),
        ) ||
        url.searchParams.getAll("business_date").length !== 1 ||
        url.searchParams.getAll("offset").length > 1 ||
        !validOriginDate(date) ||
        !/^(0|[1-9][0-9]*)$/.test(offset) ||
        Number(offset) > 100000
      )
        fail("22023");
      return json(
        200,
        await call(
          route[0] === "manual-classifications"
            ? "list_manual_classifications"
            : "list_manual_classification_inputs",
          {
            p_company_id: companyId,
            p_business_date: date,
            p_offset: Number(offset),
          },
        ),
      );
    }
    return json(405, { error: "METHOD_NOT_ALLOWED" });
  } catch (error) {
    return error.code === "42501"
      ? json(403, { error: "CLASSIFICATION_FORBIDDEN" })
      : typeof error.code === "string" && error.code.startsWith("22")
        ? json(400, { error: "INVALID_MANUAL_CLASSIFICATION" })
        : ["40001", "55000", "23505", "23514", "23503"].includes(error.code)
          ? json(409, { error: "CLASSIFICATION_CONFLICT" })
          : json(503, { error: "CLASSIFICATION_UNAVAILABLE" });
  }
}
