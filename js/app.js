import { CONFIG } from "./config.js";
import { search, status, kakaoPlace, kakaoSearchUrl, storePhotos, regionOf } from "./api.js";
import { MODES, ALL_CATEGORIES, applyMode } from "./modes.js";
import { hours, holiday, rankLabel, area, catLabel, catIcon, buildMessage } from "./format.js";
import { createSheet } from "./sheet.js";
import { shareLink, readShare, isKakaoInApp, kakaoExternalUrl } from "./share.js";
import { attachSuggest, resolveQuery } from "./suggest.js";
import { svg } from "./icons.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DESKTOP = window.matchMedia("(min-width: 900px)");

const state = {
  mode: "dinner",
  categories: new Set(MODES.dinner.categories),
  headcount: 12,
  stores: [],
  total: 0,
  candidates: [],
  extra: new Map(), // 목록 밖에서 온 매장 (근처 2차 추천 등)
  activeId: null,
  preview: false,
  shared: false, // 공유 링크로 들어온 후보 보기
  origin: null, // 원점 { kind: me|place|store, lat, lng, query, ... }
  radius: 0,
  tone: "formal",
};
const storeById = (id) => state.stores.find((s) => s.id === id) || state.candidates.find((s) => s.id === id) || state.extra.get(id);
const inCand = (id) => state.candidates.some((c) => c.id === id);

// 정적 버튼 아이콘
$("searchIc").innerHTML = svg("search", 20);
$("filterIc").innerHTML = svg("sliders", 20);
$("locateBtn").innerHTML = svg("locate", 22);
$("hcMinus").innerHTML = svg("minus", 18);
$("hcPlus").innerHTML = svg("plus", 18);
document.querySelectorAll("[data-close], #epClose, #inapp .icon-btn").forEach((b) => (b.innerHTML = svg("close", 20)));

// ---------- 지도 ----------
const map = L.map("map", { zoomControl: false }).setView([37.57, 126.99], 14);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "eat.pl 잇플 · BC카드 결제 데이터 기반 | © OpenStreetMap",
}).addTo(map);
const layer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map);
const markers = new Map(); // 개별 매장 마커 (클러스터 제외)

const LABELED = 10; // 상위 N곳은 아이콘 핀, 나머지는 점
const HOT = 3; // 상위 3곳은 주황 핀
const kakaoRoute = (s) => `https://map.kakao.com/link/to/${encodeURIComponent(s.name)},${s.lat},${s.lng}`;

function thumbHtml(s, size = 22, label = true) {
  const photo = s.photo?.pin?.thumb || s.photo?.images?.[0]?.thumb;
  if (photo) return `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" />`;
  if (s.photo === undefined && s.photoLoading) return `<span class="tile skel"></span>`;
  return `<span class="tile${s.group ? " g" : ""}">${svg(catIcon(s.category), size)}${label ? `<small>${esc(catLabel(s.category))}</small>` : ""}</span>`;
}

function storeMarkerHtml(s, i) {
  const active = s.id === state.activeId;
  if (!active && i >= LABELED) return `<div class="mk-dot${s.group ? " g" : ""}"></div>`;
  const photo = s.photo?.pin?.thumb;
  const inner = photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" />` : svg(catIcon(s.category), 18);
  const pop = active
    ? `<div class="mk-pop" data-pop>
        <span class="mk-pop-th">${thumbHtml(s, 18, false)}</span>
        <span class="mk-pop-t"><b>${esc(s.name)}</b><span><em>${esc(rankLabel(s))}</em> · ${esc(catLabel(s.category))}</span></span>
        ${svg("chevron", 16)}
      </div>`
    : "";
  return `<div class="mk${active ? " is-active" : ""}">
    ${pop}${active ? '<i class="mk-halo"></i>' : ""}
    <div class="mk-pin${(s.order ?? i) < HOT ? " hot" : ""}${photo ? " has-photo" : ""}"><span class="mk-in">${inner}</span></div>
    <span class="mk-rk">${esc(String(s.rank))}%</span>
  </div>`;
}

// 격자 클러스터 (결정론): 같은 화면 칸(52px)에 들어온 매장은 숫자 원으로 묶는다. 선택한 매장은 항상 단독.
const CELL = 52;
function renderMarkers() {
  layer.clearLayers();
  markers.clear();
  const z = map.getZoom();
  const buckets = new Map();
  state.stores.forEach((s, i) => {
    let key = `solo:${s.id}`;
    if (s.id !== state.activeId && z < 17) {
      const p = map.project([s.lat, s.lng], z);
      key = `${Math.floor(p.x / CELL)}:${Math.floor(p.y / CELL)}`;
    }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push([s, i]);
  });
  for (const group of buckets.values()) {
    if (group.length === 1) {
      const [s, i] = group[0];
      const m = L.marker([s.lat, s.lng], {
        icon: L.divIcon({ className: "", html: storeMarkerHtml(s, i), iconSize: null, iconAnchor: [0, 0] }),
        title: s.name,
        zIndexOffset: s.id === state.activeId ? 100000 : i < LABELED ? 5000 - i * 20 : 0,
      })
        .on("click", (e) => {
          if (e.originalEvent?.target?.closest?.("[data-pop]")) return openDetail(s);
          select(s.id, "map");
        })
        .addTo(layer);
      markers.set(s.id, m);
    } else {
      const pts = group.map(([s]) => [s.lat, s.lng]);
      const lat = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const lng = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      const hot = group.some(([s, i]) => (s.order ?? i) < HOT);
      const size = Math.min(52, 30 + group.length * 3);
      L.marker([lat, lng], {
        icon: L.divIcon({ className: "", html: `<div class="mk-cluster${hot ? " hot" : ""}" style="--s:${size}px">${group.length}</div>`, iconSize: null, iconAnchor: [0, 0] }),
        zIndexOffset: 3000,
      })
        .on("click", () => map.fitBounds(L.latLngBounds(pts), { ...fitPadding(), maxZoom: Math.min(z + 3, 18) }))
        .addTo(layer);
    }
  }
}
let markerRaf = 0;
const scheduleMarkers = () => {
  cancelAnimationFrame(markerRaf);
  markerRaf = requestAnimationFrame(renderMarkers);
};
map.on("zoomend", scheduleMarkers);
map.on("click", () => state.preview && closePreview());

// 지도에서 UI(검색 바·시트·미리보기·패널)에 가려지는 영역
function cover() {
  const c = sheet.coverage();
  if (state.preview && !DESKTOP.matches) c.bottom = $("preview").offsetHeight + 12;
  return c;
}
function fitPadding() {
  const c = cover();
  return { paddingTopLeft: [c.left + 28, c.top + 40], paddingBottomRight: [28, c.bottom + 28] };
}
function focusStore(s) {
  const c = cover();
  const z = Math.max(map.getZoom(), 16);
  const visCx = (c.left + window.innerWidth) / 2;
  const visCy = (c.top + (window.innerHeight - c.bottom)) / 2 + 40; // 미니 카드 공간
  const off = L.point(window.innerWidth / 2 - visCx, window.innerHeight / 2 - visCy);
  map.flyTo(map.unproject(map.project([s.lat, s.lng], z).add(off), z), z, { duration: 0.5 });
}
function fitAll() {
  if (!state.stores.length) return;
  const pts = state.stores.map((s) => [s.lat, s.lng]);
  if (state.origin) pts.push([state.origin.lat, state.origin.lng]);
  map.fitBounds(L.latLngBounds(pts), { ...fitPadding(), maxZoom: 16 });
}

// ---------- 바텀시트 ----------
const sheet = createSheet({
  sheet: $("sheet"),
  head: $("sheetHead"),
  top: $("top"),
  onChange: () => map.invalidateSize({ pan: false }),
});

// ---------- 모드 탭 ----------
function renderTabs() {
  $("modeTabs").innerHTML = Object.entries(MODES)
    .map(([k, m]) => `<button type="button" role="tab" data-mode="${k}" aria-selected="${k === state.mode}">${m.label}</button>`)
    .join("");
}
$("modeTabs").addEventListener("click", (e) => {
  const k = e.target.closest("[data-mode]")?.dataset.mode;
  if (!k || k === state.mode) return;
  if (state.origin?.kind === "store") clearOrigin();
  setMode(k);
  run();
});
function setMode(k) {
  state.mode = k;
  state.categories = new Set(MODES[k].categories);
  renderTabs();
  renderFilterCount();
}

// ---------- 필터 시트 ----------
let pending = null;
function renderFilterCount() {
  const n = state.categories.size;
  $("filterCount").hidden = !n;
  $("filterCount").textContent = n;
}
function renderCatGrid() {
  $("catGrid").innerHTML = ALL_CATEGORIES.map(
    (c) => `<button type="button" class="cat-tile" data-cat="${esc(c)}" aria-pressed="${pending.cats.has(c)}">
      ${svg(catIcon(c), 22)}<span>${esc(catLabel(c))}</span></button>`
  ).join("");
  $("hcValue").textContent = pending.hc;
}
$("filterBtn").addEventListener("click", () => {
  pending = { cats: new Set(state.categories), hc: state.headcount };
  renderCatGrid();
  $("filterDialog").showModal();
});
$("catGrid").addEventListener("click", (e) => {
  const c = e.target.closest("[data-cat]")?.dataset.cat;
  if (!c) return;
  pending.cats.has(c) ? pending.cats.delete(c) : pending.cats.add(c);
  renderCatGrid();
});
$("hcMinus").addEventListener("click", () => ((pending.hc = Math.max(1, pending.hc - 1)), renderCatGrid()));
$("hcPlus").addEventListener("click", () => ((pending.hc = Math.min(99, pending.hc + 1)), renderCatGrid()));
$("filterReset").addEventListener("click", () => {
  pending = { cats: new Set(MODES[state.mode].categories), hc: 12 };
  renderCatGrid();
});
$("filterApply").addEventListener("click", () => {
  if (!pending.cats.size) return toast("업종을 선택하세요");
  state.categories = pending.cats;
  state.headcount = pending.hc;
  $("filterDialog").close();
  renderFilterCount();
  run();
});

// 모든 다이얼로그: [data-close] 버튼, 바깥(배경) 클릭으로 닫기
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target.closest("[data-close]")) d.close();
  })
);

// ---------- 검색 ----------
$("loc").addEventListener("input", () => clearOrigin());
$("filters").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("loc").blur();
  if (!state.origin) {
    const it = await resolveQuery($("loc").value);
    if (it) return pickPlace(it);
  }
  run();
});

let seq = 0;
async function run() {
  const my = ++seq;
  if (state.shared) {
    state.shared = false;
    history.replaceState(null, "", location.pathname);
  }
  closePreview(false);
  const mode = MODES[state.mode];
  if (!$("loc").value.trim()) $("loc").value = CONFIG.defaultLocation;
  const location = state.origin?.query || $("loc").value.trim();
  const categories = [...state.categories];
  $("resultCount").textContent = "검색 중…";
  try {
    if (!categories.length) throw new Error("업종을 선택하세요");
    const raw = await search({ keyword: mode.keyword, location, categories });
    if (my !== seq) return;
    const all = applyMode(state.mode, raw, { headcount: state.headcount, groupThreshold: CONFIG.groupThreshold });
    const near = state.origin ? nearby(all, state.origin) : all;
    state.total = near.length;
    state.stores = near.slice(0, CONFIG.maxPins);
    state.stores.forEach((s, i) => (s.order = i));
    if (status.fellBack) toast("실데이터 연결 실패 · 모의 데이터");
  } catch (err) {
    if (my !== seq) return;
    console.error(err);
    state.stores = [];
    state.total = 0;
    toast(err.message || "불러오기 실패");
  }
  state.activeId = null;
  $("results").scrollTop = 0;
  renderMarkers();
  fitAll();
  if (sheet.snap === "peek") sheet.set("half");
  await photosFirst(my);
}

// 사진 있는 매장을 먼저: 상위 PHOTO_N 곳의 사진을 최대 PHOTO_WAIT ms 동안 확인한 뒤 한 번만 정렬.
// 같은 그룹 안에서는 매출 순위 유지. 늦게 온 사진은 순서를 바꾸지 않고 썸네일만 채운다.
const PHOTO_N = 24;
const PHOTO_WAIT = 3000;
async function photosFirst(my) {
  const head = state.stores.slice(0, PHOTO_N);
  head.forEach((s) => s.photo === undefined && (s.photoLoading = true));
  renderResults(); // 스켈레톤
  const all = Promise.all(head.map(loadPhotos));
  await Promise.race([all, new Promise((r) => setTimeout(r, PHOTO_WAIT))]);
  if (my !== seq) return;
  const has = (s) => !!(s.photo?.pin || s.photo?.images?.length);
  const sorted = [...head.filter(has), ...head.filter((s) => !has(s))];
  state.stores = [...sorted, ...state.stores.slice(PHOTO_N)];
  head.forEach((s) => s.photo === undefined || delete s.photoLoading);
  renderResults();
  renderMarkers();
}

// ---------- 목록 ----------
function rowHtml(s) {
  const dist = s.dist != null ? `<span class="dist">${state.origin?.kind === "store" ? fmtWalk(s.dist) : fmtDist(s.dist)}</span> · ` : "";
  return `
  <li class="row${s.id === state.activeId ? " active" : ""}" data-id="${esc(s.id)}">
    <div class="thumb">${thumbHtml(s)}</div>
    <div class="info">
      <div class="name">${esc(s.name)}</div>
      <div class="meta">${dist}<span class="rk">${esc(rankLabel(s))}</span> · ${esc(catLabel(s.category))} · ${esc(area(s))}</div>
      <div class="meta">${esc(hours(s))} · ${esc(holiday(s))}</div>
      ${tagsHtml(s)}
    </div>
    ${addBtn(s, "add")}
  </li>`;
}
const tagsHtml = (s) => {
  const t = `${s.group ? "<em>회식 적합</em>" : ""}${s.local ? "<span>동네 맛집</span>" : ""}${s.busyTime ? `<span>${esc(s.busyDay)} ${esc(s.busyTime)} 붐빔</span>` : ""}`;
  return t ? `<div class="tags">${t}</div>` : "";
};
function addBtn(s, cls) {
  const on = inCand(s.id);
  const full = state.candidates.length >= CONFIG.maxCandidates;
  return `<button type="button" class="${cls}${on ? " on" : ""}" data-add="${esc(s.id)}" aria-label="${on ? "후보에서 빼기" : "후보에 담기"}" ${!on && full ? "disabled" : ""}>${svg(on ? "check" : "plus", 20)}</button>`;
}

function renderResults() {
  const o = state.origin;
  const where = state.shared
    ? "공유받은 후보"
    : !o
      ? MODES[state.mode].label
      : o.kind === "store"
        ? `${o.name} 근처 ${fmtDist(state.radius)}`
        : `${o.kind === "place" ? o.name : o.dong || "내 주변"} ${fmtDist(state.radius)}`;
  const n = state.total > state.stores.length ? `${state.total}곳(상위 ${state.stores.length})` : `${state.stores.length}곳`;
  $("resultCount").textContent = `${n} · ${where}`;
  renderStatus();
  $("results").innerHTML = state.stores.length ? state.stores.map(rowHtml).join("") : `<li class="empty">결과 없음</li>`;
}
function refreshStore(s) {
  // 사진 로드·후보 변경 후 해당 매장이 보이는 곳만 다시 그린다
  const i = state.stores.indexOf(s);
  if (i >= 0 && markers.has(s.id)) markers.get(s.id).setIcon(L.divIcon({ className: "", html: storeMarkerHtml(s, i), iconSize: null, iconAnchor: [0, 0] }));
  const li = document.querySelector(`.row[data-id="${CSS.escape(s.id)}"]`);
  if (li) li.outerHTML = rowHtml(s);
  const card = document.querySelector(`.pv-card[data-id="${CSS.escape(s.id)}"]`);
  if (card) card.outerHTML = pvCard(s);
  if ($("detail").open && detailStore?.id === s.id) renderDetail(s, true);
}

$("results").addEventListener("click", (e) => {
  const add = e.target.closest("[data-add]");
  if (add) return toggleCandidate(add.dataset.add);
  const li = e.target.closest(".row");
  if (li) select(li.dataset.id, "list");
});

// ---------- 선택 & 미리보기 카드 ----------
function select(id, from) {
  if (id === state.activeId && from === "carousel") return;
  state.activeId = id;
  renderMarkers();
  document.querySelectorAll(".row.active").forEach((r) => r.classList.remove("active"));
  const s = storeById(id);
  if (!s) return;
  document.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.classList.add("active");
  loadPhotos(s);
  if (from !== "carousel") {
    if (!state.preview) openPreview();
    scrollPreviewTo(id, state.preview && from === "map");
  }
  requestAnimationFrame(() => focusStore(s));
}

function pvCard(s) {
  const dist = s.dist != null ? `<span>${state.origin?.kind === "store" ? fmtWalk(s.dist) : fmtDist(s.dist)}</span>` : "";
  const on = inCand(s.id);
  return `
  <article class="pv-card" data-id="${esc(s.id)}">
    <div class="pv-main" data-detail="${esc(s.id)}">
      <div class="pv-thumb">${thumbHtml(s, 26)}</div>
      <div class="pv-info">
        <h3>${esc(s.name)}</h3>
        <div class="pv-sub"><span class="rk-pill">${esc(rankLabel(s))}</span><span>${esc(catLabel(s.category))}</span><span>${esc(area(s))}</span>${dist}</div>
        <div class="pv-meta">${svg("clock", 14)} ${esc(hours(s))} · ${esc(holiday(s))}</div>
      </div>
      <span class="pv-go">${svg("chevron", 18)}</span>
    </div>
    <div class="pv-actions">
      <button type="button" data-eatpl="${esc(s.id)}">${svg("external", 20)}<span>잇플</span></button>
      <a href="${esc(kakaoRoute(s))}" target="_blank" rel="noopener">${svg("route", 20)}<span>길찾기</span></a>
      <button type="button" data-add="${esc(s.id)}" class="${on ? "on" : ""}" ${!on && state.candidates.length >= CONFIG.maxCandidates ? "disabled" : ""}>${svg(on ? "check" : "plus", 20)}<span>${on ? "담김" : "후보"}</span></button>
      <button type="button" data-share-one="${esc(s.id)}">${svg("share", 20)}<span>공유</span></button>
    </div>
    ${state.mode === "dinner" && !state.shared ? `<button type="button" class="pv-next" data-next="${esc(s.id)}">이 근처 2차 찾기 ${svg("chevron", 14)}</button>` : ""}
    <button type="button" class="btn btn-primary btn-block" data-eatpl="${esc(s.id)}">잇플에서 자세히 보기 ${svg("chevron", 18)}</button>
  </article>`;
}

function openPreview() {
  state.preview = true;
  $("pvTrack").innerHTML = state.stores.map(pvCard).join("");
  $("preview").hidden = false;
  document.body.classList.add("previewing");
  document.documentElement.style.setProperty("--pv-h", `${$("preview").offsetHeight}px`);
}
function closePreview(rerender = true) {
  if (!state.preview) return;
  state.preview = false;
  $("preview").hidden = true;
  document.body.classList.remove("previewing");
  state.activeId = null;
  document.querySelectorAll(".row.active").forEach((r) => r.classList.remove("active"));
  if (rerender) renderMarkers();
}
function scrollPreviewTo(id, smooth) {
  const t = $("pvTrack");
  const el = t.querySelector(`.pv-card[data-id="${CSS.escape(id)}"]`);
  if (el) t.scrollTo({ left: el.offsetLeft - (t.clientWidth - el.offsetWidth) / 2, behavior: smooth ? "smooth" : "auto" });
}
// 카드를 넘기면 가운데 카드의 매장을 선택 (핀·지도 동기화)
let pvT = 0;
$("pvTrack").addEventListener("scroll", () => {
  clearTimeout(pvT);
  pvT = setTimeout(() => {
    const t = $("pvTrack");
    const mid = t.scrollLeft + t.clientWidth / 2;
    let best = null, bd = Infinity;
    for (const el of t.children) {
      const d = Math.abs(el.offsetLeft + el.offsetWidth / 2 - mid);
      if (d < bd) (bd = d), (best = el);
    }
    if (best && best.dataset.id !== state.activeId) select(best.dataset.id, "carousel");
  }, 120);
});

// 미리보기·상세·결정 화면 공통 버튼 처리
function onAction(e) {
  const t = e.target.closest("[data-eatpl],[data-add],[data-share-one],[data-next],[data-detail],[data-add-second],[data-rm],[data-tone]");
  if (!t) return;
  const d = t.dataset;
  if (d.eatpl) return openEatpl(storeById(d.eatpl));
  if (d.add) return toggleCandidate(d.add);
  if (d.addSecond) return toggleCandidate(d.addSecond, "2차");
  if (d.rm) return toggleCandidate(d.rm);
  if (d.shareOne) return shareStore(storeById(d.shareOne));
  if (d.next) return findSecondStop(storeById(d.next));
  if (d.detail) return openDetail(storeById(d.detail));
  if (d.tone) {
    state.tone = d.tone;
    return renderDecide();
  }
}
$("preview").addEventListener("click", onAction);
$("detail").addEventListener("click", onAction);
$("decide").addEventListener("click", onAction);

// ---------- 매장 상세 ----------
let detailStore = null;
let detailMap = null;
function openDetail(s) {
  if (!s) return;
  detailStore = s;
  renderDetail(s);
  $("detail").showModal();
  $("detail").scrollTop = 0;
  // 열린 뒤 크기 확정 → 미니 지도 재계산
  requestAnimationFrame(() => detailMap?.invalidateSize().setView([s.lat, s.lng], 16));
  loadPhotos(s);
  resolveKakao(s);
}
function renderDetail(s, keepScroll = false) {
  const imgs = s.photo?.images || [];
  const on = inCand(s.id);
  const hero = imgs.length
    ? `<div class="dt-track" id="dtTrack">${imgs
        .map((im) => `<a href="${esc(im.source)}" target="_blank" rel="noopener nofollow"><img src="${esc(im.thumb)}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.remove()" /></a>`)
        .join("")}</div><span class="dt-count" id="dtCount">1 / ${imgs.length}</span>`
    : `<div class="dt-tile${s.group ? " g" : ""}">${svg(catIcon(s.category), 56)}</div>`;
  const scroll = $("detail").scrollTop;
  $("detail").innerHTML = `
    <div class="dt-hero">
      ${hero}
      <button type="button" class="dt-btn back" data-close aria-label="닫기">${svg("back", 22)}</button>
      <button type="button" class="dt-btn share" data-share-one="${esc(s.id)}" aria-label="공유">${svg("share", 20)}</button>
    </div>
    <div class="dt-body">
      <h2>${esc(s.name)}</h2>
      <div class="dt-sub"><span class="rk-pill">구내 ${esc(rankLabel(s))}</span><span class="rk-pill soft">전국 상위 ${esc(String(s.rankAll))}%</span><span>${esc(catLabel(s.category))}</span></div>
      ${tagsHtml(s)}
      <ul class="dt-rows">
        <li>${svg("clock", 20)}<div><b>${esc(hours(s))}</b><span>${esc(holiday(s))} · 최근 1개월 결제 기준</span></div></li>
        ${s.busyTime ? `<li>${svg("fire", 20)}<div><b>${esc(s.busyDay)}요일 ${esc(s.busyTime)} 붐빔</b></div></li>` : ""}
        ${s.customers.length ? `<li>${svg("users", 20)}<div><b>주 고객</b><span>${esc(s.customers.join(", "))}</span></div></li>` : ""}
        <li>${svg("pin", 20)}<div><b>${esc(s.address)}</b>
          <span class="dt-links"><a href="${esc(kakaoRoute(s))}" target="_blank" rel="noopener">길찾기</a><a data-kakao="${esc(s.id)}" href="${esc(kakaoSearchUrl(s))}" target="_blank" rel="noopener">카카오맵 사진·리뷰</a></span></div></li>
      </ul>
      <div id="dtMap" class="dt-map"></div>
      ${state.mode === "dinner" && !state.shared ? `<button type="button" class="btn btn-line btn-block" data-next="${esc(s.id)}">이 근처 2차 찾기</button>` : ""}
    </div>
    <div class="dt-bar">
      <button type="button" class="btn btn-ghost" data-add="${esc(s.id)}" ${!on && state.candidates.length >= CONFIG.maxCandidates ? "disabled" : ""}>${svg(on ? "check" : "plus", 18)} ${on ? "담김" : "후보 담기"}</button>
      <button type="button" class="btn btn-primary" data-eatpl="${esc(s.id)}">잇플에서 보기 ${svg("chevron", 18)}</button>
    </div>`;
  if (keepScroll) {
    $("detail").scrollTop = scroll;
    requestAnimationFrame(() => detailMap?.invalidateSize().setView([s.lat, s.lng], 16));
  }
  $("dtTrack")?.addEventListener("scroll", (e) => {
    const t = e.currentTarget;
    $("dtCount").textContent = `${Math.round(t.scrollLeft / t.clientWidth) + 1} / ${imgs.length}`;
  });
  detailMap?.remove();
  detailMap = L.map("dtMap", { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false, attributionControl: false }).setView([s.lat, s.lng], 16);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(detailMap);
  L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: `<div class="mk"><div class="mk-pin hot"><span class="mk-in">${svg(catIcon(s.category), 18)}</span></div></div>`, iconSize: null, iconAnchor: [0, 0] }) }).addTo(detailMap);
}
$("detail").addEventListener("close", () => {
  detailMap?.remove();
  detailMap = null;
  detailStore = null;
});

// ---------- 후보 ----------
function toggleCandidate(id, stage) {
  const i = state.candidates.findIndex((c) => c.id === id);
  const s = storeById(id);
  if (i >= 0) state.candidates.splice(i, 1);
  else if (s && state.candidates.length < CONFIG.maxCandidates) {
    s.stage = stage ?? (state.mode === "dinner" ? "1차" : state.mode === "after" ? "2차" : "");
    state.candidates.push(s);
    if (state.candidates.length === CONFIG.maxCandidates) toast("후보 3곳 선택됨");
  }
  renderTray();
  // 후보 버튼이 있는 곳 갱신 (전체 비활성/활성 상태가 바뀌므로 보이는 것 모두)
  document.querySelectorAll(".row").forEach((li) => {
    const v = storeById(li.dataset.id);
    if (v) li.outerHTML = rowHtml(v);
  });
  if (state.preview) {
    const left = $("pvTrack").scrollLeft;
    $("pvTrack").innerHTML = state.stores.map(pvCard).join("");
    $("pvTrack").scrollLeft = left;
  }
  if ($("detail").open && detailStore) renderDetail(detailStore, true);
  if ($("decide").open) renderDecide();
}
function renderTray() {
  const n = state.candidates.length;
  $("candCount").textContent = n;
  $("candBtn").disabled = !n;
  $("candBtn").classList.toggle("has", n > 0);
}

// ---------- 결정·공유 화면 ----------
$("candBtn").addEventListener("click", openDecide);
const nearbyCache = new Map();
function openDecide() {
  renderDecide();
  $("decide").showModal();
  $("decide").scrollTop = 0;
  const first = state.candidates.find((c) => c.stage === "1차");
  if (first && !nearbyCache.has(first.id)) loadNearby2nd(first);
}
async function loadNearby2nd(f) {
  nearbyCache.set(f.id, null); // 로딩 중
  try {
    const raw = await search({ keyword: null, location: guOf(f.address), categories: MODES.after.categories });
    const list = applyMode("after", raw, { headcount: 0, groupThreshold: 99 })
      .map((s) => ((s.dist = meters(f, s)), s))
      .filter((s) => s.dist <= 600 && s.id !== f.id)
      .slice(0, 8);
    list.forEach((s) => state.extra.set(s.id, s));
    nearbyCache.set(f.id, list);
    list.slice(0, 4).forEach(loadPhotos);
  } catch {
    nearbyCache.set(f.id, []);
  }
  if ($("decide").open) renderDecide();
}
function decideMessage() {
  return buildMessage(state.candidates, { modeNoun: MODES[state.mode].noun, tone: state.tone, link: shareLink(state.candidates, state.mode) });
}
function renderDecide() {
  const c = state.candidates;
  if (!c.length) return $("decide").close();
  const first = c.find((x) => x.stage === "1차");
  const near = first ? nearbyCache.get(first.id) : undefined;
  const showNear = first && !c.some((x) => x.stage === "2차") && near !== undefined && (near === null || near.length);
  const scroll = $("decide").scrollTop;
  $("decide").innerHTML = `
    <div class="pg-head"><button type="button" class="icon-btn" data-close aria-label="닫기">${svg("back", 22)}</button></div>
    <div class="dc-hero"><h2>이 곳 어때요?</h2><p>후보 ${c.length}곳</p></div>
    <ul class="dc-list">
      ${c
        .map(
          (s) => `<li class="dc-item">
        <div class="thumb">${thumbHtml(s)}</div>
        <div class="info">
          <div class="name">${s.stage ? `<i class="stage">${esc(s.stage)}</i>` : ""}${esc(s.name)}</div>
          <div class="meta"><span class="rk">${esc(rankLabel(s))}</span> · ${esc(catLabel(s.category))} · ${esc(area(s))}</div>
        </div>
        <button type="button" class="icon-btn" data-rm="${esc(s.id)}" aria-label="빼기">${svg("close", 18)}</button>
      </li>`
        )
        .join("")}
    </ul>
    ${
      showNear
        ? `<section class="dc-near"><h3>${esc(first.name)} 근처 2차</h3><div class="dc-track">${
            near === null
              ? `<div class="nb-card skel"></div><div class="nb-card skel"></div>`
              : near
                  .map(
                    (s) => `<div class="nb-card">
              <div class="nb-thumb">${thumbHtml(s, 26)}</div>
              <b>${esc(s.name)}</b>
              <span><em>${esc(rankLabel(s))}</em> · ${fmtWalk(s.dist)}</span>
              <button type="button" class="btn btn-line btn-sm" data-add-second="${esc(s.id)}" ${c.length >= CONFIG.maxCandidates ? "disabled" : ""}>${svg("plus", 14)} 담기</button>
            </div>`
                  )
                  .join("")
          }</div></section>`
        : ""
    }
    <section class="dc-msg">
      <div class="dc-msg-head"><h3>안내문</h3>
        <div class="seg"><button type="button" data-tone="formal" aria-pressed="${state.tone === "formal"}">격식</button><button type="button" data-tone="casual" aria-pressed="${state.tone === "casual"}">캐주얼</button></div>
      </div>
      <textarea id="message" readonly rows="8">${esc(decideMessage())}</textarea>
    </section>
    <div class="dt-bar">
      <button type="button" class="btn btn-ghost" id="copyBtn">문구 복사</button>
      <button type="button" class="btn btn-primary" id="shareBtn">단톡방에 공유하기 ${svg("chevron", 18)}</button>
    </div>`;
  $("decide").scrollTop = scroll;
  $("copyBtn").onclick = async () => {
    await copyText(decideMessage());
    toast("복사됨");
  };
  $("shareBtn").onclick = () => shareText("회식 장소 후보", decideMessage());
}

async function shareText(title, text) {
  if (navigator.share) {
    try {
      await navigator.share({ title, text });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  await copyText(text);
  toast("복사됨");
}
function shareStore(s) {
  if (!s) return;
  shareText(s.name, `${s.name} (${catLabel(s.category)} · ${area(s)})\n${shareLink([s], state.mode)}`);
}
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ---------- 사진 ----------
async function loadPhotos(s) {
  if (!s || s.photo !== undefined) return;
  s.photo = undefined;
  const res = await storePhotos(s);
  s.photo = res; // null = 없음/실패
  delete s.photoLoading;
  refreshStore(s);
  if ($("decide").open) renderDecide();
}
async function resolveKakao(s) {
  if (!s) return;
  const place = await kakaoPlace(s);
  const a = document.querySelector(`[data-kakao="${CSS.escape(s.id)}"]`);
  if (place && a) a.href = place.url;
}

// ---------- 잇플 상세 모달 (merUrl 원본 그대로) ----------
let epTimer;
function openEatpl(s) {
  if (!s?.url) return;
  $("epTitle").textContent = s.name;
  $("epOpen").href = s.url;
  $("epLoading").textContent = "불러오는 중…";
  $("epLoading").hidden = false;
  $("epFrame").src = s.url;
  clearTimeout(epTimer);
  epTimer = setTimeout(() => ($("epLoading").textContent = "안 보이면 '새 창'"), 8000);
  $("eatplDialog").showModal();
}
$("epFrame").addEventListener("load", () => {
  if ($("epFrame").src !== "about:blank") $("epLoading").hidden = true;
});
$("epClose").addEventListener("click", () => $("eatplDialog").close());
$("eatplDialog").addEventListener("close", () => {
  clearTimeout(epTimer);
  $("epFrame").src = "about:blank";
});

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 1800);
}
function renderStatus() {
  const b = $("statusBadge");
  const live = status.source !== "mock" && !status.fellBack;
  b.hidden = false;
  b.className = `badge ${live ? "badge-live" : ""}`;
  b.textContent = state.shared ? "공유 링크" : live ? "실데이터" : "모의";
  b.title = status.fellBack ? `실데이터 연결 실패: ${status.error}` : "";
}

// ---------- 원점 (현위치·역/장소·1차) ----------
const RADII = [800, 1500, 3000];
const PLACE_RADII = [500, 1000, 2000];
const WALK_RADII = [300, 600, 1000];
const MIN_NEAR = 5;
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);
const fmtWalk = (m) => `도보 ${Math.max(1, Math.round(m / 75))}분`;
function meters(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// 모드 정렬(매출 랭킹)은 유지하고 반경으로만 거른다. MIN_NEAR 미만이면 다음 반경.
function nearby(list, o) {
  const radii = o.radii || RADII;
  for (const s of list) s.dist = meters(o, s);
  for (const r of radii) {
    const inR = list.filter((s) => s.dist <= r && s.id !== o.id);
    if (inR.length >= MIN_NEAR || r === radii.at(-1)) {
      state.radius = r;
      return inR;
    }
  }
  return list;
}
function guOf(address) {
  const t = String(address).split(/\s+/);
  const i = t.findIndex((x, k) => k > 0 && /[구군]$/.test(x));
  return (i > 0 ? t.slice(0, i + 1) : t.slice(0, 2)).join(" ");
}
function clearOrigin() {
  if (!state.origin) return;
  state.origin = null;
  state.radius = 0;
  meLayer.clearLayers();
  $("locateBtn").classList.remove("on");
  for (const s of state.stores) delete s.dist;
}
function drawMe(o) {
  meLayer.clearLayers();
  if (o.kind === "store" || o.kind === "place") {
    const badge = o.kind === "store" ? "<b>1차</b>" : '<b class="pl">기준</b>';
    L.marker([o.lat, o.lng], {
      icon: L.divIcon({ className: "", html: `<div class="origin-mk">${badge}${esc(o.name)}</div>`, iconSize: null }),
      interactive: false,
      zIndexOffset: 200000,
    }).addTo(meLayer);
    return;
  }
  if (o.acc && o.acc < 2000) L.circle([o.lat, o.lng], { radius: o.acc, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(meLayer);
  L.marker([o.lat, o.lng], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: null }), interactive: false, zIndexOffset: 200000 }).addTo(meLayer);
}

const GEO_ERR = { 1: "위치 권한 필요", 2: "위치 확인 실패", 3: "위치 확인 시간 초과" };
$("locateBtn").addEventListener("click", () => {
  if (!("geolocation" in navigator)) return toast("위치 기능 미지원");
  if (!window.isSecureContext) return toast("https에서만 위치 사용 가능");
  const btn = $("locateBtn");
  btn.classList.add("busy");
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const o = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
      drawMe(o);
      try {
        const region = await regionOf(o.lat, o.lng);
        state.origin = { kind: "me", ...o, ...region };
        $("loc").value = `내 위치 · ${region.dong}`;
        btn.classList.add("on");
        await run();
      } catch (e) {
        toast(e.message);
        map.setView([o.lat, o.lng], 16);
      } finally {
        btn.classList.remove("busy");
      }
    },
    (err) => {
      btn.classList.remove("busy");
      toast(GEO_ERR[err.code] || "위치 확인 실패");
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
});

// 1차 → 2차: 1차를 후보에 담고 그 장소 기준 도보권 2차 검색
function findSecondStop(s) {
  if (!s) return;
  if (!inCand(s.id) && state.candidates.length < CONFIG.maxCandidates) {
    s.stage = "1차";
    state.candidates.push(s);
    renderTray();
  }
  $("detail").open && $("detail").close();
  state.origin = { kind: "store", id: s.id, name: s.name, lat: s.lat, lng: s.lng, radii: WALK_RADII, query: guOf(s.address) };
  drawMe(state.origin);
  $("locateBtn").classList.remove("on");
  $("loc").value = `${s.name} 근처`;
  setMode("after");
  run();
}

// ---------- 검색어 추천 ----------
function pickPlace(it) {
  clearOrigin();
  $("loc").value = it.label;
  if (it.kind !== "gu") {
    state.origin = { kind: "place", name: it.label, lat: it.lat, lng: it.lng, radii: PLACE_RADII, query: guOf(it.address) };
    drawMe(state.origin);
  }
  $("loc").blur();
  run();
}
attachSuggest({ input: $("loc"), box: $("suggest"), onPick: pickPlace });

// ---------- init ----------
$("loc").value = CONFIG.defaultLocation;
if (isKakaoInApp()) {
  $("inappOpen").href = kakaoExternalUrl(location.href);
  $("inapp").hidden = false;
}
renderTabs();
renderFilterCount();
renderTray();
const shared = readShare();
if (shared) {
  state.shared = true;
  if (MODES[shared.mode]) state.mode = shared.mode;
  renderTabs();
  state.stores = shared.stores;
  state.stores.forEach((s, i) => (s.order = i));
  state.total = shared.stores.length;
  renderResults();
  renderMarkers();
  fitAll();
  state.stores.forEach(loadPhotos);
} else run();
