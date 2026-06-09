#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDirectCollection } from "./src/direct-collector.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));

try {
  const { payload, status } = await runDirectCollection({ root: ROOT });
  console.log(`[collect] ${payload.generatedAt} ${JSON.stringify(payload.counts)} added=${JSON.stringify(status.added)}`);
  if (status.youtube.errors.length || status.instagram.errors.length || status.threads.errors.length) {
    console.log(`[collect warnings] youtube=${status.youtube.errors.length} instagram=${status.instagram.errors.length} threads=${status.threads.errors.length}`);
  }
} catch (error) {
  console.error(`[collect failed] ${error.message}`);
  process.exitCode = 1;
}
