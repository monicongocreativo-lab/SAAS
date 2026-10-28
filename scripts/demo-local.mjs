import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startRealCustodyFixture } from "../tests/fixtures/custody-real-server.mjs";

const exec = promisify(execFile);
const root = new URL("../", import.meta.url);
process.chdir(fileURLToPath(root));
const privateRoot = new URL(".generated/demo-private/", root);
const project = new URL(".generated/tamago-dev012l-demo/", root);
const projectPath = fileURLToPath(project);
const cli = fileURLToPath(
  new URL("node_modules/supabase/dist/supabase.js", root),
);
const home = fileURLToPath(new URL("supabase-home/", privateRoot));
const cliEnv = {
  ...process.env,
  SUPABASE_HOME: home,
  SUPABASE_TELEMETRY_DISABLED: "true",
};
const stackArgs = ["--workdir", projectPath, "--stack", "demo", "--yes"];
const envFile = new URL("env.json", privateRoot);
let fixture;
let cleanup;
let started = false;

async function stop() {
  if (!cleanup)
    cleanup = (async () => {
      if (fixture) {
        await fixture.close();
        const remaining = await fixture.provider(
          `/rest/v1/companies?id=in.(${fixture.ids.company},${fixture.ids.foreign})&select=id`,
        );
        if (remaining.length)
          throw new Error("La retirada de fixtures no se confirmó.");
      }
      await rm(new URL("dist/demo/", root), { recursive: true, force: true });
      await rm(envFile, { force: true });
      if (started)
        await exec(process.execPath, [cli, "stack", "stop", ...stackArgs], {
          env: cliEnv,
          maxBuffer: 4 * 1024 * 1024,
        });
      console.log(
        "Demostración detenida; fixtures retirados y volúmenes conservados.",
      );
    })();
  return cleanup;
}

try {
  await mkdir(privateRoot, { recursive: true, mode: 0o700 });
  await chmod(privateRoot, 0o700);
  await mkdir(new URL("supabase/migrations/", project), { recursive: true });
  const config = (
    await readFile(new URL("supabase/config.toml", root), "utf8")
  ).replace(/^project_id\s*=.*$/m, 'project_id = "tamago-dev012l"');
  await writeFile(new URL("supabase/config.toml", project), config);
  await writeFile(
    new URL("supabase/seed.sql", project),
    "-- Demo: fixtures created through authenticated RPCs.\n",
  );
  for (const name of await readdir(new URL("supabase/migrations/", root))) {
    if (name.endsWith(".sql"))
      await writeFile(
        new URL(`supabase/migrations/${name}`, project),
        await readFile(new URL(`supabase/migrations/${name}`, root)),
      );
  }
  console.log(
    "Preparando Auth/Postgres Docker local exclusivo. La primera descarga puede tardar.",
  );
  started = true;
  const { stdout } = await exec(
    process.execPath,
    [
      cli,
      "stack",
      "start",
      ...stackArgs,
      "--runtime",
      "docker",
      "--exclude",
      "realtime,storage,functions,studio,mail,analytics,pooler",
      "--eager",
    ],
    { env: cliEnv, maxBuffer: 8 * 1024 * 1024, timeout: 300000 },
  );
  let environment;
  for (const line of stdout.split("\n")) {
    try {
      const record = JSON.parse(line);
      if (record.env) environment = record.env;
    } catch {
      /* Progress text is not credential data. */
    }
  }
  if (!environment?.API_URL)
    throw new Error(
      "El CLI no devolvió un entorno local. No se imprimen sus credenciales.",
    );
  const url = new URL(environment.API_URL);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost"].includes(url.hostname)
  )
    throw new Error("La demostración solo admite proveedor local.");
  environment.TEST_STACK = "tamago-dev012l";
  await writeFile(envFile, JSON.stringify(environment), { mode: 0o600 });
  await chmod(envFile, 0o600);
  process.env.TAMAGO_ALLOW_LOCAL_SUPABASE_TEST = "1";
  process.env.TAMAGO_CUSTODY_TEST_ENV_FILE = fileURLToPath(envFile);
  fixture = await startRealCustodyFixture({ seedTransfers: false });
  const { ids, users } = fixture;
  const scope = {
    company_id: ids.company,
    site_id: ids.site,
    house_id: ids.house,
    lot_id: ids.lot,
  };
  const rpc = (name, event, role = "director") =>
    fixture.rpc(name, { p_event: event }, users[role].token);
  const item = (kind) => ({
    ...scope,
    format: "tamago.feed-catalog-item",
    schema_version: 1,
    item_id: randomUUID(),
    kind,
    code: kind === "product" ? "F1" : "L1",
    label: kind === "product" ? "SYN-Alimento demo" : "SYN-Bodega demo",
    unit: kind === "product" ? "BAG_40KG" : null,
    reason: "SYN-Preparación de demostración local",
  });
  const product = item("product"),
    location = item("location");
  for (const event of [product, location])
    await rpc("record_feed_catalog_item", event);
  const count = {
    ...scope,
    format: "tamago.feed-opening-count",
    schema_version: 1,
    opening_id: randomUUID(),
    count_id: randomUUID(),
    business_date: "2026-10-27",
    cutoff_at: "2026-10-27T12:00:00.000Z",
    product_declared: product.label,
    location_declared: location.label,
    quantity: "10",
    unit: "BAG_40KG",
    evidence_reference: "SYN-Acta ficticia de demostración",
    notes: null,
    expected_revision: 0,
    previous_count_id: null,
  };
  await rpc("record_feed_opening_count", count, "capture");
  await rpc("approve_feed_opening", {
    format: "tamago.feed-opening-approval",
    schema_version: 1,
    action_id: randomUUID(),
    company_id: ids.company,
    opening_id: count.opening_id,
    count_id: count.count_id,
    expected_revision: 1,
    reason: "SYN-Conteo ficticio revisado",
  });
  const delivery = {
    ...scope,
    format: "tamago.feed-delivery",
    schema_version: 1,
    event_id: randomUUID(),
    business_date: "2026-10-27",
    occurred_at: "2026-10-27T13:00:00.000Z",
    product_declared: product.label,
    location_declared: location.label,
    quantity: "3",
    unit: "BAG_40KG",
    physical_batch_declared: null,
    notes: null,
    supplier_declared: null,
    delivery_reference_declared: "SYN-Remisión ficticia",
  };
  await rpc("record_feed_delivery", delivery, "capture");
  for (const [kind, id] of [
    ["count", count.count_id],
    ["delivery", delivery.event_id],
  ])
    await rpc("bind_feed_fact", {
      format: "tamago.feed-fact-binding",
      schema_version: 1,
      binding_id: randomUUID(),
      company_id: ids.company,
      source_kind: kind,
      source_id: id,
      product_id: product.item_id,
      location_id: location.item_id,
      reason: "SYN-Identidad revisada de la demostración",
    });
  const args = {
    p_company_id: ids.company,
    p_opening_id: count.opening_id,
    p_through_at: "2026-10-27T17:00:00.000Z",
  };
  const review = await fixture.rpc(
    "get_feed_ledger_review",
    args,
    users.director.token,
  );
  if (
    review.status !== "needs_activation" ||
    review.proposed_balance_bags !== "13"
  )
    throw new Error(
      "El caso ficticio inicial no coincide con 10 + 3 = 13 sin activar.",
    );
  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const field = (label, value) =>
    `<label>${escapeHtml(label)}<input readonly value="${escapeHtml(value)}"><button type="button" data-copy>Copiar</button></label>`;
  const accounts = [
    ["Dirección", users.director],
    ["Registro", users.capture],
  ]
    .map(
      ([label, user]) =>
        `<section><h2>${label} · cuenta ficticia</h2>${field("Correo", user.email)}${field("Contraseña ficticia", user.password)}</section>`,
    )
    .join("");
  await mkdir(new URL("dist/demo/", root), { recursive: true });
  await writeFile(
    new URL("dist/demo/index.html", root),
    `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demostración local · Tamago</title><style>body{font:18px system-ui;max-width:760px;margin:24px auto;padding:0 16px;color:#193b30}section{border:1px solid #b7cbc1;border-radius:12px;padding:16px;margin:16px 0}label{display:block;margin:12px 0}input{display:block;width:95%;padding:10px;font:inherit}button,a{font:inherit}button{padding:10px;margin:6px 0}a{display:inline-block;padding:12px 0}</style><h1>Demostración técnica local</h1><p>Solo datos ficticios. Conexión local; no producción ni servidor público. La captura de alimento requiere conexión.</p>${accounts}<section><h2>Caso inicial</h2><p>SYN-LOTE · Galpón ficticio. Conteo aprobado10 + recepción3 =13 bultos, todavía sin activar.</p>${field("ID de apertura", count.opening_id)}${field("ID de recepción", delivery.event_id)}<p>Ventana:27/10/2026,12:00 Colombia. Producto:SYN-Alimento demo. Ubicación:SYN-Bodega demo.</p><a href="../experimental/feed-inventory/">Inventario de alimento</a><br><a href="../experimental/feed-supply/">Suministro de alimento</a><br><a href="../experimental/feed-intake/">Recepciones y conteos</a></section><p>Leer docs/DEMO.md para roles,guion,recuperación y límites. Para terminar usa Ctrl+C en la terminal de arranque;se retiran únicamente estos fixtures.</p><p id="status" role="status"></p><script>for(const b of document.querySelectorAll('[data-copy]'))b.onclick=async()=>{try{await navigator.clipboard.writeText(b.parentElement.querySelector('input').value);document.querySelector('#status').textContent='Copiado';}catch{document.querySelector('#status').textContent='Selecciona el texto del campo y cópialo manualmente';}};</script></html>`,
    { mode: 0o600 },
  );
  console.log(`Demostración lista: ${fixture.origin}/demo/`);
  console.log(
    "Abre esa URL en este ordenador. Credenciales ficticias en la página; no hay claves del proveedor en el HTML.",
  );
  console.log(
    "Ctrl+C cierra servidores y retira únicamente los fixtures de esta sesión.",
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(
      signal,
      () =>
        void stop()
          .then(() => process.exit(0))
          .catch(() => {
            console.error(
              "No se completó el cierre. Conserva el entorno privado e inspecciona su stack exclusivo; no borres bases ajenas.",
            );
            process.exit(1);
          }),
    );
} catch {
  console.error(
    "No se pudo preparar la demostración local. Comprueba Docker,versiones y puerto/proveedor local. No se imprimen errores que puedan contener credenciales.",
  );
  try {
    await stop();
  } catch {
    console.error(
      "El stack exclusivo puede seguir activo. No borrar datos ajenos; revisar su estado local.",
    );
  }
  process.exitCode = 1;
}
