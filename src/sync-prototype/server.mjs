import { createServer } from "node:http";
import { assertPackage } from "../offline/contract.mjs";

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RECORDS = 100;

export function createSyncServer({
  store,
  authenticate,
  now = () => new Date(),
}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      return sendJson(response, 200, {
        status: "ok",
        mode: "synthetic-local-prototype",
      });
    }

    if (request.method !== "POST" || request.url !== "/v1/collection-events")
      return sendJson(response, 404, { error: "NOT_FOUND" });

    const principal = authenticate(request.headers.authorization);
    if (!principal)
      return sendJson(response, 401, { error: "AUTHENTICATION_REQUIRED" });
    if (
      !/^application\/json(?:\s*;|$)/i.test(
        request.headers["content-type"] ?? "",
      )
    )
      return sendJson(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });

    let value;
    try {
      value = await readJson(request);
      assertPackage(value);
      if (value.records.length < 1 || value.records.length > MAX_RECORDS)
        return sendJson(response, 400, { error: "INVALID_BATCH_SIZE" });
    } catch (error) {
      const status = error.code === "BODY_TOO_LARGE" ? 413 : 400;
      return sendJson(response, status, {
        error: status === 413 ? "BODY_TOO_LARGE" : "INVALID_FIELDS",
      });
    }

    try {
      const results = value.records.map(({ event }) => ({
        event_id: event.event_id,
        ...store.receive(event, principal, now()),
      }));
      return sendJson(response, 200, {
        format: "tamago.collection-ingestion-result",
        schema_version: 1,
        environment: "synthetic",
        results,
      });
    } catch {
      return sendJson(response, 503, { error: "TEMPORARY_STORAGE_FAILURE" });
    }
  });
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      const error = new Error("body too large");
      error.code = "BODY_TOO_LARGE";
      throw error;
    }
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("invalid JSON");
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}
