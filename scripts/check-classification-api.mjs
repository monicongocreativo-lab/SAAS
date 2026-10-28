import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Intentionally fails without explicit opt-in; omitted tests are not evidence.
if (
  process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST !== "1" ||
  !process.env.TAMAGO_CUSTODY_TEST_ENV_FILE
)
  throw new Error(
    "Explicit local test authorization and private environment file required.",
  );
const environment = JSON.parse(
  readFileSync(process.env.TAMAGO_CUSTODY_TEST_ENV_FILE, "utf8"),
);
const endpoint = new URL(environment.API_URL);
if (
  endpoint.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
  !["tamago-dev010b", "tamago-dev010d"].includes(environment.TEST_STACK)
)
  throw new Error("Use a disposable DEV-010B/010D loopback provider.");
const result = spawnSync(
  process.execPath,
  [
    "--test",
    fileURLToPath(
      new URL(
        "../tests/supabase/manual-classification.test.mjs",
        import.meta.url,
      ),
    ),
  ],
  { stdio: "inherit", env: process.env },
);
if (result.error)
  throw new Error("Could not run classification integration check.");
process.exitCode = result.status ?? 1;
