import { execFileSync } from "node:child_process";

export function readLocalSupabaseEnvironment(cwd = process.cwd()) {
  const output = execFileSync(
    "pnpm",
    ["--silent", "supabase", "status", "--env"],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        SUPABASE_NO_UPDATE_NOTIFIER: "1",
        SUPABASE_TELEMETRY_DISABLED: "1",
      },
    },
  );
  let environment;
  try {
    environment = JSON.parse(output);
  } catch {
    throw new Error("Supabase local no devolvió un entorno JSON válido.");
  }
  const api = new URL(environment.API_URL ?? "");
  if (
    api.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(api.hostname)
  )
    throw new Error(
      "Se rechaza la prueba salvo que Supabase sea HTTP local en loopback.",
    );
  return environment;
}
