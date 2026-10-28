import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import standaloneCode from "ajv/dist/standalone/index.js";
import { build } from "esbuild";

const root = new URL("../", import.meta.url);
process.chdir(fileURLToPath(root));
await mkdir(".generated", { recursive: true });
await mkdir("dist/experimental/recogidas", { recursive: true });
await mkdir("dist/experimental/feed-intake", { recursive: true });
await mkdir("dist/experimental/feed-inventory", { recursive: true });
await mkdir("dist/experimental/feed-supply", { recursive: true });
await mkdir("dist/experimental/admin", { recursive: true });
await mkdir("dist/experimental/custody", { recursive: true });
await mkdir("dist/experimental/classification/assets", { recursive: true });
await mkdir("dist/maquetas/clasificacion", { recursive: true });
await mkdir("dist/experimental/device-key-check", { recursive: true });
await mkdir("dist/experimental/security-key-check", { recursive: true });
await mkdir("dist/maquetas/recogidas/assets", { recursive: true });
const schema = JSON.parse(
  await readFile("contracts/collection-export.v1.schema.json", "utf8"),
);
const catalogSchema = JSON.parse(
  await readFile("contracts/operational-catalog.v1.schema.json", "utf8"),
);
const ajv = new Ajv({
  strict: true,
  allErrors: true,
  code: { source: true, esm: true },
});
await writeFile(
  ".generated/collection-validator.mjs",
  standaloneCode(ajv, ajv.compile(schema)),
);
await writeFile(
  ".generated/operational-catalog-validator.mjs",
  standaloneCode(ajv, ajv.compile(catalogSchema)),
);
await build({
  entryPoints: ["src/offline/app.mjs"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  minify: true,
  outfile: "dist/experimental/recogidas/app.js",
  legalComments: "linked",
});
for (const file of [
  "index.html",
  "offline.css",
  "manifest.webmanifest",
  "icon.svg",
])
  await copyFile(`src/offline/${file}`, `dist/experimental/recogidas/${file}`);
await build({
  entryPoints: ["src/feed-supply/feed-supply.js"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/experimental/feed-supply/feed-supply.js",
});
for (const file of ["index.html", "feed-supply.css"])
  await copyFile(
    `src/feed-supply/${file}`,
    `dist/experimental/feed-supply/${file}`,
  );
await build({
  entryPoints: ["src/feed-intake/intake.js"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/experimental/feed-intake/intake.js",
});
for (const file of ["index.html", "intake.css"])
  await copyFile(
    `src/feed-intake/${file}`,
    `dist/experimental/feed-intake/${file}`,
  );
await build({
  entryPoints: ["src/feed-inventory/inventory.js"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/experimental/feed-inventory/inventory.js",
});
await copyFile(
  "src/feed-inventory/index.html",
  "dist/experimental/feed-inventory/index.html",
);
for (const file of ["index.html", "admin.css", "admin.js"])
  await copyFile(`src/admin/${file}`, `dist/experimental/admin/${file}`);
await copyFile(
  "src/maquetas/clasificacion/clasificacion.css",
  "dist/experimental/classification/classification-base.css",
);
for (const file of ["index.html", "classification.css", "classification.js"])
  await copyFile(
    `src/classification/${file}`,
    `dist/experimental/classification/${file}`,
  );
for (const file of ["index.html", "clasificacion.css", "clasificacion.js"])
  await copyFile(
    `src/maquetas/clasificacion/${file}`,
    `dist/maquetas/clasificacion/${file}`,
  );
for (const file of [
  "tamago.png",
  "la-paulina.svg",
  "la-paulina-simbolo.png",
  "transagro.png",
])
  await copyFile(
    `src/maquetas/recogidas/assets/${file}`,
    `dist/experimental/classification/assets/${file}`,
  );
await build({
  entryPoints: ["src/custody/origin-summary.js"],
  bundle: true,
  format: "esm",
  target: ["es2022"],
  outfile: "dist/experimental/custody/origin-summary.js",
});
for (const file of ["index.html", "custody.css", "custody.js"])
  await copyFile(`src/custody/${file}`, `dist/experimental/custody/${file}`);
for (const file of [
  "index.html",
  "device-key-check.css",
  "device-key-check.js",
  "sw.js",
])
  await copyFile(
    `src/experimental/device-key-check/${file}`,
    `dist/experimental/device-key-check/${file}`,
  );
for (const file of [
  "index.html",
  "security-key-check.css",
  "security-key-check.js",
  "sw.js",
])
  await copyFile(
    `src/experimental/security-key-check/${file}`,
    `dist/experimental/security-key-check/${file}`,
  );
for (const file of ["index.html", "recogidas.css", "recogidas.js"])
  await copyFile(
    `src/maquetas/recogidas/${file}`,
    `dist/maquetas/recogidas/${file}`,
  );
for (const file of [
  "la-paulina.svg",
  "la-paulina-simbolo.png",
  "tamago.png",
  "transagro.png",
])
  await copyFile(
    `src/maquetas/recogidas/assets/${file}`,
    `dist/maquetas/recogidas/assets/${file}`,
  );
await copyFile(
  "contracts/collection-export.v1.schema.json",
  "dist/experimental/recogidas/collection-export.v1.schema.json",
);
await writeFile(
  "dist/experimental/recogidas/THIRD_PARTY_NOTICES.txt",
  `idb 8.0.4\n${await readFile("node_modules/idb/LICENSE", "utf8")}\nAjv 8.20.0 (generated validator)\n${(await readFile("node_modules/ajv/LICENSE", "utf8")).trimEnd()}\njose 6.2.13\n${(await readFile("node_modules/jose/LICENSE.md", "utf8")).trimEnd()}\n`,
);
const files = [
  "index.html",
  "app.js",
  "offline.css",
  "manifest.webmanifest",
  "icon.svg",
  "collection-export.v1.schema.json",
  "THIRD_PARTY_NOTICES.txt",
];
const digest = createHash("sha256");
for (const file of files)
  digest.update(await readFile(`dist/experimental/recogidas/${file}`));
const version = digest.digest("hex").slice(0, 16);
await writeFile(
  "dist/experimental/recogidas/sw.js",
  `// Generated by scripts/build-offline.mjs. Scope is experimental only.
const CACHE = 'tamago-dev002-shell-${version}';
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(FILES))));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data !== 'VERIFY_SHELL' || !event.ports[0]) return;
  event.waitUntil(caches.open(CACHE).then(async cache => {
    const resources = await Promise.all(FILES.map(file => cache.match(new URL(file, self.location))));
    if (!resources.every(Boolean)) {
      try { await cache.addAll(FILES); }
      catch { event.ports[0].postMessage(false); return; }
    }
    event.ports[0].postMessage(true);
  }));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const scopePath = new URL('./', self.location).pathname;
  if (!url.pathname.startsWith(scopePath)) return;
  const relative = url.pathname.slice(scopePath.length);
  const file = relative === '' ? 'index.html' : relative;
  if (!FILES.includes(file)) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(new URL(file, self.location));
    return cached || fetch(event.request);
  }));
});
`,
);
console.log(`DEV-002 shell ${version}; experimental only.`);

await copyFile(
  "src/feed-inventory/inventory.css",
  "dist/experimental/feed-inventory/inventory.css",
);
