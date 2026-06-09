#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIST = join(ROOT, "dist");

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

function patchAppForStatic(appJs) {
  return appJs
    .replaceAll('fetch("/api/data", { cache: "no-store" })', 'fetch("/data/gallery-data.json", { cache: "no-store" })')
    .replace(
      /const status = await fetch\("\/api\/status", \{ cache: "no-store" \}\)\.then\(\(res\) => res\.json\(\)\);/,
      'const status = await fetch("/data/status.json", { cache: "no-store" }).then((res) => res.json());'
    )
    .replaceAll("await loadDeletedServer();", "")
    .replaceAll("saveDeletedServer();", "")
    .replaceAll('const response = await fetch("/api/collect", { method: "POST" });', 'throw new Error("상시 사이트에서는 GitHub Actions가 매일 자동 수집합니다.");\n      const response = null;')
    .replaceAll("src=\"${youtubeThumb(item)}\"", "src=\"${staticYoutubeThumb(item)}\"")
    .replaceAll("src=\"${image}\"", "src=\"${staticInstagramThumb(item)}\"");
}

function buildStaticHelpers() {
  return `
function staticYoutubeThumb(item) {
  const variants = ["hqdefault", "sddefault", "mqdefault", "default"];
  return \`https://i.ytimg.com/vi/\${encodeURIComponent(item.id)}/\${variants[0]}.jpg\`;
}

function staticInstagramThumb(item) {
  return item.thumb || "/assets/thumb-fallback.svg";
}
`;
}

function statusPayload(data) {
  let collector = {};
  try {
    collector = JSON.parse(readFileSync(join(ROOT, "data", "collector-status.json"), "utf8"));
  } catch {
    collector = {};
  }
  return {
    version: data.version,
    generatedAt: data.generatedAt,
    sourceUrl: data.sourceUrl,
    counts: data.counts,
    dateRanges: data.dateRanges,
    collector,
    scheduler: {
      mode: "github-actions-daily",
      collectEverySeconds: 86400,
      running: false
    }
  };
}

rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

copyFile(join(ROOT, "index.html"), join(DIST, "index.html"));
copyFile(join(ROOT, "styles.css"), join(DIST, "styles.css"));
copyFile(join(ROOT, "assets", "thumb-fallback.svg"), join(DIST, "assets", "thumb-fallback.svg"));
copyFile(join(ROOT, "data", "gallery-data.json"), join(DIST, "data", "gallery-data.json"));

const data = JSON.parse(readFileSync(join(ROOT, "data", "gallery-data.json"), "utf8"));
writeFileSync(join(DIST, "data", "status.json"), `${JSON.stringify(statusPayload(data), null, 2)}\n`, "utf8");

const appJs = readFileSync(join(ROOT, "app.js"), "utf8");
writeFileSync(join(DIST, "app.js"), `${buildStaticHelpers()}\n${patchAppForStatic(appJs)}`, "utf8");

console.log(`Static export ready: ${DIST}`);
