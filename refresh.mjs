#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SOURCE_URL, refreshData } from "./src/source.mjs";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)));
const args = process.argv.slice(2);
const watchIndex = args.indexOf("--watch");
const interval = watchIndex >= 0 ? Number(args[watchIndex + 1] || process.env.REFRESH_SECONDS || 3600) : 0;
const passwordArg = args.find((arg) => arg.startsWith("--password="));
const password = process.env.GALLERY_PASSWORD || (passwordArg ? passwordArg.slice("--password=".length) : "");
const sourceUrl = process.env.GALLERY_URL || DEFAULT_SOURCE_URL;

async function run() {
  const data = await refreshData({ root: ROOT, password, sourceUrl });
  console.log(`[${new Date().toLocaleString()}] refreshed ${data.version}`);
  console.log(JSON.stringify(data.counts));
}

await run();

if (interval > 0) {
  console.log(`Watching source every ${interval}s.`);
  setInterval(() => {
    run().catch((error) => console.error(`[refresh failed] ${error.message}`));
  }, interval * 1000);
}
