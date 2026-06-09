#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCachedThumbAny, repairThumbManifest } from "./src/cache.mjs";
import { readData, writeJsonAtomic } from "./src/source.mjs";
import { collectThumbJobs } from "./src/thumb-jobs.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2);
const concurrency = Number((args.find((arg) => arg.startsWith("--concurrency=")) || "").split("=")[1] || 8);
const limit = Number((args.find((arg) => arg.startsWith("--limit=")) || "").split("=")[1] || 0);
const statusPath = join(ROOT, "cache", "thumbs", "warm-status.json");

function writeStatus(value) {
  mkdirSync(join(ROOT, "cache", "thumbs"), { recursive: true });
  writeJsonAtomic(statusPath, value);
}

async function runPool(items, worker) {
  let index = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      await worker(items[current], current);
    }
  });
  await Promise.all(workers);
}

const payload = readData(ROOT);
const jobs = collectThumbJobs(payload.data);
const selected = limit > 0 ? jobs.slice(0, limit) : jobs;
const startedAt = new Date().toISOString();
let ok = 0;
let failed = 0;
const failures = [];

writeStatus({
  ok: false,
  running: true,
  startedAt,
  total: selected.length,
  completed: 0,
  succeeded: 0,
  failed: 0
});

await runPool(selected, async (job, index) => {
  try {
    await getCachedThumbAny(ROOT, job.urls);
    ok += 1;
  } catch (error) {
    failed += 1;
    if (failures.length < 50) {
      failures.push({ type: job.type, id: job.id, message: error.message });
    }
  }

  const completed = ok + failed;
  if (completed % 25 === 0 || completed === selected.length) {
    const status = {
      ok: failed === 0,
      running: completed !== selected.length,
      startedAt,
      updatedAt: new Date().toISOString(),
      total: selected.length,
      completed,
      succeeded: ok,
      failed,
      sampleFailures: failures
    };
    writeStatus(status);
    console.log(`[cache] ${completed}/${selected.length} ok=${ok} failed=${failed}`);
  }
});

writeStatus({
  ok: failed === 0,
  running: false,
  startedAt,
  finishedAt: new Date().toISOString(),
  total: selected.length,
  completed: ok + failed,
  succeeded: ok,
  failed,
  cache: repairThumbManifest(ROOT, selected.flatMap((job) => job.urls)),
  sampleFailures: failures
});

console.log(`Cache warm complete: ${ok}/${selected.length} cached, ${failed} failed.`);
