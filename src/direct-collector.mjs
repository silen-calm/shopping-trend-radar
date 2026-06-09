import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildPayload, readData, writeJsonAtomic } from "./source.mjs";
import { applyMetricSnapshots } from "./metric-snapshots.mjs";
import { collectInstagramProvider, collectThreadsProvider } from "./provider-adapters.mjs";

const DAY = 864e5;
const DEFAULT_CONFIG = {
  youtube: {
    limitPerQuery: 12,
    maxAcceptedPerQuery: 5,
    concurrency: 3,
    timeoutMs: 30000,
    quality: {
      maxAgeDays: 45,
      minViews: 30000,
      minDailyViews: 10000,
      minMultiplier: 2
    },
    queries: []
  },
  instagram: { seedAccounts: [], queries: [], allowZeroViewPublic: false, publicDiscovery: true, provider: { enabled: true } },
  threads: { seedAccounts: [], queries: [], allowZeroViewPublic: false, publicDiscovery: true, provider: { enabled: true } }
};

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function toDate(uploadDate) {
  if (!uploadDate) return today();
  const text = String(uploadDate);
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return today();
}

function ageDays(date) {
  const ms = Date.now() - Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.floor(ms / DAY));
}

function compactNumber(n = 0) {
  if (n >= 1e8) return `${Math.round(n / 1e8)}억`;
  if (n >= 1e4) return `${Math.round(n / 1e4)}만`;
  return String(n || 0);
}

function bucketFor(mult) {
  if (mult >= 50) return "50배+";
  if (mult >= 10) return "10~50배";
  if (mult >= 5) return "5~10배";
  if (mult >= 3) return "3~5배";
  return "2~3배";
}

function qualityConfig(config) {
  return { ...DEFAULT_CONFIG.youtube.quality, ...(config.youtube?.quality || {}) };
}

function trendMetrics({ views, up, quality }) {
  const age = ageDays(up);
  const dailyViews = Math.round(Number(views || 0) / age);
  const multiplier = Math.round((dailyViews / 10000) * 10) / 10;
  const recencyBoost = Math.max(0.35, 1 - Math.min(age, quality.maxAgeDays) / (quality.maxAgeDays * 1.4));
  const score = Math.round((dailyViews * recencyBoost + Number(views || 0) * 0.015) * 10) / 10;
  return { age, dailyViews, multiplier, score };
}

function youtubeQualityDecision(candidate, quality) {
  const metrics = trendMetrics({ views: candidate.views, up: candidate.up, quality });
  const recentEnough = metrics.age <= quality.maxAgeDays;
  const highTraffic = candidate.views >= quality.minViews;
  const fastGrowth = metrics.dailyViews >= quality.minDailyViews || metrics.multiplier >= quality.minMultiplier;
  const accepted = recentEnough && (highTraffic || fastGrowth);
  const reasons = [];
  if (!recentEnough) reasons.push(`old>${quality.maxAgeDays}d`);
  if (!highTraffic) reasons.push(`views<${quality.minViews}`);
  if (!fastGrowth) reasons.push(`daily<${quality.minDailyViews}`);
  return {
    accepted,
    reason: accepted ? (fastGrowth ? "fast-growth" : "high-traffic") : reasons.join(","),
    ...metrics
  };
}

function publicHeaders() {
  return {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6",
    "user-agent": "Mozilla/5.0 (compatible; shopping-trend-radar-public-collector/1.0; no-login)"
  };
}

function loadConfig(root) {
  const file = join(root, "collector", "config.json");
  if (!existsSync(file)) return DEFAULT_CONFIG;
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, "utf8")) };
}

function parseJsonLines(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function runYtDlp(args, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const child = spawn("yt-dlp", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        YTDLP_NO_UPDATE: "1"
      }
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`yt-dlp timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code && !stdout.trim()) {
        reject(new Error(stderr.trim() || `yt-dlp exited with ${code}`));
      } else {
        resolve({ stdout, stderr, code });
      }
    });
  });
}

async function runLimited(items, limit, worker) {
  let index = 0;
  const output = [];
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      output[current] = await worker(items[current], current);
    }
  });
  await Promise.all(workers);
  return output;
}

async function fetchPublic(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: publicHeaders(),
      signal: controller.signal,
      redirect: "follow"
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function attr(html, name) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]);
  }
  return "";
}

function decodeHtml(text = "") {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function uniqueMatches(html, pattern) {
  return [...new Set([...html.matchAll(pattern)].map((match) => match[1]))];
}

function safeText(value = "") {
  return String(value).replace(/\s+/g, " ").trim();
}

function normalizeYoutube(video, query, config) {
  if (!video?.id) return null;
  if (Number(video.duration || 0) > 180) return null;
  const views = Number(video.view_count || 0);
  const up = toDate(video.upload_date || video.release_date || video.timestamp && new Date(video.timestamp * 1000).toISOString().slice(0, 10));
  const quality = qualityConfig(config);
  const decision = youtubeQualityDecision({ views, up }, quality);
  if (!decision.accepted) {
    return {
      rejected: true,
      id: video.id,
      title: video.title || "",
      ch: video.channel || video.uploader || "",
      views,
      up,
      reason: decision.reason,
      dailyViews: decision.dailyViews,
      sourceQuery: query.query
    };
  }
  const mult = Math.max(decision.multiplier, 0);
  return {
    id: video.id,
    views,
    mult,
    cat: query.cat || "릴스형",
    ch: video.channel || video.uploader || "",
    title: video.title || "",
    up,
    genre: query.genre || "기타",
    bucket: bucketFor(mult),
    ageDays: decision.age,
    dailyViews: decision.dailyViews,
    trendScore: decision.score,
    qualityReason: decision.reason,
    sourceQuery: query.query,
    collectedAt: new Date().toISOString(),
    lt: 0,
    collected: "direct-youtube"
  };
}

async function collectYoutube(config, status) {
  const rows = [];
  const queries = config.youtube?.queries || [];
  const limit = Number(config.youtube?.limitPerQuery || 8);
  const maxAccepted = Number(config.youtube?.maxAcceptedPerQuery || limit);
  await runLimited(queries, Number(config.youtube?.concurrency || 3), async (query) => {
    const search = `ytsearch${limit}:${query.query} #shorts`;
    try {
      const result = await runYtDlp([
        "--dump-json",
        "--skip-download",
        "--ignore-errors",
        "--no-warnings",
        "--no-playlist",
        "--socket-timeout",
        "8",
        "--extractor-retries",
        "1",
        "--retries",
        "1",
        search
      ], Number(config.youtube?.timeoutMs || 25000));
      const normalized = parseJsonLines(result.stdout).map((video) => normalizeYoutube(video, query, config)).filter(Boolean);
      const rejected = normalized.filter((item) => item.rejected);
      const items = normalized
        .filter((item) => !item.rejected)
        .sort((a, b) => b.trendScore - a.trendScore)
        .slice(0, maxAccepted);
      rows.push(...items);
      status.youtube.queries.push({ query: query.query, found: items.length, rejected: rejected.length });
      status.youtube.rejected.push(...rejected.slice(0, 20));
    } catch (error) {
      status.youtube.errors.push({ query: query.query, message: error.message });
    }
  });
  return rows;
}

async function collectInstagram(config, status) {
  const rows = [];
  rows.push(...await collectInstagramProvider(config, status));
  if (config.instagram?.publicDiscovery === false) return rows;
  const allowZeroViewPublic = config.instagram?.allowZeroViewPublic === true;
  for (const acct of config.instagram?.seedAccounts || []) {
    const url = `https://www.instagram.com/${acct}/`;
    try {
      const html = await fetchPublic(url);
      const codes = uniqueMatches(html, /instagram\.com\/reel\/([A-Za-z0-9_-]+)/g)
        .concat(uniqueMatches(html, /\/reel\/([A-Za-z0-9_-]+)/g));
      for (const code of [...new Set(codes)].slice(0, 12)) {
        const row = {
          kw: "계정수집",
          acct,
          views: 0,
          vtext: "0",
          summary: safeText(attr(html, "og:description") || attr(html, "description") || "무로그인 공개 수집 릴스"),
          fit: "중 · 무로그인 공개수집",
          link: `https://www.instagram.com/reel/${code}/`,
          up: today(),
          thumb: attr(html, "og:image"),
          code,
          lt: 0,
          collected: "direct-instagram-public"
        };
        if (allowZeroViewPublic) rows.push(row);
        else status.instagram.skipped.push({ acct, code, link: row.link, reason: "public-page-without-views" });
      }
      status.instagram.accounts.push({ acct, found: codes.length });
    } catch (error) {
      status.instagram.errors.push({ acct, message: error.message });
    }
  }
  return rows;
}

async function collectThreads(config, status) {
  const rows = [];
  rows.push(...await collectThreadsProvider(config, status));
  if (config.threads?.publicDiscovery === false) return rows;
  const allowZeroViewPublic = config.threads?.allowZeroViewPublic === true;
  for (const acct of config.threads?.seedAccounts || []) {
    const url = `https://www.threads.com/@${acct}`;
    try {
      const html = await fetchPublic(url);
      const posts = uniqueMatches(html, new RegExp(`threads\\.com\\/@${acct.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\/post\\/([A-Za-z0-9_-]+)`, "g"))
        .concat(uniqueMatches(html, /\/post\/([A-Za-z0-9_-]+)/g));
      for (const id of [...new Set(posts)].slice(0, 12)) {
        const row = {
          kw: "계정수집",
          acct,
          views: 0,
          vtext: "0",
          summary: safeText(attr(html, "og:description") || attr(html, "description") || "무로그인 공개 수집 스레드"),
          fit: "중 · 무로그인 공개수집",
          link: `https://www.threads.com/@${acct}/post/${id}`,
          up: today(),
          date: today(),
          collected: "direct-threads-public"
        };
        if (allowZeroViewPublic) rows.push(row);
        else status.threads.skipped.push({ acct, id, link: row.link, reason: "public-page-without-views" });
      }
      status.threads.accounts.push({ acct, found: posts.length });
    } catch (error) {
      status.threads.errors.push({ acct, message: error.message });
    }
  }
  return rows;
}

function mergeRows(existing, incoming, keyFn) {
  const seen = new Set(existing.map(keyFn));
  const added = [];
  for (const item of incoming) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    existing.push(item);
    added.push(item);
  }
  return added;
}

function pruneLowQualityDirectRows(data, config) {
  const quality = qualityConfig(config);
  const before = {
    youtube: data.youtube.length,
    instagram: data.instagram.length,
    threads: data.threads.length
  };

  data.youtube = data.youtube.filter((item) => {
    if (item.collected !== "direct-youtube") return true;
    return youtubeQualityDecision({ views: Number(item.views || 0), up: item.up || item.date || today() }, quality).accepted;
  });
  data.instagram = data.instagram.filter((item) => {
    if (item.collected !== "direct-instagram-public") return true;
    return config.instagram?.allowZeroViewPublic === true || Number(item.views || 0) > 0;
  });
  data.threads = data.threads.filter((item) => {
    if (item.collected !== "direct-threads-public") return true;
    return config.threads?.allowZeroViewPublic === true || Number(item.views || 0) > 0;
  });

  return {
    youtube: before.youtube - data.youtube.length,
    instagram: before.instagram - data.instagram.length,
    threads: before.threads - data.threads.length
  };
}

function writePublicCandidates(root, status) {
  writeJsonAtomic(join(root, "data", "public-candidates.json"), {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    note: "Instagram/Threads public no-login candidates without reliable engagement metrics. Not merged into ranking data.",
    instagram: status.instagram.skipped || [],
    threads: status.threads.skipped || []
  });
}

export async function runDirectCollection({ root }) {
  if (!root) throw new Error("runDirectCollection requires root");
  const startedAt = new Date().toISOString();
  const config = loadConfig(root);
  const current = readData(root);
  const data = {
    youtube: current.data.youtube.slice(),
    threads: current.data.threads.slice(),
    instagram: current.data.instagram.slice()
  };
  const pruned = pruneLowQualityDirectRows(data, config);
  const status = {
    ok: false,
    mode: "direct-no-login",
    startedAt,
    source: "youtube public no-login plus optional instagram/threads public-data providers with traffic-quality gates",
    before: current.counts,
    quality: qualityConfig(config),
    pruned,
    youtube: { queries: [], rejected: [], errors: [] },
    instagram: { accounts: [], skipped: [], errors: [] },
    threads: { accounts: [], skipped: [], errors: [] }
  };

  const [youtube, instagram, threads] = await Promise.all([
    collectYoutube(config, status),
    collectInstagram(config, status),
    collectThreads(config, status)
  ]);

  const addedYoutube = mergeRows(data.youtube, youtube, (item) => item.id);
  const addedInstagram = mergeRows(data.instagram, instagram, (item) => item.code || item.link);
  const addedThreads = mergeRows(data.threads, threads, (item) => item.link);
  const snapshotSummary = applyMetricSnapshots({ root, data });

  const payload = buildPayload(data, "direct:no-login");
  payload.collector = {
    mode: "direct-no-login",
    metricSnapshots: snapshotSummary,
    configHash: createHash("sha256").update(JSON.stringify(config)).digest("hex").slice(0, 12)
  };
  writeJsonAtomic(join(root, "data", "gallery-data.json"), payload);
  writePublicCandidates(root, status);

  Object.assign(status, {
    ok: true,
    finishedAt: new Date().toISOString(),
    version: payload.version,
    after: payload.counts,
    added: {
      youtube: addedYoutube.length,
      instagram: addedInstagram.length,
      threads: addedThreads.length
    },
    metricSnapshots: snapshotSummary
  });
  writeJsonAtomic(join(root, "data", "collector-status.json"), status);
  return { payload, status };
}
