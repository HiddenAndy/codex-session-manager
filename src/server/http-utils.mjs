import { createReadStream } from "node:fs";
import { extname, relative, resolve } from "node:path";

export function json(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(body);
}

export function text(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

export async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function serveStaticFile({ req, res, publicDir }) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const path = resolve(publicDir, `.${requested}`);
  const rel = relative(resolve(publicDir), resolve(path));
  if (rel.startsWith("..") || rel === ".." || resolve(rel) === rel) {
    text(res, 403, "Forbidden");
    return;
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
  };
  const stream = createReadStream(path);
  stream.on("open", () => {
    res.writeHead(200, {
      "content-type": types[extname(path)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    stream.pipe(res);
  });
  stream.on("error", () => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    text(res, 404, "Not found");
  });
}
