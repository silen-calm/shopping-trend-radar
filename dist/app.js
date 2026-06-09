
function staticYoutubeThumb(item) {
  const variants = ["hqdefault", "sddefault", "mqdefault", "default"];
  return `https://i.ytimg.com/vi/${encodeURIComponent(item.id)}/${variants[0]}.jpg`;
}

function staticInstagramThumb(item) {
  return item.thumb || "assets/thumb-fallback.svg";
}

const DAY = 864e5;
const PERIODS = [
  ["all", "전체"],
  ["1", "1일"],
  ["3", "3일"],
  ["7", "1주일"],
  ["30", "1달"],
  ["90", "3달"],
  ["365", "1년"]
];
const YT_CATS = [
  ["all", "전체"],
  ["릴스형", "릴스형"],
  ["썰쇼핑", "썰쇼핑"]
];
const YT_MULTS = [
  ["all", "전체"],
  ["2~3배", "2~3배"],
  ["3~5배", "3~5배"],
  ["5~10배", "5~10배"],
  ["10~50배", "10~50배"],
  ["50배+", "50배+"]
];
const YT_SORTS = [
  ["views", "조회수순"],
  ["mult", "배수순"],
  ["recent", "최신순"]
];
const COMMON_SORTS = [
  ["views", "조회순"],
  ["recent", "최신순"]
];

let payload = null;
let deleted = new Set();
let source = "yt";
let lastDayTick = dayTick();
let statusVersion = "";

const state = {
  yt: { cat: "all", per: "all", genre: "all", mult: "all", sort: "views", q: "", limit: 160 },
  th: { kw: "all", per: "all", sort: "views", q: "", limit: 120 },
  ig: { kw: "all", per: "all", sort: "views", q: "", limit: 120 }
};

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function compactNumber(n) {
  if (n >= 1e8) return `${(n / 1e8).toFixed(n >= 1e9 ? 0 : 1)}억`;
  if (n >= 1e4) return `${Math.round(n / 1e4)}만`;
  return String(n ?? 0);
}

function dayTick() {
  return Math.floor(Date.now() / DAY);
}

function days(up) {
  return Math.floor((Date.now() - Date.parse(`${up}T00:00:00+09:00`)) / DAY);
}

function relativeDate(up) {
  const d = days(up);
  if (Number.isNaN(d)) return "";
  if (d <= 0) return "오늘";
  if (d < 7) return `${d}일 전`;
  if (d < 30) return `${Math.floor(d / 7)}주 전`;
  if (d < 365) return `${Math.floor(d / 30)}개월 전`;
  return `${Math.floor(d / 365)}년 전`;
}

function matchPeriod(up, period) {
  return period === "all" || days(up) <= Number(period);
}

function fitClass(fit = "") {
  if (/높/.test(fit)) return "hi";
  if (/중/.test(fit)) return "mid";
  return "lo";
}

function badgeClass(bucket = "") {
  if (bucket === "3~5배") return "b1";
  if (bucket === "5~10배") return "b2";
  if (bucket === "10~50배") return "b3";
  return "b4";
}

function thumb(urls) {
  const candidates = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  const params = new URLSearchParams();
  params.set("url", candidates[0] || "");
  for (const fallback of candidates.slice(1)) params.append("fallback", fallback);
  return `/thumb?${params.toString()}`;
}

function youtubeThumb(item) {
  const variants = ["hqdefault", "sddefault", "mqdefault", "default"];
  const youtube = variants.flatMap((name) => [
    `https://i.ytimg.com/vi/${item.id}/${name}.jpg`,
    `https://img.youtube.com/vi/${item.id}/${name}.jpg`
  ]);
  return thumb(youtube);
}

function instagramThumb(item) {
  const proxied = item.thumb ? `https://images.weserv.nl/?url=${encodeURIComponent(item.thumb.replace(/^https?:\/\//, ""))}` : "";
  return thumb([item.thumb, proxied]);
}

function chipHtml(group, value, label, active, extra = "") {
  return `<button class="chip ${active === value ? "on" : ""}" data-group="${group}" data-value="${escapeHtml(value)}" type="button">${escapeHtml(label)}${extra}</button>`;
}

function facetCounts(items, key) {
  const counts = {};
  for (const item of items) counts[item[key]] = (counts[item[key]] || 0) + 1;
  return counts;
}

function renderChipGroup(id, group, pairs, active) {
  const root = $(id);
  const label = root.querySelector(".lbl").outerHTML;
  root.innerHTML = label + pairs.map(([value, text]) => chipHtml(group, value, text, active)).join("");
}

function renderCountedChipGroup(id, group, counts, active) {
  const entries = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const pairs = [["all", "전체"], ...entries.map((name) => [name, `${name} ${counts[name]}`])];
  renderChipGroup(id, group, pairs, active);
}

function loadDeletedLocal() {
  try {
    deleted = new Set(JSON.parse(localStorage.getItem("shopping_trend_radar_deleted_v1") || "[]"));
  } catch {
    deleted = new Set();
  }
}

async function loadDeletedServer() {
  try {
    const response = await fetch("/api/deleted", { cache: "no-store" });
    if (!response.ok) return;
    const remote = await response.json();
    if (Array.isArray(remote)) {
      deleted = new Set([...deleted, ...remote]);
      saveDeletedLocal();
    }
  } catch {
    // Local storage is enough when the API is unavailable.
  }
}

function saveDeletedLocal() {
  localStorage.setItem("shopping_trend_radar_deleted_v1", JSON.stringify([...deleted]));
}

async function saveDeletedServer() {
  try {
    await fetch("/api/deleted", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([...deleted])
    });
  } catch {
    // Keep local deletion state even if server persistence fails.
  }
}

function deletionKey(type, item) {
  if (type === "yt") return `yt:${item.id}`;
  if (type === "ig") return `ig:${item.code || item.link}`;
  return `th:${item.link}`;
}

function isDeleted(type, item) {
  return deleted.has(deletionKey(type, item));
}

function updateDeleteBar() {
  const bar = $("delbar");
  if (!deleted.size) {
    bar.style.display = "none";
    bar.innerHTML = "";
    return;
  }
  bar.style.display = "flex";
  bar.innerHTML = `삭제 ${deleted.size}개 <button id="restoreDeleted" type="button">전체 복원</button>`;
  $("restoreDeleted").onclick = () => {
    deleted.clear();
    saveDeletedLocal();
    
    renderAll();
  };
}

function setStatus(text) {
  $("statusText").textContent = text;
}

async function loadData() {
  const response = await fetch("data/gallery-data.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`data load failed: ${response.status}`);
  payload = await response.json();
  statusVersion = payload.version;
}

function updateHeader() {
  $("ytn").textContent = payload.counts.youtube;
  $("thn").textContent = payload.counts.threads;
  $("ign").textContent = payload.counts.instagram;
  const date = new Date(payload.generatedAt).toLocaleString();
  setStatus(`수집 데이터 ${date} 저장 · 캐시된 썸네일 사용`);
}

function setupControls() {
  renderChipGroup("ytCats", "cat", YT_CATS, state.yt.cat);
  renderChipGroup("ytPeriods", "per", PERIODS, state.yt.per);
  renderCountedChipGroup("ytGenres", "genre", facetCounts(payload.data.youtube, "genre"), state.yt.genre);
  renderChipGroup("ytMults", "mult", YT_MULTS, state.yt.mult);
  renderChipGroup("ytSorts", "sort", YT_SORTS, state.yt.sort);

  renderCountedChipGroup("thKeywords", "kw", facetCounts(payload.data.threads, "kw"), state.th.kw);
  renderChipGroup("thPeriods", "per", PERIODS, state.th.per);
  renderChipGroup("thSorts", "sort", COMMON_SORTS, state.th.sort);

  renderCountedChipGroup("igKeywords", "kw", facetCounts(payload.data.instagram, "kw"), state.ig.kw);
  renderChipGroup("igPeriods", "per", PERIODS, state.ig.per);
  renderChipGroup("igSorts", "sort", COMMON_SORTS, state.ig.sort);
}

function filteredYoutube() {
  const s = state.yt;
  let rows = payload.data.youtube.filter((item) => {
    if (isDeleted("yt", item)) return false;
    if (s.cat !== "all" && item.cat !== s.cat) return false;
    if (s.genre !== "all" && item.genre !== s.genre) return false;
    if (s.mult !== "all" && item.bucket !== s.mult) return false;
    if (!matchPeriod(item.up, s.per)) return false;
    if (s.q) {
      const q = s.q.toLowerCase();
      if (!`${item.title} ${item.ch}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  rows.sort((a, b) => {
    if (s.sort === "mult") return b.mult - a.mult;
    if (s.sort === "recent") return a.up < b.up ? 1 : a.up > b.up ? -1 : b.views - a.views;
    return b.views - a.views;
  });
  return rows;
}

function filteredList(type) {
  const data = type === "ig" ? payload.data.instagram : payload.data.threads;
  const s = state[type];
  let rows = data.filter((item) => {
    if (isDeleted(type, item)) return false;
    if (s.kw !== "all" && item.kw !== s.kw) return false;
    if (!matchPeriod(item.up || item.date, s.per)) return false;
    if (s.q) {
      const q = s.q.toLowerCase();
      if (!`${item.summary || ""} ${item.acct || ""}`.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  rows.sort((a, b) => {
    if (s.sort === "recent") {
      const da = a.date || a.up || "";
      const db = b.date || b.up || "";
      return da < db ? 1 : da > db ? -1 : b.views - a.views;
    }
    return b.views - a.views;
  });
  return rows;
}

function renderYoutube() {
  const rows = filteredYoutube();
  $("ytcnt").textContent = `${rows.length}개`;
  const visible = rows.slice(0, state.yt.limit);
  $("grid-yt").innerHTML = visible.length ? visible.map(renderYoutubeCard).join("") : `<div class="empty">조건에 맞는 영상이 없습니다.</div>`;
  updateMore("yt", rows.length);
}

function renderYoutubeCard(item) {
  return `<a class="card" href="https://www.youtube.com/shorts/${encodeURIComponent(item.id)}" target="_blank" rel="noopener">
    <button class="delbtn" data-key="${escapeHtml(deletionKey("yt", item))}" type="button" title="삭제">×</button>
    <div class="thumb">
      <img referrerpolicy="no-referrer" decoding="async" loading="lazy" src="${staticYoutubeThumb(item)}" onerror="this.onerror=null;this.src='assets/thumb-fallback.svg'">
      <span class="badge ${badgeClass(item.bucket)}">×${escapeHtml(item.mult)}</span>
      <span class="dbadge">${escapeHtml(relativeDate(item.up))}</span>
      <div class="play"><svg viewBox="0 0 68 48"><path d="M66.5 7.7a8 8 0 0 0-5.6-5.7C56 .7 34 .7 34 .7s-22 0-26.9 1.3A8 8 0 0 0 1.5 7.7 83 83 0 0 0 .2 24a83 83 0 0 0 1.3 16.3 8 8 0 0 0 5.6 5.7C12 47.3 34 47.3 34 47.3s22 0 26.9-1.3a8 8 0 0 0 5.6-5.7A83 83 0 0 0 67.8 24a83 83 0 0 0-1.3-16.3z" fill="#f00"/><path d="M27 34l18-10-18-10z" fill="#fff"/></svg></div>
    </div>
    <div class="meta">
      <div class="ttl">${escapeHtml(item.title)}</div>
      <div class="row2"><span class="ch">${escapeHtml(item.ch)}</span><span class="dot">·</span><span>조회 ${compactNumber(item.views)}</span><span class="dot">·</span><span>${escapeHtml(item.up)}</span></div>
      <div class="row2" style="margin-top:5px"><span class="tag">${escapeHtml(item.genre)}</span><span class="tag mt">평균 ${escapeHtml(item.mult)}배</span></div>
      ${item.script ? `<button class="scriptbtn" type="button">대본 보기</button><button class="copybtn hide" type="button">복사</button><div class="scriptbox hide">${escapeHtml(item.script)}</div>` : ""}
    </div>
  </a>`;
}

function renderThreads() {
  const rows = filteredList("th");
  $("thcnt").textContent = `${rows.length}개`;
  const visible = rows.slice(0, state.th.limit);
  $("grid-th").innerHTML = visible.length ? visible.map(renderThreadCard).join("") : `<div class="empty">조건에 맞는 자료가 없습니다.</div>`;
  updateMore("th", rows.length);
}

function renderThreadCard(item) {
  return `<a class="tcard" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">
    <button class="delbtn" data-key="${escapeHtml(deletionKey("th", item))}" type="button" title="삭제">×</button>
    <div class="ttop"><span class="kwtag">${escapeHtml(item.kw)}</span><span class="tviews">조회 ${escapeHtml(item.vtext || compactNumber(item.views))}</span></div>
    <div class="tsum">${escapeHtml(item.summary)}</div>
    <div class="row2"><span class="tacct">@${escapeHtml(item.acct)}</span><span class="dot">·</span><span title="실제 업로드일">${escapeHtml(item.date || item.up || "")}</span><span class="dot">·</span><span>${escapeHtml(relativeDate(item.date || item.up))}</span></div>
    ${item.fit ? `<div class="row2" style="margin-top:6px"><span class="fit ${fitClass(item.fit)}">${escapeHtml(item.fit)}</span></div>` : ""}
  </a>`;
}

function renderInstagram() {
  const rows = filteredList("ig");
  $("igcnt").textContent = `${rows.length}개`;
  const visible = rows.slice(0, state.ig.limit);
  $("grid-ig").innerHTML = visible.length ? visible.map(renderInstagramCard).join("") : `<div class="empty">조건에 맞는 자료가 없습니다.</div>`;
  updateMore("ig", rows.length);
}

function renderInstagramCard(item) {
  const image = instagramThumb(item);
  return `<a class="card" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">
    <button class="delbtn" data-key="${escapeHtml(deletionKey("ig", item))}" type="button" title="삭제">×</button>
    <div class="thumb ig">
      <div class="igph"><div class="i">📷</div><div class="k">${escapeHtml(item.kw)}</div><div class="a">@${escapeHtml(item.acct)}</div></div>
      ${image ? `<img referrerpolicy="no-referrer" decoding="async" loading="lazy" src="${staticInstagramThumb(item)}" onerror="this.onerror=null;this.src='assets/thumb-fallback.svg'">` : ""}
      <span class="igtag">${escapeHtml(item.kw)}</span>
      <span class="dbadge">조회 ${escapeHtml(item.vtext || compactNumber(item.views))}</span>
    </div>
    <div class="meta">
      <div class="ttl">${escapeHtml(item.summary)}</div>
      <div class="row2"><span class="ch">@${escapeHtml(item.acct)}</span><span class="dot">·</span><span>조회 ${escapeHtml(item.vtext || compactNumber(item.views))}</span><span class="dot">·</span><span>${escapeHtml(item.up)}</span></div>
      <div class="row2" style="margin-top:5px"><span class="fit ${fitClass(item.fit)}">${escapeHtml(item.fit)}</span></div>
    </div>
  </a>`;
}

function updateMore(type, total) {
  const button = $(`more-${type}`);
  const visible = state[type].limit;
  button.classList.toggle("hide", visible >= total);
  button.textContent = `더 보기 (${Math.min(visible, total)} / ${total})`;
}

function renderCurrent() {
  if (source === "yt") renderYoutube();
  if (source === "th") renderThreads();
  if (source === "ig") renderInstagram();
  updateDeleteBar();
}

function renderAll() {
  renderYoutube();
  renderThreads();
  renderInstagram();
  updateDeleteBar();
}

function resetLimit(type) {
  state[type].limit = type === "yt" ? 160 : 120;
}

function bindEvents() {
  document.querySelector(".sources").addEventListener("click", (event) => {
    const button = event.target.closest(".srcbtn");
    if (!button) return;
    source = button.dataset.src;
    document.querySelectorAll(".srcbtn").forEach((el) => el.classList.toggle("on", el === button));
    ["yt", "th", "ig"].forEach((name) => $(`view-${name}`).classList.toggle("hide", name !== source));
    renderCurrent();
  });

  document.body.addEventListener("click", (event) => {
    const chip = event.target.closest(".chip");
    if (chip) {
      const view = chip.closest(".view");
      const type = view.id.replace("view-", "");
      const group = chip.dataset.group;
      state[type][group] = chip.dataset.value;
      resetLimit(type);
      chip.parentElement.querySelectorAll(".chip").forEach((el) => el.classList.toggle("on", el === chip));
      renderCurrent();
      return;
    }

    const more = event.target.closest(".more");
    if (more) {
      const type = more.id.replace("more-", "");
      state[type].limit += type === "yt" ? 160 : 120;
      renderCurrent();
      return;
    }

    const del = event.target.closest(".delbtn");
    if (del) {
      event.preventDefault();
      event.stopPropagation();
      deleted.add(del.dataset.key);
      saveDeletedLocal();
      
      renderAll();
      return;
    }

    const scriptBtn = event.target.closest(".scriptbtn");
    if (scriptBtn) {
      event.preventDefault();
      event.stopPropagation();
      const copy = scriptBtn.nextElementSibling;
      const box = copy.nextElementSibling;
      const hidden = box.classList.toggle("hide");
      copy.classList.toggle("hide", hidden);
      scriptBtn.textContent = hidden ? "대본 보기" : "대본 숨기기";
      return;
    }

    const copyBtn = event.target.closest(".copybtn");
    if (copyBtn) {
      event.preventDefault();
      event.stopPropagation();
      copyText(copyBtn.nextElementSibling.innerText, copyBtn);
    }
  }, true);

  $("yq").addEventListener("input", (event) => {
    state.yt.q = event.target.value;
    resetLimit("yt");
    renderYoutube();
  });
  $("tq").addEventListener("input", (event) => {
    state.th.q = event.target.value;
    resetLimit("th");
    renderThreads();
  });
  $("igq").addEventListener("input", (event) => {
    state.ig.q = event.target.value;
    resetLimit("ig");
    renderInstagram();
  });

  $("refreshBtn").addEventListener("click", async () => {
    $("refreshBtn").disabled = true;
    setStatus("무로그인 직접 수집 중...");
    try {
      throw new Error("상시 사이트에서는 GitHub Actions가 매일 자동 수집합니다.");
      const response = null;
      if (!response.ok) throw new Error(`collect failed: ${response.status}`);
      await reloadDataIfChanged(true);
    } catch (error) {
      setStatus(`수집 실패: ${error.message}`);
    } finally {
      $("refreshBtn").disabled = false;
    }
  });
}

async function copyText(text, button) {
  const original = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  button.textContent = "복사됨";
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

async function reloadDataIfChanged(force = false) {
  const status = await fetch("data/status.json", { cache: "no-store" }).then((res) => res.json());
  if (!force && status.version === statusVersion) {
    setStatus(`수집 데이터 ${new Date(status.generatedAt).toLocaleString()} 저장 · 캐시 ${status.cache.items}개`);
    return;
  }
  await loadData();
  setupControls();
  updateHeader();
  renderAll();
}

function startTimers() {
  setInterval(() => {
    const current = dayTick();
    if (current !== lastDayTick) {
      lastDayTick = current;
      renderAll();
    }
  }, 60000);

  window.addEventListener("focus", renderAll);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) renderAll();
  });

  setInterval(() => {
    reloadDataIfChanged(false).catch(() => {});
  }, 60000);
}

async function init() {
  bindEvents();
  loadDeletedLocal();
  
  await loadData();
  setupControls();
  updateHeader();
  renderAll();
  startTimers();
}

init().catch((error) => {
  setStatus(`초기화 실패: ${error.message}`);
});
