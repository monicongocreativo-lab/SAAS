import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import resultSchema from "../contracts/collection-ingestion-result.v1.schema.json" with {
  type: "json",
};
import { createRecord, pack } from "../src/offline/contract.mjs";
import { createSyncServer } from "../src/sync-prototype/server.mjs";
import { openSyncStore } from "../src/sync-prototype/store.mjs";

const validateResult = new Ajv({ allErrors: true }).compile(resultSchema);
const tamago = { company_id: "SYN-TAMAGO" };
const other = { company_id: "SYN-OTHER" };
const tokens = new Map([
  ["dev-synthetic-token-tamago", tamago],
  ["dev-synthetic-token-other", other],
]);
const fixedNow = () => new Date("2026-10-23T12:00:00.000Z");

function collection({ occurrence = 1, quantity = 300 } = {}) {
  return createRecord(
    {
      company_id: "SYN-TAMAGO",
      lot_id: "SYN-LOTE-02",
      shed_id: "SYN-GALPON-02",
      business_date: "2026-10-23",
      time: "10:00",
      occurrence,
      quantity_eggs: quantity,
      actor_id: "SYN-ACTOR-GALPONERO",
    },
    "00000000-0000-4000-8000-000000000001",
    fixedNow(),
  ).event;
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tamago-dev003-"));
  const databasePath = join(directory, "events.sqlite");
  let store = openSyncStore(databasePath);
  const storeAdapter = {
    receive(...args) {
      return store.receive(...args);
    },
  };
  const server = createSyncServer({
    store: storeAdapter,
    now: fixedNow,
    authenticate(header) {
      const [scheme, token] = (header ?? "").split(" ");
      return scheme === "Bearer" ? tokens.get(token) : undefined;
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  return {
    baseUrl,
    get store() {
      return store;
    },
    reopenStore() {
      store.close();
      store = openSyncStore(databasePath);
    },
  };
}

async function post(baseUrl, records, token = "dev-synthetic-token-tamago") {
  return fetch(`${baseUrl}/v1/collection-events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(
      pack(
        records.map((event) => ({
          event,
          delivery: { status: "pending" },
        })),
      ),
    ),
  });
}

async function startReceiver(databasePath) {
  const script = fileURLToPath(
    new URL("../scripts/sync-prototype-server.mjs", import.meta.url),
  );
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      TAMAGO_SYNC_PROTOTYPE: "1",
      TAMAGO_SYNC_PORT: "0",
      TAMAGO_SYNC_DB_PATH: databasePath,
      TAMAGO_SYNC_FIXTURE_TOKEN_TAMAGO: "test-only-tamago-token-for-local",
      TAMAGO_SYNC_FIXTURE_TOKEN_OTHER: "test-only-other-token-for-local",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });

  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Receiver startup timed out: ${output}`)),
      3000,
    );
    child.stdout.on("data", (chunk) => {
      const match = /127\.0\.0\.1:(\d+)/.exec(chunk);
      if (match) {
        clearTimeout(timeout);
        resolve(Number(match[1]));
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Receiver exited with ${code}: ${output}`));
    });
  });

  return { child, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopReceiver(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("ingest persists a synthetic event and returns a contract-valid technical receipt", async (t) => {
  const { baseUrl, store } = await fixture(t);
  const response = await post(baseUrl, [collection()]);
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(validateResult(result), true);
  assert.equal(result.results[0].status, "received");
  assert.equal(result.results[0].receipt.company_id, "SYN-TAMAGO");
  assert.equal(store.count(), 1);
});

test("same ID and body replay the identical receipt, including after DB restart", async (t) => {
  const context = await fixture(t);
  const event = collection();
  const first = await (await post(context.baseUrl, [event])).json();
  context.reopenStore();
  const replay = await (await post(context.baseUrl, [event])).json();

  assert.deepEqual(replay.results[0], first.results[0]);
  assert.equal(context.store.count(), 1);
});

test("receipt survives a full receiver process restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tamago-dev003-process-"));
  const databasePath = join(directory, "events.sqlite");
  const children = [];
  t.after(async () => {
    for (const child of children) await stopReceiver(child);
    await rm(directory, { recursive: true, force: true });
  });

  const event = collection();
  const firstServer = await startReceiver(databasePath);
  children.push(firstServer.child);
  const fixtureToken = "test-only-tamago-token-for-local";
  const first = await (
    await post(firstServer.baseUrl, [event], fixtureToken)
  ).json();
  await stopReceiver(firstServer.child);

  const secondServer = await startReceiver(databasePath);
  children.push(secondServer.child);
  const replay = await (
    await post(secondServer.baseUrl, [event], fixtureToken)
  ).json();

  assert.deepEqual(replay.results[0], first.results[0]);
});

test("same ID with changed content conflicts without replacing the first event", async (t) => {
  const { baseUrl, store } = await fixture(t);
  const original = collection();
  const changed = { ...original, quantity_eggs: 301 };
  await post(baseUrl, [original]);
  const result = await (await post(baseUrl, [changed])).json();

  assert.deepEqual(result.results[0], {
    event_id: original.event_id,
    status: "rejected",
    code: "EVENT_ID_CONFLICT",
  });
  assert.equal(store.count(), 1);
});

test("different IDs for the same company, lot, shed, date and occurrence conflict", async (t) => {
  const { baseUrl, store } = await fixture(t);
  const original = collection();
  const duplicateOccurrence = {
    ...collection(),
    occurrence: original.occurrence,
  };
  await post(baseUrl, [original]);
  const result = await (await post(baseUrl, [duplicateOccurrence])).json();

  assert.notEqual(duplicateOccurrence.event_id, original.event_id);
  assert.equal(result.results[0].code, "OCCURRENCE_CONFLICT");
  assert.equal(store.count(), 1);
});

test("principal from another synthetic company cannot ingest this event", async (t) => {
  const { baseUrl, store } = await fixture(t);
  const response = await post(
    baseUrl,
    [collection()],
    "dev-synthetic-token-other",
  );
  const result = await response.json();

  assert.equal(result.results[0].code, "OUT_OF_SCOPE");
  assert.equal(store.count(), 0);
});

test("missing credentials and malformed event packages are rejected before writes", async (t) => {
  const { baseUrl, store } = await fixture(t);
  const unauthenticated = await fetch(`${baseUrl}/v1/collection-events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      pack([
        {
          event: collection(),
          delivery: { status: "pending" },
        },
      ]),
    ),
  });
  const invalid = await fetch(`${baseUrl}/v1/collection-events`, {
    method: "POST",
    headers: {
      authorization: "Bearer dev-synthetic-token-tamago",
      "content-type": "application/json",
    },
    body: "{}",
  });
  const wrongMediaType = await fetch(`${baseUrl}/v1/collection-events`, {
    method: "POST",
    headers: {
      authorization: "Bearer dev-synthetic-token-tamago",
      "content-type": "text/plain",
    },
    body: JSON.stringify(
      pack([
        {
          event: collection(),
          delivery: { status: "pending" },
        },
      ]),
    ),
  });

  assert.equal(unauthenticated.status, 401);
  assert.equal(invalid.status, 400);
  assert.equal(wrongMediaType.status, 415);
  assert.equal(store.count(), 0);
});

test("concurrent duplicate occurrences produce one stored event and one conflict", async (t) => {
  const { baseUrl, store } = await fixture(t);
  const first = collection();
  const second = { ...collection(), occurrence: first.occurrence };
  const outcomes = await Promise.all([
    post(baseUrl, [first]).then((response) => response.json()),
    post(baseUrl, [second]).then((response) => response.json()),
  ]);
  const statuses = outcomes.map((result) => result.results[0].status).sort();

  assert.deepEqual(statuses, ["received", "rejected"]);
  assert.equal(store.count(), 1);
});
