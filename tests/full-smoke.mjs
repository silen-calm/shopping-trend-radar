import assert from "node:assert/strict";

const BASE_URL = process.env.GALLERY_LOCAL_URL || "http://127.0.0.1:8765";

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, options);
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  return { response, body };
}

async function json(path, options = {}) {
  const { response, body } = await request(path, options);
  assert.ok(response.ok, `${path} should return HTTP 2xx`);
  return body;
}

const index = await request("/");
assert.equal(index.response.status, 200, "index should be served");
assert.ok(String(index.body).includes("/app.js"), "index should load app.js");

const css = await request("/styles.css");
assert.equal(css.response.status, 200, "styles.css should be served");

const js = await request("/app.js");
assert.equal(js.response.status, 200, "app.js should be served");

const fallbackAsset = await request("/assets/thumb-fallback.svg");
assert.equal(fallbackAsset.response.status, 200, "local fallback thumbnail should be served");
assert.ok(String(fallbackAsset.body).includes("<svg"), "fallback thumbnail should be SVG");

const statusBefore = await json("/api/status");
assert.ok(statusBefore.counts.youtube >= 2097);
assert.ok(statusBefore.counts.threads >= 215);
assert.ok(statusBefore.counts.instagram >= 1317);
assert.ok(typeof statusBefore.collector === "object", "status should include collector state");
assert.ok(statusBefore.version, "status should include a data version");

const data = await json("/api/data");
assert.equal(data.schemaVersion, 2);
assert.equal(data.version, statusBefore.version);
assert.equal(data.data.youtube.length, statusBefore.counts.youtube);
assert.equal(data.data.threads.length, statusBefore.counts.threads);
assert.equal(data.data.instagram.length, statusBefore.counts.instagram);

const originalDeleted = await json("/api/deleted");
assert.ok(Array.isArray(originalDeleted), "deleted API should return an array");
const marker = `smoke:${Date.now()}`;
try {
  const saved = await json("/api/deleted", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify([...originalDeleted, marker])
  });
  assert.equal(saved.ok, true);
  const deletedAfter = await json("/api/deleted");
  assert.ok(deletedAfter.includes(marker), "deleted item should persist");
} finally {
  await json("/api/deleted", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(originalDeleted)
  });
}

const firstYoutube = data.data.youtube[0];
const thumb = await request(`/thumb?url=${encodeURIComponent(`https://i.ytimg.com/vi/${firstYoutube.id}/hqdefault.jpg`)}`);
assert.equal(thumb.response.status, 200, "thumbnail proxy should return an image");
assert.ok((thumb.response.headers.get("content-type") || "").startsWith("image/"), "thumbnail content-type should be image/*");
assert.ok(["HIT", "MISS"].includes(thumb.response.headers.get("x-cache")), "thumbnail response should expose cache state");

const fallbackThumb = await request(`/thumb?url=${encodeURIComponent(`https://i.ytimg.com/vi/${firstYoutube.id}/definitely-missing-thumb.jpg`)}&fallback=${encodeURIComponent(`https://i.ytimg.com/vi/${firstYoutube.id}/hqdefault.jpg`)}`);
assert.equal(fallbackThumb.response.status, 200, "thumbnail proxy should try fallback URLs");
assert.ok((fallbackThumb.response.headers.get("content-type") || "").startsWith("image/"), "fallback thumbnail content-type should be image/*");

const blockedThumb = await request(`/thumb?url=${encodeURIComponent("https://example.com/image.jpg")}`);
assert.equal(blockedThumb.response.status, 502, "thumbnail proxy should block unknown hosts");

const refresh = await request("/api/refresh", { method: "POST" });
assert.equal(refresh.response.status, 410, "original gallery refresh should be disabled");
assert.equal(refresh.body.ok, false);

const statusAfter = await json("/api/status");
assert.equal(statusAfter.version, statusBefore.version);
assert.ok(statusAfter.cache.items >= statusBefore.cache.items, "cache item count should not shrink during smoke test");
assert.ok(typeof statusAfter.cacheWarm === "object", "status should expose cache warm state");

console.log("Full smoke tests passed.");
