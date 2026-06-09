import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const ALLOWED_HOSTS = [
  "i.ytimg.com",
  "img.youtube.com",
  "images.weserv.nl"
];
const CACHE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp", ".gif"];
let manifestLock = Promise.resolve();

function isAllowedHost(hostname) {
  return ALLOWED_HOSTS.includes(hostname) || hostname.endsWith(".cdninstagram.com");
}

function extensionFor(url, contentType = "") {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("gif")) return ".gif";
  const ext = extname(new URL(url).pathname).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext) ? ext : ".jpg";
}

export function cacheStats(root) {
  const metaPath = join(root, "cache", "thumbs", "manifest.json");
  if (!existsSync(metaPath)) return { items: 0, bytes: 0 };
  try {
    const manifest = JSON.parse(readFileSync(metaPath, "utf8"));
    return {
      items: Object.keys(manifest.items || {}).length,
      bytes: Object.values(manifest.items || {}).reduce((sum, item) => sum + (item.bytes || 0), 0)
    };
  } catch {
    return { items: 0, bytes: 0 };
  }
}

function readManifest(root) {
  const dir = join(root, "cache", "thumbs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return { items: {} };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { items: {} };
  }
}

function writeManifest(root, manifest) {
  const dir = join(root, "cache", "thumbs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "manifest.json");
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

async function withManifestLock(task) {
  const previous = manifestLock;
  let release;
  manifestLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return task();
  } finally {
    release();
  }
}

function contentTypeForFile(file) {
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".webp")) return "image/webp";
  if (file.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

function findCachedFile(dir, hash) {
  for (const ext of CACHE_EXTENSIONS) {
    const file = `${hash}${ext}`;
    if (existsSync(join(dir, file))) return file;
  }
  return "";
}

export async function getCachedThumb(root, rawUrl) {
  const parsed = new URL(rawUrl);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http(s) thumbnails are allowed");
  }
  if (!isAllowedHost(parsed.hostname)) {
    throw new Error(`Thumbnail host is not allowed: ${parsed.hostname}`);
  }

  const dir = join(root, "cache", "thumbs");
  mkdirSync(dir, { recursive: true });
  const hash = createHash("sha256").update(rawUrl).digest("hex");
  const cached = await withManifestLock(() => {
    const manifest = readManifest(root);
    const existing = manifest.items[hash];
    if (existing && existsSync(join(dir, existing.file))) {
      return { path: join(dir, existing.file), contentType: existing.contentType || "image/jpeg", hit: true };
    }
    const recovered = findCachedFile(dir, hash);
    if (!recovered) return null;
    manifest.items[hash] = {
      url: rawUrl,
      file: recovered,
      bytes: readFileSync(join(dir, recovered)).length,
      contentType: contentTypeForFile(recovered),
      cachedAt: new Date().toISOString(),
      recovered: true
    };
    writeManifest(root, manifest);
    return { path: join(dir, recovered), contentType: manifest.items[hash].contentType, hit: true };
  });
  if (cached) return cached;

  const response = await fetch(rawUrl, {
    headers: {
      "user-agent": "Mozilla/5.0 shopping-trend-radar/1.0",
      "accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    }
  });
  if (!response.ok) throw new Error(`Thumbnail fetch failed: HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error(`Not an image: ${contentType}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  return withManifestLock(() => {
    const manifest = readManifest(root);
    const existing = manifest.items[hash];
    if (existing && existsSync(join(dir, existing.file))) {
      return { path: join(dir, existing.file), contentType: existing.contentType || "image/jpeg", hit: true };
    }
    const recovered = findCachedFile(dir, hash);
    if (recovered) {
      manifest.items[hash] = {
        url: rawUrl,
        file: recovered,
        bytes: readFileSync(join(dir, recovered)).length,
        contentType: contentTypeForFile(recovered),
        cachedAt: new Date().toISOString(),
        recovered: true
      };
      writeManifest(root, manifest);
      return { path: join(dir, recovered), contentType: manifest.items[hash].contentType, hit: true };
    }

    const file = `${hash}${extensionFor(rawUrl, contentType)}`;
    writeFileSync(join(dir, file), buffer);
    manifest.items[hash] = {
      url: rawUrl,
      file,
      bytes: buffer.length,
      contentType,
      cachedAt: new Date().toISOString()
    };
    writeManifest(root, manifest);
    return { path: join(dir, file), contentType, hit: false };
  });
}

export async function getCachedThumbAny(root, rawUrls) {
  const candidates = [...new Set(rawUrls.filter(Boolean))];
  const errors = [];
  for (const rawUrl of candidates) {
    try {
      return await getCachedThumb(root, rawUrl);
    } catch (error) {
      errors.push(`${rawUrl}: ${error.message}`);
    }
  }
  throw new Error(`All thumbnail candidates failed: ${errors.join(" | ")}`);
}

export function repairThumbManifest(root, rawUrls) {
  const dir = join(root, "cache", "thumbs");
  mkdirSync(dir, { recursive: true });
  const manifest = readManifest(root);
  for (const rawUrl of [...new Set(rawUrls.filter(Boolean))]) {
    const hash = createHash("sha256").update(rawUrl).digest("hex");
    if (manifest.items[hash] && existsSync(join(dir, manifest.items[hash].file))) continue;
    const file = findCachedFile(dir, hash);
    if (!file) continue;
    manifest.items[hash] = {
      url: rawUrl,
      file,
      bytes: readFileSync(join(dir, file)).length,
      contentType: contentTypeForFile(file),
      cachedAt: new Date().toISOString(),
      recovered: true
    };
  }
  writeManifest(root, manifest);
  return cacheStats(root);
}
