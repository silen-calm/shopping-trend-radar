import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const payload = JSON.parse(readFileSync(`${ROOT}/data/gallery-data.json`, "utf8"));
const DAY = 864e5;

function daysAt(up, iso) {
  return Math.floor((Date.parse(iso) - Date.parse(`${up}T00:00:00+09:00`)) / DAY);
}

function countPeriod(items, period, iso) {
  return items.filter((item) => daysAt(item.up || item.date, iso) <= period).length;
}

function sortRecent(items) {
  return items.slice().sort((a, b) => {
    const da = a.date || a.up || "";
    const db = b.date || b.up || "";
    return da < db ? 1 : da > db ? -1 : b.views - a.views;
  });
}

function maxSortDate(items) {
  return items.reduce((value, item) => {
    const date = item.date || item.up || "";
    return !value || date > value ? date : value;
  }, "");
}

function assertValidDates(name, items) {
  const invalid = items.filter((item) => Number.isNaN(Date.parse(`${item.up || item.date || ""}T00:00:00+09:00`)));
  assert.equal(invalid.length, 0, `${name} has invalid dates`);
}

assert.equal(payload.schemaVersion, 2);
assert.equal(payload.counts.youtube, payload.data.youtube.length);
assert.equal(payload.counts.threads, payload.data.threads.length);
assert.equal(payload.counts.instagram, payload.data.instagram.length);
assert.ok(payload.data.youtube.length > 1000, "youtube data should be populated");
assert.ok(payload.data.threads.length > 100, "thread data should be populated");
assert.ok(payload.data.instagram.length > 1000, "instagram data should be populated");

assertValidDates("youtube", payload.data.youtube);
assertValidDates("threads", payload.data.threads);
assertValidDates("instagram", payload.data.instagram);

const base = "2026-06-06T12:00:00+09:00";
assert.ok(countPeriod(payload.data.youtube, 30, base) >= 160);
assert.ok(countPeriod(payload.data.threads, 7, base) >= 97);
assert.ok(countPeriod(payload.data.instagram, 7, base) >= 64);

const ytMultTop = payload.data.youtube.slice().sort((a, b) => b.mult - a.mult)[0];
assert.ok(ytMultTop.mult >= 100, "youtube multiplier sort should find very high multiplier item");

const ytRecentTop = sortRecent(payload.data.youtube)[0];
assert.equal(ytRecentTop.up, payload.dateRanges.youtube.max);

const thRecentTop = sortRecent(payload.data.threads)[0];
assert.equal(thRecentTop.date || thRecentTop.up, maxSortDate(payload.data.threads));

const igRecentTop = sortRecent(payload.data.instagram)[0];
assert.equal(igRecentTop.up, payload.dateRanges.instagram.max);

const ytSearch = payload.data.youtube.filter((item) => `${item.title} ${item.ch}`.toLowerCase().includes("hoonion"));
assert.ok(ytSearch.length >= 25);

const thSearch = payload.data.threads.filter((item) => `${item.summary} ${item.acct}`.toLowerCase().includes("sunny"));
assert.ok(thSearch.length >= 1);

const igSearch = payload.data.instagram.filter((item) => `${item.summary} ${item.acct}`.toLowerCase().includes("daiso"));
assert.ok(igSearch.length >= 11);

console.log("Regression tests passed.");
