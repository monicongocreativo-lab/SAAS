import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createSyncServer } from "../src/sync-prototype/server.mjs";
import { openSyncStore } from "../src/sync-prototype/store.mjs";

if (process.env.TAMAGO_SYNC_PROTOTYPE !== "1") {
  throw new Error(
    "Set TAMAGO_SYNC_PROTOTYPE=1 to run this synthetic prototype.",
  );
}

const databasePath = resolve(
  process.env.TAMAGO_SYNC_DB_PATH ??
    join(tmpdir(), `tamago-dev003-${randomUUID()}.sqlite`),
);
const temporaryRoots = [tmpdir(), "/private/tmp", "/tmp"].map((root) =>
  resolve(root),
);
if (
  !temporaryRoots.some((root) => {
    const pathFromRoot = relative(root, databasePath);
    return (
      pathFromRoot === "" ||
      (pathFromRoot !== ".." &&
        !pathFromRoot.startsWith(`..${sep}`) &&
        !isAbsolute(pathFromRoot))
    );
  })
) {
  throw new Error(
    "Synthetic database path must stay inside a system temp directory.",
  );
}
const port = Number(process.env.TAMAGO_SYNC_PORT ?? 8770);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("TAMAGO_SYNC_PORT must be an integer from 0 to 65535.");
const tamagoToken = process.env.TAMAGO_SYNC_FIXTURE_TOKEN_TAMAGO;
const otherToken = process.env.TAMAGO_SYNC_FIXTURE_TOKEN_OTHER;
if (
  !tamagoToken ||
  !otherToken ||
  tamagoToken.length < 24 ||
  otherToken.length < 24 ||
  tamagoToken === otherToken
) {
  throw new Error(
    "Set distinct synthetic fixture tokens of at least 24 characters in the environment.",
  );
}
const fixturePrincipals = new Map([
  [tamagoToken, { company_id: "SYN-TAMAGO" }],
  [otherToken, { company_id: "SYN-OTHER" }],
]);
const store = openSyncStore(databasePath);
const server = createSyncServer({
  store,
  authenticate(header) {
    const match = /^Bearer ([^\s]+)$/.exec(header ?? "");
    return match ? fixturePrincipals.get(match[1]) : undefined;
  },
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(
    `Synthetic receiver listening at http://127.0.0.1:${server.address().port}; DB: ${databasePath}\n`,
  );
});

function close() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGINT", close);
process.on("SIGTERM", close);
