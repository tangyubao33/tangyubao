/*!
 * Portfolio analytics collector — Cloudflare Worker + D1.
 *
 * Routes
 *   POST /collect        event batches from analytics.js (public, write-only)
 *   GET  /api/summary    aggregated dashboard payload (Bearer token)
 *   GET  /api/raw        recent raw events for debugging (Bearer token)
 *   GET  /health         liveness + configuration check
 *
 * Secrets / vars (see analytics/README.md):
 *   DASHBOARD_TOKEN   secret, required
 *   SITE_ID           var, e.g. "tangyubao-portfolio"
 *   DB                D1 binding
 */
import { buildComparison } from "../../summary.js";

const VERSION = "1.0.0";
const MAX_BODY_BYTES = 128 * 1024;
const MAX_EVENTS = 80;
const MAX_PROPS_BYTES = 2400;
const MAX_RANGE_DAYS = 180;
const MAX_ROWS = 30000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }, CORS_HEADERS, extra)
  });
}

function textToken(request, url) {
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return (url.searchParams.get("token") || "").trim();
}

function safeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function authorized(request, env, url) {
  const expected = env.DASHBOARD_TOKEN;
  if (!expected) return { ok: false, reason: "DASHBOARD_TOKEN is not configured" };
  const token = textToken(request, url);
  if (!safeEqual(token, expected)) return { ok: false, reason: "unauthorized" };
  return { ok: true };
}

function allowedSites(env) {
  const list = [env.SITE_ID || "tangyubao-portfolio"];
  (env.ALLOWED_SITES || "").split(",").forEach((site) => {
    const clean = site.trim();
    if (clean) list.push(clean);
  });
  return list;
}

function normalizeProps(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "{}";
  const out = {};
  Object.keys(value).slice(0, 40).forEach((key) => {
    const cleanKey = String(key).slice(0, 40);
    const item = value[key];
    if (item === null || item === undefined) return;
    if (typeof item === "string") out[cleanKey] = item.slice(0, 200);
    else if (typeof item === "number") out[cleanKey] = isFinite(item) ? item : 0;
    else if (typeof item === "boolean") out[cleanKey] = item;
  });
  const text = JSON.stringify(out);
  return text.length > MAX_PROPS_BYTES ? "{}" : text;
}

function validEvent(event, now) {
  if (!event || typeof event !== "object") return false;
  if (typeof event.id !== "string" || event.id.length < 4 || event.id.length > 90) return false;
  if (typeof event.name !== "string" || !/^[a-z][a-z0-9_]{1,39}$/.test(event.name)) return false;
  if (!Number.isFinite(Number(event.ts))) return false;
  const ts = Number(event.ts);
  if (ts < now - 90 * 86400000 || ts > now + 2 * 86400000) return false;
  if (typeof event.sid !== "string" || !event.sid || event.sid.length > 90) return false;
  if (typeof event.vid !== "string" || !event.vid || event.vid.length > 90) return false;
  return true;
}

async function collect(request, env) {
  if (!env.DB) return json({ ok: false, error: "D1 binding missing" }, 503);
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);
  const body = await request.text();
  if (body.length > MAX_BODY_BYTES) return json({ ok: false, error: "payload too large" }, 413);

  let payload;
  try {
    payload = JSON.parse(body);
  } catch (error) {
    return json({ ok: false, error: "invalid json" }, 400);
  }
  if (!payload || typeof payload !== "object") return json({ ok: false, error: "invalid payload" }, 400);

  const sites = allowedSites(env);
  const site = String(payload.site || "").slice(0, 80);
  if (!sites.includes(site)) return json({ ok: false, error: "unknown site" }, 403);

  const now = Date.now();
  const receivedAt = now;
  // Coarse geography from the Cloudflare edge. The raw IP is never stored.
  const cf = request.cf || {};
  const country = cf.country ? String(cf.country).slice(0, 4) : "";
  const region = cf.region ? String(cf.region).slice(0, 60) : "";
  const city = cf.city ? String(cf.city).slice(0, 60) : "";
  const continent = cf.continent ? String(cf.continent).slice(0, 4) : "";
  const rows = Array.isArray(payload.events) ? payload.events.slice(0, MAX_EVENTS) : [];
  const statements = [];
  rows.forEach((event) => {
    if (!validEvent(event, now)) return;
    const ts = Number(event.ts);
    statements.push(env.DB.prepare(
      "INSERT OR IGNORE INTO events (id, ts, received_at, site, name, sid, vid, pid, screen, props, country, region, city, continent, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(
      String(event.id).slice(0, 90),
      Math.round(ts),
      receivedAt,
      site,
      String(event.name).slice(0, 40),
      String(event.sid).slice(0, 90),
      String(event.vid).slice(0, 90),
      String(event.pid || "").slice(0, 90),
      String(event.screen || "").slice(0, 30),
      normalizeProps(event.props),
      country,
      region,
      city,
      continent,
      new Date(ts).toISOString().slice(0, 10)
    ));
  });
  if (statements.length) {
    try {
      await env.DB.batch(statements);
    } catch (error) {
      return json({ ok: false, error: "database error" }, 500);
    }
  }
  return json({ ok: true, accepted: statements.length, received_at: receivedAt }, 200);
}

async function summary(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding missing" }, 503);
  const auth = authorized(request, env, url);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, auth.reason === "unauthorized" ? 401 : 503);

  const days = Math.max(1, Math.min(MAX_RANGE_DAYS, Number(url.searchParams.get("days")) || 30));
  const site = (url.searchParams.get("site") || env.SITE_ID || "tangyubao-portfolio").slice(0, 80);
  const now = Date.now();
  const from = now - days * 86400000 * 2; // current + comparison window
  const result = await env.DB.prepare(
    "SELECT id, ts, sid, vid, pid, screen, name, props, country, region, city, continent FROM events WHERE site = ? AND ts >= ? AND ts < ? ORDER BY ts ASC LIMIT ?"
  ).bind(site, Math.round(from), Math.round(now + 60000), MAX_ROWS).all();
  const rows = result.results || [];
  const comparison = buildComparison(rows, { days, to: now });
  comparison.range = { from: comparison.range.from, to: comparison.range.to, days };
  comparison.meta = Object.assign(comparison.current.meta, {
    truncated: rows.length >= MAX_ROWS,
    site
  });
  return json(Object.assign({ ok: true, source: "cloudflare", version: VERSION }, comparison));
}

async function raw(request, env, url) {
  if (!env.DB) return json({ ok: false, error: "D1 binding missing" }, 503);
  const auth = authorized(request, env, url);
  if (!auth.ok) return json({ ok: false, error: auth.reason }, auth.reason === "unauthorized" ? 401 : 503);
  const limit = Math.max(1, Math.min(300, Number(url.searchParams.get("limit")) || 100));
  const site = (url.searchParams.get("site") || env.SITE_ID || "tangyubao-portfolio").slice(0, 80);
  const result = await env.DB.prepare(
    "SELECT id, ts, sid, vid, pid, screen, name, props, country, region, city, continent, received_at FROM events WHERE site = ? ORDER BY received_at DESC LIMIT ?"
  ).bind(site, limit).all();
  return json({ ok: true, events: (result.results || []).map((row) => Object.assign({}, row)) });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    try {
      if (url.pathname === "/collect" && request.method === "POST") return await collect(request, env);
      if (url.pathname === "/api/summary" && request.method === "GET") return await summary(request, env, url);
      if (url.pathname === "/api/raw" && request.method === "GET") return await raw(request, env, url);
      if (url.pathname === "/health") {
        return json({
          ok: Boolean(env.DB),
          version: VERSION,
          token_configured: Boolean(env.DASHBOARD_TOKEN),
          site: env.SITE_ID || "tangyubao-portfolio"
        });
      }
      return json({ ok: false, error: "not found", routes: ["/collect", "/api/summary", "/api/raw", "/health"] }, 404);
    } catch (error) {
      return json({ ok: false, error: String((error && error.message) || error) }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    const cutoff = Date.now() - 180 * 86400000;
    ctx.waitUntil(env.DB.prepare("DELETE FROM events WHERE received_at < ?").bind(cutoff).run());
  }
};
