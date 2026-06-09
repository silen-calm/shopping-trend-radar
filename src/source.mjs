import { createDecipheriv, createHash, createHmac, pbkdf2Sync } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_SOURCE_URL = "";

function pbkdf2(password, salt, iterations, digest) {
  return pbkdf2Sync(Buffer.from(password, "utf8"), Buffer.from(salt, "utf8"), iterations, 32, digest).toString("hex");
}

export async function downloadText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "shopping-trend-radar/1.0"
    }
  });
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }
  return response.text();
}

export function decryptStaticrypt(page, password) {
  if (!password) throw new Error("Staticrypt password is required. Set GALLERY_PASSWORD or pass --password=...");
  const match = page.match(/staticryptConfig\s*=\s*(\{[\s\S]*?\})\s*;/);
  if (!match) throw new Error("staticryptConfig not found");

  const config = JSON.parse(match[1]);
  const signed = config.staticryptEncryptedMsgUniqueVariableName;
  const salt = config.staticryptSaltUniqueVariableName;

  let hashed = pbkdf2(password, salt, 1000, "sha1");
  hashed = pbkdf2(hashed, salt, 14000, "sha256");
  hashed = pbkdf2(hashed, salt, 585000, "sha256");

  const expectedHmac = signed.slice(0, 64);
  const encrypted = signed.slice(64);
  const actualHmac = createHmac("sha256", Buffer.from(hashed, "hex")).update(Buffer.from(encrypted, "utf8")).digest("hex");
  if (actualHmac !== expectedHmac) throw new Error("Password check failed");

  const iv = Buffer.from(encrypted.slice(0, 32), "hex");
  const payload = Buffer.from(encrypted.slice(32), "hex");
  const decipher = createDecipheriv("aes-256-cbc", Buffer.from(hashed, "hex"), iv);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

export function extractArray(html, name) {
  const start = html.indexOf(`${name}=`);
  if (start < 0) throw new Error(`Missing ${name}`);

  const open = html.indexOf("[", start);
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let i = open; i < html.length; i += 1) {
    const ch = html[i];

    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (ch === "[") depth += 1;
    if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(html.slice(open, i + 1));
      }
    }
  }

  throw new Error(`Unclosed ${name}`);
}

export function extractData(html) {
  const youtube = extractArray(html, "YTDATA");
  const threads = extractArray(html, "THDATA");
  const instagram = extractArray(html, "IGDATA");
  return { youtube, threads, instagram };
}

function minDate(items) {
  return items.reduce((value, item) => {
    const date = item.up || item.date || "";
    return !value || date < value ? date : value;
  }, "");
}

function maxDate(items) {
  return items.reduce((value, item) => {
    const date = item.up || item.date || "";
    return !value || date > value ? date : value;
  }, "");
}

function invalidDateCount(items) {
  return items.filter((item) => Number.isNaN(Date.parse(`${item.up || item.date || ""}T00:00:00+09:00`))).length;
}

export function buildPayload(data, sourceUrl = DEFAULT_SOURCE_URL) {
  const generatedAt = new Date().toISOString();
  const payload = {
    schemaVersion: 2,
    generatedAt,
    sourceUrl,
    counts: {
      youtube: data.youtube.length,
      threads: data.threads.length,
      instagram: data.instagram.length
    },
    dateRanges: {
      youtube: { min: minDate(data.youtube), max: maxDate(data.youtube), invalid: invalidDateCount(data.youtube) },
      threads: { min: minDate(data.threads), max: maxDate(data.threads), invalid: invalidDateCount(data.threads) },
      instagram: { min: minDate(data.instagram), max: maxDate(data.instagram), invalid: invalidDateCount(data.instagram) }
    },
    data
  };

  const hash = createHash("sha256").update(JSON.stringify(payload.data)).digest("hex");
  payload.version = `${generatedAt}:${hash.slice(0, 12)}`;
  return payload;
}

export function writeJsonAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, filePath);
}

export function readData(root) {
  return JSON.parse(readFileSync(join(root, "data", "gallery-data.json"), "utf8"));
}

export async function refreshData({ root, password, sourceUrl = DEFAULT_SOURCE_URL } = {}) {
  if (!root) throw new Error("refreshData requires root");
  if (!sourceUrl) throw new Error("refreshData requires a source URL. Set GALLERY_URL.");
  if (!password) throw new Error("refreshData requires a password. Set GALLERY_PASSWORD or pass --password=...");
  const locked = await downloadText(sourceUrl);
  const decrypted = decryptStaticrypt(locked, password);
  const data = extractData(decrypted);
  const payload = buildPayload(data, sourceUrl);
  writeJsonAtomic(join(root, "data", "gallery-data.json"), payload);
  writeJsonAtomic(join(root, "data", "refresh-status.json"), {
    ok: true,
    refreshedAt: payload.generatedAt,
    version: payload.version,
    counts: payload.counts,
    dateRanges: payload.dateRanges
  });
  return payload;
}
