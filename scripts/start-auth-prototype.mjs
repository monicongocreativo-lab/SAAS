import { createPublicKey } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importPKCS8 } from "jose";
import { readLocalSupabaseEnvironment } from "../src/auth-prototype/local-supabase-environment.mjs";
import { createAuthPrototypeServer } from "../src/auth-prototype/server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keyHex = process.env.TAMAGO_AUTH_SESSION_KEY ?? "";
if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
  throw new Error(
    "TAMAGO_AUTH_SESSION_KEY must be a private 64-character hex key for this local experiment.",
  );
}

const dataDirectory = resolve(
  process.env.TAMAGO_AUTH_DATA_DIR ??
    `${homedir()}/.local/share/tamago-auth-prototype`,
);
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
chmodSync(dataDirectory, 0o700);
const databasePath = resolve(
  process.env.TAMAGO_AUTH_SESSION_DB ?? `${dataDirectory}/sessions.sqlite`,
);
const environment = readLocalSupabaseEnvironment(root);
const apiUrl = environment.API_URL;
const restUrl = environment.REST_URL;
const publishableKey = environment.PUBLISHABLE_KEY ?? environment.ANON_KEY;
const serviceRoleKey = environment.SERVICE_ROLE_KEY ?? environment.SERVICE_KEY;
if (!apiUrl || !restUrl || !publishableKey)
  throw new Error(
    "Local Supabase API is unavailable; start its local stack first.",
  );
const authApiUrl = new URL(apiUrl);
if (
  authApiUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost", "::1"].includes(authApiUrl.hostname)
)
  throw new Error(
    "Identity provisioning is restricted to local Supabase in this prototype.",
  );

const offlineGrantKeyFile = process.env.TAMAGO_OFFLINE_GRANT_SIGNING_KEY_FILE;
const offlineGrantKeyId = process.env.TAMAGO_OFFLINE_GRANT_SIGNING_KEY_ID;
let offlineGrantSigningKey;
let offlineGrantPublicJwk;
if (offlineGrantKeyFile || offlineGrantKeyId) {
  if (!offlineGrantKeyFile || !offlineGrantKeyId)
    throw new Error(
      "Set both TAMAGO_OFFLINE_GRANT_SIGNING_KEY_FILE and TAMAGO_OFFLINE_GRANT_SIGNING_KEY_ID.",
    );
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(offlineGrantKeyId))
    throw new Error("TAMAGO_OFFLINE_GRANT_SIGNING_KEY_ID is invalid.");
  const keyPath = resolve(offlineGrantKeyFile);
  const keyStats = lstatSync(keyPath);
  if (!keyStats.isFile() || (keyStats.mode & 0o077) !== 0)
    throw new Error(
      "The offline grant signing key must be a regular file with owner-only permissions (0600).",
    );
  const signingPem = readFileSync(keyPath, "utf8");
  offlineGrantSigningKey = await importPKCS8(signingPem, "ES256");
  offlineGrantPublicJwk = createPublicKey(signingPem).export({ format: "jwk" });
  if (
    offlineGrantPublicJwk.kty !== "EC" ||
    offlineGrantPublicJwk.crv !== "P-256" ||
    "d" in offlineGrantPublicJwk
  )
    throw new Error(
      "The offline grant signing key must be public-curve P-256.",
    );
}

const encryptionKey = Buffer.from(keyHex, "hex");
const server = createAuthPrototypeServer({
  apiUrl,
  restUrl,
  publishableKey,
  serviceRoleKey,
  allowedOrigins: (
    process.env.TAMAGO_AUTH_APP_ORIGINS ??
    process.env.TAMAGO_AUTH_APP_ORIGIN ??
    "http://127.0.0.1:8765,https://127.0.0.1:8766"
  )
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  sessionDbPath: databasePath,
  sessionEncryptionKey: encryptionKey,
  offlineGrantSigningKey,
  offlineGrantKeyId,
  offlineGrantPublicJwk,
});
encryptionKey.fill(0);

const port = Number(process.env.TAMAGO_AUTH_PORT ?? 8771);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("TAMAGO_AUTH_PORT must be a valid TCP port.");
server.listen(port, "127.0.0.1", () => {
  console.log(`Local auth prototype listening on http://127.0.0.1:${port}`);
  console.log(`Encrypted session store: ${databasePath}`);
});

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close(() => process.exit(0)));
