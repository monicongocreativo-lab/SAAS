import { readFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../dist", import.meta.url)));
const types = {
  ".html": "text/html",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const allowedApiPath = (path) =>
  /^\/v1\/companies\/[0-9a-f-]+\/feed-inventory\/(?:ledger-activate|ledger-post|ledger-(?:review|entries|actions)\/[0-9a-f-]+|corrections|history\/(?:binding|cutoff)\/[0-9a-f-]+|context|catalog|bindings(?:\/(?:supply|delivery|count)\/[0-9a-f-]+)?|cutoff-decisions|previews\/[0-9a-f-]+)$/.test(
    path,
  ) ||
  /^\/v1\/companies\/[0-9a-f-]+\/feed-opening(?:s(?:\/[0-9a-f-]+)?|-counts|-approvals)$/.test(
    path,
  ) ||
  /^\/v1\/companies\/[0-9a-f-]+\/feed-deliveries(?:\/[0-9a-f-]+)?$/.test(
    path,
  ) ||
  /^\/v1\/companies\/[0-9a-f-]+\/feed-suppl(?:ies(?:\/[0-9a-f-]+)?|y-context)$/.test(
    path,
  ) ||
  /^\/v1\/auth\/(?:login|logout|me|change-initial-password|confirm-password)$/.test(
    path,
  ) ||
  path === "/v1/offline-grant-keys" ||
  /^\/v1\/companies\/[0-9a-f-]+\/manual-classification(?:s(?:\/[0-9a-f-]+)?|-inputs|-catalog)$/.test(
    path,
  ) ||
  /^\/v1\/companies\/[0-9a-f-]+\/custody-(?:origins|flow|transfers(?:\/[0-9a-f-]+(?:\/receipt)?)?|case-actions|incidents\/[0-9a-f-]+\/(?:actions|evidence))$/.test(
    path,
  ) ||
  /^\/v1\/companies(?:\/[0-9a-f-]+)?$/.test(path) ||
  /^\/v1\/companies\/[0-9a-f-]+\/operational-catalog$/.test(path) ||
  /^\/v1\/companies\/[0-9a-f-]+\/offline-collection-events$/.test(path) ||
  /^\/v1\/companies\/[0-9a-f-]+\/offline-capture-grants$/.test(path) ||
  /^\/v1\/companies\/[0-9a-f-]+\/identities(?:\/provisionings\/[0-9a-f-]+\/acknowledge|\/provisionings\/pending)?$/.test(
    path,
  ) ||
  /^\/v1\/companies\/[0-9a-f-]+\/memberships(?:\/[0-9a-f-]+)?$/.test(path);

export function makeServer({
  authUpstream = process.env.TAMAGO_AUTH_UPSTREAM ?? "http://127.0.0.1:8771",
} = {}) {
  const upstream = new URL(authUpstream);
  if (
    upstream.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "::1"].includes(upstream.hostname) ||
    upstream.pathname !== "/"
  )
    throw new Error("Auth proxy must target a local HTTP loopback server.");

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/v1/")) {
        if (
          !allowedApiPath(url.pathname) ||
          !["GET", "POST", "PATCH"].includes(req.method)
        ) {
          res.writeHead(404, { "Cache-Control": "no-store" }).end();
          return;
        }
        const headers = {};
        for (const name of [
          "cookie",
          "origin",
          "content-type",
          "content-length",
          "idempotency-key",
          "x-tamago-user",
        ])
          if (req.headers[name]) headers[name] = req.headers[name];
        const proxy = httpRequest(
          new URL(`${url.pathname}${url.search}`, upstream),
          { method: req.method, headers, timeout: 10_000 },
          (upstreamResponse) => {
            res.writeHead(upstreamResponse.statusCode ?? 502, {
              "Cache-Control": "no-store",
              ...(upstreamResponse.headers["content-type"]
                ? { "Content-Type": upstreamResponse.headers["content-type"] }
                : {}),
              ...(upstreamResponse.headers["set-cookie"]
                ? { "Set-Cookie": upstreamResponse.headers["set-cookie"] }
                : {}),
            });
            upstreamResponse.pipe(res);
          },
        );
        proxy.on("timeout", () =>
          proxy.destroy(new Error("auth upstream timeout")),
        );
        proxy.on("error", () => {
          if (!res.headersSent)
            res.writeHead(503, {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            });
          if (!res.writableEnded)
            res.end('{"error":"AUTH_GATEWAY_UNAVAILABLE"}');
        });
        req.pipe(proxy);
        return;
      }
      const path = resolve(
        root,
        `.${decodeURIComponent(url.pathname)}${url.pathname.endsWith("/") ? "index.html" : ""}`,
      );
      if (!path.startsWith(root + sep)) {
        res.writeHead(403).end();
        return;
      }
      const data = await readFile(path);
      res.writeHead(200, {
        "Content-Type": types[extname(path)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      res.end(data);
    } catch {
      res.writeHead(404).end();
    }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  makeServer().listen(8765, "127.0.0.1", () =>
    console.log(
      "http://127.0.0.1:8765/experimental/recogidas/ · solo datos ficticios",
    ),
  );
}
