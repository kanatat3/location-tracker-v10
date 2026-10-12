// Serves the repo root (Index.html + icons) for the Playwright run. Usage: node scripts/serve.mjs [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.argv[2] || 8790);
const types = { ".html": "text/html; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".js": "text/javascript", ".json": "application/json" };
http.createServer((req, res) => {
  let file = decodeURIComponent(req.url.split("?")[0]);
  if (file === "/") file = "/Index.html";
  const target = path.join(root, path.normalize(file));
  if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "Content-Type": types[path.extname(target)] || "application/octet-stream", "Cache-Control": "no-store" });
  res.end(fs.readFileSync(target));
}).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));
