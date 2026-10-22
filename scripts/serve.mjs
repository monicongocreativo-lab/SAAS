import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
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
};
export function makeServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
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
