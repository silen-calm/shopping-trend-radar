import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeInstagramProviderItem, normalizeThreadsProviderItem } from "../src/provider-adapters.mjs";
import { applyMetricSnapshots } from "../src/metric-snapshots.mjs";
import { buildPayload, writeJsonAtomic } from "../src/source.mjs";

const instagram = normalizeInstagramProviderItem({
  shortcode: "ABC123",
  username: "sample.ig",
  video_view_count: "12.5만",
  like_count: "1,200",
  comment_count: 44,
  caption: "테스트 릴스",
  permalink: "https://www.instagram.com/reel/ABC123/",
  published_at: "2026-06-07T01:00:00+09:00"
});

assert.equal(instagram.code, "ABC123");
assert.equal(instagram.views, 125000);
assert.equal(instagram.likes, 1200);
assert.equal(instagram.up, "2026-06-07");
assert.equal(instagram.collected, "provider-instagram");

const threads = normalizeThreadsProviderItem({
  id: "XYZ",
  username: "sample.th",
  views: 8000,
  replies: 21,
  reposts: 7,
  text: "테스트 스레드",
  url: "https://www.threads.com/@sample.th/post/XYZ",
  created_at: "2026-06-07T01:00:00+09:00"
});

assert.equal(threads.id, "XYZ");
assert.equal(threads.views, 8000);
assert.equal(threads.replies, 21);
assert.equal(threads.up, "2026-06-07");
assert.equal(threads.collected, "provider-threads");

const root = mkdtempSync(join(tmpdir(), "shopping-trend-radar-provider-test-"));
const data = {
  youtube: [{ id: "yt1", views: 100000, title: "yt", up: "2026-06-07", mult: 2, bucket: "2~3배" }],
  instagram: [instagram],
  threads: [threads]
};
writeJsonAtomic(join(root, "data", "gallery-data.json"), buildPayload(data, "test"));
writeJsonAtomic(join(root, "data", "metric-snapshots.json"), {
  schemaVersion: 1,
  updatedAt: "2026-06-07T00:00:00.000Z",
  items: {
    "instagram:ABC123": {
      platform: "instagram",
      key: "instagram:ABC123",
      firstSeenAt: "2026-06-07T00:00:00.000Z",
      lastSeenAt: "2026-06-07T00:00:00.000Z",
      history: [{ at: new Date(Date.now() - 24 * 36e5).toISOString(), views: 100000, likes: 1000, comments: 40, shares: 0, replies: 0, reposts: 0, quotes: 0 }]
    }
  }
});

const summary = applyMetricSnapshots({ root, data });
const saved = JSON.parse(readFileSync(join(root, "data", "metric-snapshots.json"), "utf8"));

assert.ok(summary.tracked.instagram >= 1);
assert.ok(summary.velocityReady.instagram >= 1);
assert.ok(data.instagram[0].velocity.views24h >= 20000);
assert.ok(data.instagram[0].trendScore > 0);
assert.ok(saved.items["instagram:ABC123"].history.length >= 2);

console.log("Provider and snapshot tests passed.");
