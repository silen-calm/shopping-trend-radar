#!/usr/bin/env node
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheStats, getCachedThumbAny } from "./src/cache.mjs";
import { runDirectCollection } from "./src/direct-collector.mjs";
import { buildPayload, readData, writeJsonAtomic } from "./src/source.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1] || process.env.PORT || 8765);
const collectEverySeconds = Number(process.env.COLLECT_EVERY_SECONDS || 86400);
const collectStaleSeconds = Number(process.env.COLLECT_STALE_SECONDS || collectEverySeconds || 86400);
const collectOnStartup = process.env.COLLECT_ON_STARTUP !== "0";
let collectInFlight = null;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) reject(new Error("Body too large"));
    });
    req.on("end", () => resolveBody(body));
    req.on("error", reject);
  });
}

async function ensureData() {
  mkdirSync(join(ROOT, "data"), { recursive: true });
  mkdirSync(join(ROOT, "cache", "thumbs"), { recursive: true });
  if (!existsSync(join(ROOT, "data", "gallery-data.json"))) {
    writeJsonAtomic(join(ROOT, "data", "gallery-data.json"), buildPayload({ youtube: [], threads: [], instagram: [] }, "direct:no-login"));
  }
}

async function collectAndReport() {
  if (collectInFlight) return collectInFlight;
  collectInFlight = collectAndReportNow().finally(() => {
    collectInFlight = null;
  });
  return collectInFlight;
}

async function collectAndReportNow() {
  try {
    return await runDirectCollection({ root: ROOT });
  } catch (error) {
    writeJsonAtomic(join(ROOT, "data", "collector-status.json"), {
      ok: false,
      failedAt: new Date().toISOString(),
      message: error.message
    });
    throw error;
  }
}

function readCollectorStatus() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "data", "collector-status.json"), "utf8"));
  } catch {
    return {};
  }
}

function lastCollectionTime(status = readCollectorStatus()) {
  const value = status.finishedAt || status.startedAt || status.failedAt || "";
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : 0;
}

function collectionAgeSeconds(status = readCollectorStatus()) {
  const last = lastCollectionTime(status);
  if (!last) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - last) / 1000));
}

function shouldCollectOnStartup() {
  if (!collectOnStartup || collectStaleSeconds <= 0) return false;
  return collectionAgeSeconds() >= collectStaleSeconds;
}

function logCollectResult(reason, payload, status) {
  console.log(`[collect:${reason}] ${payload.generatedAt} ${JSON.stringify(payload.counts)} added=${JSON.stringify(status.added)}`);
}

function logCollectFailure(reason, error) {
  console.error(`[collect:${reason}:failed] ${error.message}`);
}

function statusPayload() {
  const data = readData(ROOT);
  let warmStatus = {};
  const collectorStatus = readCollectorStatus();
  try {
    warmStatus = JSON.parse(readFileSync(join(ROOT, "cache", "thumbs", "warm-status.json"), "utf8"));
  } catch {
    warmStatus = {};
  }
  return {
    version: data.version,
    generatedAt: data.generatedAt,
    sourceUrl: data.sourceUrl,
    counts: data.counts,
    dateRanges: data.dateRanges,
    collector: collectorStatus,
    scheduler: {
      mode: "direct-no-login",
      collectOnStartup,
      collectEverySeconds,
      collectStaleSeconds,
      stale: collectionAgeSeconds(collectorStatus) >= collectStaleSeconds,
      running: Boolean(collectInFlight),
      lastCollectionAgeSeconds: collectionAgeSeconds(collectorStatus)
    },
    cache: cacheStats(ROOT),
    cacheWarm: warmStatus
  };
}

async function handleApi(req, res, url) {
  if (url.pathname === "/api/data" && req.method === "GET") {
    const data = readData(ROOT);
    json(res, 200, data);
    return true;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    json(res, 200, statusPayload());
    return true;
  }

  if (url.pathname === "/api/collect" && req.method === "POST") {
    const { payload, status } = await collectAndReport();
    json(res, 200, { ok: true, version: payload.version, counts: payload.counts, generatedAt: payload.generatedAt, added: status.added, warnings: {
      youtube: status.youtube.errors.length,
      instagram: status.instagram.errors.length,
      threads: status.threads.errors.length
    } });
    return true;
  }

  if (url.pathname === "/api/refresh" && req.method === "POST") {
    json(res, 410, {
      ok: false,
      message: "Original gallery sync is disabled. Use POST /api/collect for direct no-login platform collection."
    });
    return true;
  }

  if (url.pathname === "/api/deleted" && req.method === "GET") {
    const file = join(ROOT, "data", "deleted_ids.json");
    if (!existsSync(file)) json(res, 200, []);
    else json(res, 200, JSON.parse(readFileSync(file, "utf8")));
    return true;
  }

  if (url.pathname === "/api/deleted" && req.method === "POST") {
    const body = await readBody(req);
    const parsed = JSON.parse(body || "[]");
    if (!Array.isArray(parsed)) throw new Error("deleted payload must be an array");
    writeFileSync(join(ROOT, "data", "deleted_ids.json"), `${JSON.stringify([...new Set(parsed)], null, 2)}\n`, "utf8");
    json(res, 200, { ok: true, count: parsed.length });
    return true;
  }

  return false;
}

async function handleThumb(req, res, url) {
  if (url.pathname !== "/thumb") return false;
  const raw = url.searchParams.get("url");
  if (!raw) {
    json(res, 400, { ok: false, message: "Missing url" });
    return true;
  }
  try {
    const cached = await getCachedThumbAny(ROOT, [raw, ...url.searchParams.getAll("fallback")]);
    res.writeHead(200, {
      "content-type": cached.contentType,
      "cache-control": "public, max-age=31536000, immutable",
      "x-cache": cached.hit ? "HIT" : "MISS"
    });
    createReadStream(cached.path).pipe(res);
  } catch (error) {
    json(res, 502, { ok: false, message: error.message });
  }
  return true;
}

function serveStatic(res, pathname) {
  const clean = pathname === "/" ? "/index.html" : pathname;
  const file = resolve(join(ROOT, clean));
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(file)] || "application/octet-stream",
    "cache-control": clean === "/index.html" ? "no-store" : "public, max-age=60"
  });
  createReadStream(file).pipe(res);
}

await ensureData();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (await handleApi(req, res, url)) return;
    if (await handleThumb(req, res, url)) return;
    serveStatic(res, url.pathname);
  } catch (error) {
    json(res, 500, { ok: false, message: error.message });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Shopping Trend Radar running at http://127.0.0.1:${port}/`);
  console.log("Original gallery sync: disabled");
  console.log(collectEverySeconds > 0 ? `Direct no-login collect: every ${collectEverySeconds}s` : "Direct no-login collect: interval disabled");
  console.log(collectOnStartup ? `Startup freshness check: stale after ${collectStaleSeconds}s` : "Startup freshness check: disabled");
});

if (shouldCollectOnStartup()) {
  setTimeout(() => {
    collectAndReport()
      .then(({ payload, status }) => logCollectResult("startup", payload, status))
      .catch((error) => logCollectFailure("startup", error));
  }, 1000);
}

if (collectEverySeconds > 0) {
  setInterval(() => {
    collectAndReport()
      .then(({ payload, status }) => logCollectResult("interval", payload, status))
      .catch((error) => logCollectFailure("interval", error));
  }, collectEverySeconds * 1000);
}
