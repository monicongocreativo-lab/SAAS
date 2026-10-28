import { createPublicKey, X509Certificate } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { createServer } from "node:https";
import { isIP } from "node:net";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../dist/", import.meta.url)));
const host = process.env.TAMAGO_DEVICE_CHECK_HOST ?? "";
const certPath = process.env.TAMAGO_DEVICE_CHECK_TLS_CERT_FILE;
const keyPath = process.env.TAMAGO_DEVICE_CHECK_TLS_KEY_FILE;
const port = Number(process.env.TAMAGO_DEVICE_CHECK_PORT ?? 8766);
const allowedFiles = new Set([
  "/experimental/device-key-check/",
  "/experimental/device-key-check/index.html",
  "/experimental/device-key-check/device-key-check.css",
  "/experimental/device-key-check/device-key-check.js",
  "/experimental/device-key-check/sw.js",
]);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

if (isIP(host) !== 4 || !isPrivateIpv4(host))
  throw new Error(
    "Set TAMAGO_DEVICE_CHECK_HOST to this Mac's private Wi-Fi IPv4 address.",
  );
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("TAMAGO_DEVICE_CHECK_PORT must be a valid TCP port.");
if (!certPath || !keyPath)
  throw new Error(
    "Set TAMAGO_DEVICE_CHECK_TLS_CERT_FILE and TAMAGO_DEVICE_CHECK_TLS_KEY_FILE.",
  );

const keyStats = lstatSync(resolve(keyPath));
if (!keyStats.isFile() || (keyStats.mode & 0o077) !== 0)
  throw new Error(
    "The temporary TLS private key must be a regular file with owner-only permissions (0600).",
  );
const cert = new X509Certificate(readFileSync(resolve(certPath)));
if (!cert.checkIP(host))
  throw new Error(
    "The TLS certificate must contain this exact Wi-Fi IPv4 address in subjectAltName.",
  );
const certKey = cert.publicKey.export({ type: "spki", format: "der" });
const privateKey = createPublicKey(readFileSync(resolve(keyPath))).export({
  type: "spki",
  format: "der",
});
if (!certKey.equals(privateKey))
  throw new Error("The TLS certificate and private key do not match.");

const server = createServer(
  {
    cert: readFileSync(resolve(certPath)),
    key: readFileSync(resolve(keyPath)),
  },
  async (request, response) => {
    const url = new URL(request.url ?? "/", `https://${host}:${port}`);
    if (request.method !== "GET" || !allowedFiles.has(url.pathname)) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return;
    }
    const relative = url.pathname.endsWith("/")
      ? `${url.pathname}index.html`
      : url.pathname;
    const file = resolve(root, `.${relative}`);
    if (!file.startsWith(root + sep)) {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
      return;
    }
    try {
      const body = readFileSync(file);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type":
          contentTypes[extname(file)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'; script-src 'self'; style-src 'self'; connect-src 'self'",
      });
      response.end(body);
    } catch {
      response.writeHead(404, { "Cache-Control": "no-store" }).end();
    }
  },
);

server.listen(port, host, () => {
  console.log(
    `Local static-only device check: https://${host}:${port}/experimental/device-key-check/`,
  );
  console.log(
    "No API proxy, authentication, business data or production service is exposed.",
  );
});

for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => server.close(() => process.exit(0)));

function isPrivateIpv4(address) {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  );
}
