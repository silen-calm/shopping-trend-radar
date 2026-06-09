#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const LABEL = "com.hookingpilot.shopping-trend-radar.server";
const PORT = process.env.PORT || "8765";
const nodePath = process.execPath;
const launchAgentsDir = join(homedir(), "Library", "LaunchAgents");
const plistPath = join(launchAgentsDir, `${LABEL}.plist`);
const logsDir = join(ROOT, "logs");
const uid = process.getuid?.();

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0 && !allowFailure) {
    const message = result.stderr || result.stdout || `${command} exited with ${result.status}`;
    throw new Error(message.trim());
  }
  return result;
}

if (!existsSync(join(ROOT, "server.mjs"))) {
  throw new Error(`server.mjs not found under ${ROOT}`);
}

mkdirSync(launchAgentsDir, { recursive: true });
mkdirSync(logsDir, { recursive: true });

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${esc(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>${esc(join(ROOT, "server.mjs"))}</string>
    <string>--port</string>
    <string>${esc(PORT)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${esc(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>COLLECT_ON_STARTUP</key>
    <string>1</string>
    <key>COLLECT_EVERY_SECONDS</key>
    <string>86400</string>
    <key>COLLECT_STALE_SECONDS</key>
    <string>86400</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${esc(join(logsDir, "server.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${esc(join(logsDir, "server.err.log"))}</string>
</dict>
</plist>
`;

writeFileSync(plistPath, plist, "utf8");

if (process.platform === "darwin" && Number.isInteger(uid)) {
  const domain = `gui/${uid}`;
  run("launchctl", ["bootout", domain, plistPath], { allowFailure: true });
  run("launchctl", ["bootstrap", domain, plistPath]);
  run("launchctl", ["kickstart", "-k", `${domain}/${LABEL}`], { allowFailure: true });
}

console.log(JSON.stringify({
  ok: true,
  label: LABEL,
  plistPath,
  root: ROOT,
  port: PORT,
  nodePath,
  logs: {
    out: join(logsDir, "server.out.log"),
    err: join(logsDir, "server.err.log")
  }
}, null, 2));
