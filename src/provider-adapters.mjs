const DEFAULT_HEADERS = {
  accept: "application/json",
  "user-agent": "shopping-trend-radar-provider/1.0"
};

function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function kstDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function valueAt(object, path) {
  if (!path) return object;
  return String(path).split(".").reduce((value, key) => value?.[key], object);
}

function firstValue(object, paths) {
  for (const path of paths) {
    const value = valueAt(object, path);
    if (value != null && value !== "") return value;
  }
  return "";
}

function number(value, fallback = 0) {
  if (value == null || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const text = String(value).replace(/,/g, "").trim();
  const match = text.match(/^([\d.]+)\s*([kKmM만천억])?$/);
  if (!match) return fallback;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return fallback;
  if (match[2] === "k" || match[2] === "K" || match[2] === "천") return Math.round(base * 1000);
  if (match[2] === "m" || match[2] === "M") return Math.round(base * 1000000);
  if (match[2] === "만") return Math.round(base * 10000);
  if (match[2] === "억") return Math.round(base * 100000000);
  return Math.round(base);
}

function normalizeDate(value) {
  if (!value) return today();
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return kstDate(new Date(ms));
  }
  const text = String(value);
  if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = Date.parse(text);
  if (Number.isFinite(parsed)) return kstDate(new Date(parsed));
  return today();
}

function shortcodeFromUrl(url = "") {
  const text = String(url);
  return text.match(/instagram\.com\/(?:reel|p)\/([A-Za-z0-9_-]+)/)?.[1] || text.match(/threads\.(?:com|net)\/@[^/]+\/post\/([A-Za-z0-9_-]+)/)?.[1] || "";
}

function envTemplate(text, values, env = process.env) {
  return String(text || "")
    .replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => encodeURIComponent(values[key] ?? ""))
    .replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, key) => env[key] || "");
}

function providerEndpoint(provider, key) {
  const envKey = key === "accountEndpoint" ? provider.accountEndpointEnv : provider.searchEndpointEnv;
  return process.env[envKey] || provider[key] || "";
}

function providerKey(provider) {
  return provider.apiKeyEnv ? process.env[provider.apiKeyEnv] || "" : provider.apiKey || "";
}

function headersFor(provider) {
  const headers = { ...DEFAULT_HEADERS };
  const key = providerKey(provider);
  if (key) {
    const header = provider.apiKeyHeader || "Authorization";
    const prefix = provider.apiKeyPrefix ?? "Bearer ";
    headers[header] = `${prefix}${key}`;
  }
  for (const [name, value] of Object.entries(provider.headers || {})) {
    headers[name] = envTemplate(value, { apiKey: key });
  }
  return headers;
}

function providerReady(provider, endpoint) {
  if (!provider || provider.enabled === false) return false;
  if (!endpoint) return false;
  if (provider.apiKeyEnv && !process.env[provider.apiKeyEnv]) return false;
  return true;
}

function arrayFromResponse(json, provider) {
  if (provider.arrayPath) {
    const value = valueAt(json, provider.arrayPath);
    return Array.isArray(value) ? value : [];
  }
  if (Array.isArray(json)) return json;
  for (const path of ["data", "items", "results", "posts", "reels", "media", "result.data", "result.items"]) {
    const value = valueAt(json, path);
    if (Array.isArray(value)) return value;
  }
  return [];
}

async function fetchProviderJson(endpoint, provider, values) {
  const url = envTemplate(endpoint, values);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(provider.timeoutMs || 20000));
  try {
    const response = await fetch(url, {
      headers: headersFor(provider),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function qualityDecision(row, provider) {
  const age = Math.max(1, Math.floor((Date.now() - Date.parse(`${row.up || row.date || today()}T00:00:00+09:00`)) / 864e5));
  const maxAgeDays = Number(provider.maxAgeDays || 45);
  const minViews = Number(provider.minViews || 0);
  const minEngagement = Number(provider.minEngagement || 0);
  const engagement = number(row.likes) + number(row.comments) * 2 + number(row.replies) * 2 + number(row.reposts) * 3 + number(row.quotes) * 3 + number(row.shares) * 3;
  if (age > maxAgeDays) return { accepted: false, reason: `old>${maxAgeDays}d` };
  if (minViews && number(row.views) < minViews && engagement < minEngagement) return { accepted: false, reason: `views<${minViews}` };
  if (!number(row.views) && !engagement) return { accepted: false, reason: "missing-engagement" };
  return { accepted: true, reason: number(row.views) >= minViews ? "provider-views" : "provider-engagement" };
}

export function normalizeInstagramProviderItem(item, acct = "", provider = {}) {
  const link = firstValue(item, ["permalink", "url", "link", "post_url", "media_url"]);
  const code = firstValue(item, ["shortcode", "code", "id"]) || shortcodeFromUrl(link);
  return {
    kw: firstValue(item, ["keyword", "query"]) || "공급자수집",
    acct: firstValue(item, ["username", "owner.username", "author.username"]) || acct,
    views: number(firstValue(item, ["views", "view_count", "video_view_count", "video_views", "play_count", "plays", "metrics.views"])),
    likes: number(firstValue(item, ["likes", "like_count", "metrics.likes"])),
    comments: number(firstValue(item, ["comments", "comment_count", "metrics.comments"])),
    shares: number(firstValue(item, ["shares", "share_count", "metrics.shares"])),
    summary: String(firstValue(item, ["caption", "text", "title", "description", "summary"]) || "Instagram provider 수집 릴스").replace(/\s+/g, " ").trim(),
    fit: "상 · 공급자 검증수집",
    link: link || (code ? `https://www.instagram.com/reel/${code}/` : ""),
    up: normalizeDate(firstValue(item, ["published_at", "taken_at", "timestamp", "created_at", "date", "upload_date"])),
    thumb: firstValue(item, ["thumbnail_url", "thumbnail", "display_url", "image", "media.thumbnail_url"]),
    code,
    lt: 0,
    collected: "provider-instagram",
    metricSource: provider.name || "instagram-provider"
  };
}

export function normalizeThreadsProviderItem(item, acct = "", provider = {}) {
  const link = firstValue(item, ["permalink", "url", "link", "post_url"]) || "";
  const id = firstValue(item, ["id", "code", "shortcode"]) || shortcodeFromUrl(link);
  const date = normalizeDate(firstValue(item, ["published_at", "timestamp", "created_at", "date"]));
  return {
    kw: firstValue(item, ["keyword", "query"]) || "공급자수집",
    acct: firstValue(item, ["username", "owner.username", "author.username"]) || acct,
    id,
    views: number(firstValue(item, ["views", "view_count", "metrics.views"])),
    likes: number(firstValue(item, ["likes", "like_count", "metrics.likes"])),
    replies: number(firstValue(item, ["replies", "reply_count", "metrics.replies"])),
    reposts: number(firstValue(item, ["reposts", "repost_count", "metrics.reposts"])),
    quotes: number(firstValue(item, ["quotes", "quote_count", "metrics.quotes"])),
    summary: String(firstValue(item, ["text", "caption", "title", "description", "summary"]) || "Threads provider 수집 포스트").replace(/\s+/g, " ").trim(),
    fit: "상 · 공급자 검증수집",
    link: link || (acct && id ? `https://www.threads.com/@${acct}/post/${id}` : ""),
    up: date,
    date,
    collected: "provider-threads",
    metricSource: provider.name || "threads-provider"
  };
}

async function collectProviderRows({ platform, provider, accounts = [], queries = [], status, normalize }) {
  const rows = [];
  const accountEndpoint = providerEndpoint(provider, "accountEndpoint");
  const searchEndpoint = providerEndpoint(provider, "searchEndpoint");
  const limit = Number(provider.limit || 25);

  if (!providerReady(provider, accountEndpoint) && !providerReady(provider, searchEndpoint)) {
    status.provider = { ok: false, skipped: true, reason: provider?.apiKeyEnv ? `missing ${provider.apiKeyEnv} or endpoint` : "missing endpoint" };
    return rows;
  }

  status.provider = { ok: true, name: provider.name || `${platform}-provider`, accounts: [], queries: [], rejected: [], errors: [] };

  for (const acct of accounts) {
    if (!providerReady(provider, accountEndpoint)) continue;
    try {
      const json = await fetchProviderJson(accountEndpoint, provider, { account: acct, username: acct, limit, apiKey: providerKey(provider) });
      const normalized = arrayFromResponse(json, provider).map((item) => normalize(item, acct, provider)).filter((row) => row.link || row.code || row.id);
      for (const row of normalized) {
        const decision = qualityDecision(row, provider);
        if (decision.accepted) rows.push(row);
        else status.provider.rejected.push({ acct, link: row.link, reason: decision.reason });
      }
      status.provider.accounts.push({ acct, found: normalized.length });
    } catch (error) {
      status.provider.errors.push({ acct, message: error.message });
    }
  }

  for (const query of queries) {
    const text = typeof query === "string" ? query : query.query;
    if (!providerReady(provider, searchEndpoint) || !text) continue;
    try {
      const json = await fetchProviderJson(searchEndpoint, provider, { query: text, limit, apiKey: providerKey(provider) });
      const normalized = arrayFromResponse(json, provider).map((item) => normalize(item, "", provider)).filter((row) => row.link || row.code || row.id);
      for (const row of normalized) {
        row.kw = row.kw || text;
        const decision = qualityDecision(row, provider);
        if (decision.accepted) rows.push(row);
        else status.provider.rejected.push({ query: text, link: row.link, reason: decision.reason });
      }
      status.provider.queries.push({ query: text, found: normalized.length });
    } catch (error) {
      status.provider.errors.push({ query: text, message: error.message });
    }
  }

  return rows;
}

export function collectInstagramProvider(config, status) {
  return collectProviderRows({
    platform: "instagram",
    provider: config.instagram?.provider || {},
    accounts: config.instagram?.seedAccounts || [],
    queries: config.instagram?.queries || [],
    status: status.instagram,
    normalize: normalizeInstagramProviderItem
  });
}

export function collectThreadsProvider(config, status) {
  return collectProviderRows({
    platform: "threads",
    provider: config.threads?.provider || {},
    accounts: config.threads?.seedAccounts || [],
    queries: config.threads?.queries || [],
    status: status.threads,
    normalize: normalizeThreadsProviderItem
  });
}
