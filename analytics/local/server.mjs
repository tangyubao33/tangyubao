/*!
 * Local analytics collector — same HTTP contract as the Cloudflare Worker.
 *
 *   node analytics/local/server.mjs            # serves the site + collector
 *   node analytics/local/server.mjs --port 8788 --seed
 *
 * Then open http://127.0.0.1:8788/ for the site, or /dashboard for the board.
 * Events are appended to analytics/local/.data/events.jsonl (gitignored).
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { buildComparison } from "../summary.js";
import { generateSampleEvents } from "../tools/generate.mjs";

const here = resolve(fileURLToPath(new URL(".", import.meta.url)));
const root = resolve(here, "../..");
const dataDir = join(here, ".data");
const dataFile = join(dataDir, "events.jsonl");

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return args[index + 1] && !args[index + 1].startsWith("--") ? args[index + 1] : true;
};
const port = Number(argValue("port", 8788));
const seed = Boolean(argValue("seed", false));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2"
};

if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

let events = [];
const seen = new Set();
if (existsSync(dataFile)) {
  readFileSync(dataFile, "utf8").split("\n").forEach((line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event && event.id && !seen.has(event.id)) {
        seen.add(event.id);
        events.push(event);
      }
    } catch (error) {
      /* skip malformed line */
    }
  });
}

if (seed && events.length === 0) {
  const generated = generateSampleEvents({ days: 45, now: Date.now(), seed: 424242 });
  generated.forEach((event) => {
    seen.add(event.id);
    events.push(event);
  });
  writeFileSync(dataFile, generated.map((event) => JSON.stringify(event)).join("\n") + "\n");
  console.log(`seeded ${generated.length} synthetic events`);
}

function saveEvents(rows) {
  if (!rows.length) return;
  appendFileSync(dataFile, rows.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

function cors(response) {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  response.setHeader("Access-Control-Max-Age", "86400");
}

function json(response, status, body) {
  cors(response);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}

function readBody(request, limit = 262144) {
  return new Promise((resolvePromise, rejectPromise) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectPromise(new Error("payload too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectPromise);
  });
}

function validEvent(event) {
  if (!event || typeof event !== "object") return false;
  if (typeof event.id !== "string" || event.id.length < 4 || event.id.length > 90) return false;
  if (typeof event.name !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(event.name)) return false;
  if (!Number.isFinite(Number(event.ts))) return false;
  if (typeof event.sid !== "string" || !event.sid) return false;
  if (typeof event.vid !== "string" || !event.vid) return false;
  return true;
}

function serveStatic(request, response, pathname) {
  let filePath = normalize(join(root, decodeURIComponent(pathname)));
  if (!filePath.startsWith(root + sep) && filePath !== root) {
    response.writeHead(403);
    response.end("forbidden");
    return;
  }
  if (pathname === "/") filePath = join(root, "index.html");
  if (pathname === "/dashboard") filePath = join(root, "analytics", "dashboard.html");
  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  const extension = extname(filePath).toLowerCase();
  response.writeHead(200, {
    "Content-Type": MIME[extension] || "application/octet-stream",
    "Cache-Control": extension === ".html" || extension === ".js" || extension === ".mjs" ? "no-cache" : "public, max-age=300"
  });
  response.end(readFileSync(filePath));
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    cors(response);
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    if (pathname === "/collect" && request.method === "POST") {
      const body = await readBody(request);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        json(response, 400, { ok: false, error: "invalid json" });
        return;
      }
      const batch = Array.isArray(payload?.events) ? payload.events : [];
      const accepted = [];
      batch.slice(0, 80).forEach((event) => {
        if (!validEvent(event)) return;
        if (seen.has(event.id)) return;
        seen.add(event.id);
        accepted.push({
          id: event.id,
          ts: Number(event.ts),
          sid: String(event.sid),
          vid: String(event.vid),
          pid: String(event.pid || "").slice(0, 90),
          screen: String(event.screen || "").slice(0, 30),
          name: String(event.name),
          props: event.props && typeof event.props === "object" ? event.props : {},
          country: "LOCAL"
        });
      });
      events = events.concat(accepted);
      saveEvents(accepted);
      json(response, 200, { ok: true, accepted: accepted.length, received_at: Date.now() });
      return;
    }

    if (pathname === "/api/summary" && request.method === "GET") {
      const days = Math.max(1, Math.min(180, Number(url.searchParams.get("days")) || 30));
      const comparison = buildComparison(events, { days });
      json(response, 200, Object.assign({ ok: true, source: "local" }, comparison));
      return;
    }

    if (pathname === "/api/raw" && request.method === "GET") {
      const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit")) || 100));
      json(response, 200, { ok: true, total: events.length, events: events.slice(-limit).reverse() });
      return;
    }

    if (pathname === "/api/health") {
      json(response, 200, { ok: true, events: events.length, storage: dataFile });
      return;
    }

    if (pathname === "/sample-summary.js") {
      serveStatic(request, response, "/analytics/sample-summary.js");
      return;
    }

    if (pathname === "/" || pathname === "/dashboard") {
      serveStatic(request, response, pathname);
      return;
    }

    if (!/\.[a-z0-9]+$/i.test(pathname)) {
      serveStatic(request, response, pathname);
      return;
    }
    serveStatic(request, response, pathname);
  } catch (error) {
    json(response, 500, { ok: false, error: String(error && error.message || error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`site       http://127.0.0.1:${port}/`);
  console.log(`dashboard  http://127.0.0.1:${port}/dashboard`);
  console.log(`collector  http://127.0.0.1:${port}/collect  (${events.length} events in memory)`);
});
