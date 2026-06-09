import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./source.mjs";

const DAY = 864e5;
const MAX_HISTORY = 45;

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function number(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const normalized = String(value).replace(/,/g, "").trim();
  const match = normalized.match(/^([\d.]+)\s*([kKmM만천억])?$/);
  if (!match) return fallback;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return fallback;
  const unit = match[2];
  if (unit === "k" || unit === "K" || unit === "천") return Math.round(base * 1_000);
  if (unit === "m" || unit === "M") return Math.round(base * 1_000_000);
  if (unit === "만") return Math.round(base * 10_000);
  if (unit === "억") return Math.round(base * 100_000_000);
  return Math.round(base);
}

function firstNumber(item, paths) {
  for (const path of paths) {
    const value = getPath(item, path);
    if (value != null && value !== "") return number(value, 0);
  }
  return 0;
}

function getPath(item, path) {
  return String(path).split(".").reduce((value, key) => {
    if (value == null) return undefined;
    return value[key];
  }, item);
}

export function itemKey(platform, item) {
  if (platform === "youtube") return item.id ? `youtube:${item.id}` : "";
  if (platform === "instagram") return item.code || item.id || item.link ? `instagram:${item.code || item.id || item.link}` : "";
  if (platform === "threads") return item.id || item.code || item.link ? `threads:${item.id || item.code || item.link}` : "";
  return "";
}

export function currentMetrics(item) {
  return {
    views: firstNumber(item, ["views", "view_count", "viewCount", "video_views", "videoViewCount", "play_count", "playCount", "metrics.views"]),
    likes: firstNumber(item, ["likes", "like_count", "likeCount", "metrics.likes"]),
    comments: firstNumber(item, ["comments", "comment_count", "commentCount", "metrics.comments"]),
    shares: firstNumber(item, ["shares", "share_count", "shareCount", "metrics.shares"]),
    replies: firstNumber(item, ["replies", "reply_count", "replyCount", "metrics.replies"]),
    reposts: firstNumber(item, ["reposts", "repost_count", "repostCount", "metrics.reposts"]),
    quotes: firstNumber(item, ["quotes", "quote_count", "quoteCount", "metrics.quotes"])
  };
}

function readSnapshotFile(root) {
  const file = join(root, "data", "metric-snapshots.json");
  if (!existsSync(file)) return { schemaVersion: 1, items: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed?.items ? parsed : { schemaVersion: 1, items: {} };
  } catch {
    return { schemaVersion: 1, items: {} };
  }
}

function ageDays(item) {
  const date = item.up || item.date || today();
  const ms = Date.now() - Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(ms)) return 1;
  return Math.max(1, Math.floor(ms / DAY));
}

function bucketFor(mult) {
  if (mult >= 50) return "50배+";
  if (mult >= 10) return "10~50배";
  if (mult >= 5) return "5~10배";
  if (mult >= 3) return "3~5배";
  return "2~3배";
}

function computeVelocity(history, metrics, item) {
  const previous = history.at(-1);
  if (!previous) {
    const approximateDailyViews = number(item.dailyViews, 0) || Math.round(metrics.views / ageDays(item));
    return {
      confidence: "initial",
      viewsDelta: 0,
      viewsPerHour: 0,
      views24h: approximateDailyViews,
      previousViews: 0,
      sampledHours: 0
    };
  }

  const hours = Math.max(0.01, (Date.now() - Date.parse(previous.at)) / 36e5);
  const viewsDelta = Math.max(0, metrics.views - number(previous.views, 0));
  const viewsPerHour = viewsDelta / hours;
  return {
    confidence: hours >= 1 ? "snapshot" : "short-interval",
    viewsDelta,
    viewsPerHour: Math.round(viewsPerHour * 10) / 10,
    views24h: Math.round(viewsPerHour * 24),
    previousViews: number(previous.views, 0),
    sampledHours: Math.round(hours * 10) / 10
  };
}

function trendScore(metrics, signal, item) {
  const recency = Math.max(0.2, 1 - Math.min(ageDays(item), 60) / 90);
  const engagement = metrics.likes * 2 + metrics.comments * 6 + metrics.shares * 8 + metrics.replies * 5 + metrics.reposts * 8 + metrics.quotes * 6;
  return Math.round((signal.views24h * 1.8 + metrics.views * 0.012 + engagement * 0.35) * recency * 10) / 10;
}

function applySignal(platform, item, signal, metrics) {
  item.metricSource = item.metricSource || (item.collected?.startsWith("provider-") ? "provider" : "local-snapshot");
  item.velocity = {
    confidence: signal.confidence,
    viewsDelta: signal.viewsDelta,
    viewsPerHour: signal.viewsPerHour,
    views24h: signal.views24h,
    previousViews: signal.previousViews,
    sampledHours: signal.sampledHours
  };
  item.trendScore = trendScore(metrics, signal, item);
  if (signal.confidence === "snapshot" && signal.views24h > 0) {
    item.dailyViews = signal.views24h;
    item.mult = Math.round((signal.views24h / 10000) * 10) / 10;
    item.bucket = bucketFor(item.mult);
  }
  if (platform !== "youtube" && metrics.views > 0) item.views = metrics.views;
}

export function applyMetricSnapshots({ root, data }) {
  const snapshots = readSnapshotFile(root);
  const now = new Date().toISOString();
  const summary = { sampledAt: now, tracked: { youtube: 0, instagram: 0, threads: 0 }, velocityReady: { youtube: 0, instagram: 0, threads: 0 } };

  for (const platform of ["youtube", "instagram", "threads"]) {
    for (const item of data[platform] || []) {
      const key = itemKey(platform, item);
      if (!key) continue;
      const metrics = currentMetrics(item);
      if (!Object.values(metrics).some((value) => value > 0)) continue;

      const record = snapshots.items[key] || {
        platform,
        key,
        title: item.title || item.summary || "",
        url: item.link || (platform === "youtube" && item.id ? `https://www.youtube.com/watch?v=${item.id}` : ""),
        firstSeenAt: now,
        history: []
      };
      const signal = computeVelocity(record.history, metrics, item);
      const last = record.history.at(-1);
      if (!last || last.views !== metrics.views || Date.parse(now) - Date.parse(last.at) >= 6 * 36e5) {
        record.history.push({ at: now, ...metrics });
      }
      record.history = record.history.slice(-MAX_HISTORY);
      record.lastSeenAt = now;
      record.latest = metrics;
      record.velocity = signal;
      snapshots.items[key] = record;

      applySignal(platform, item, signal, metrics);
      summary.tracked[platform] += 1;
      if (signal.confidence === "snapshot" && signal.views24h > 0) summary.velocityReady[platform] += 1;
    }
  }

  snapshots.schemaVersion = 1;
  snapshots.updatedAt = now;
  snapshots.summary = summary;
  writeJsonAtomic(join(root, "data", "metric-snapshots.json"), snapshots);
  return summary;
}
