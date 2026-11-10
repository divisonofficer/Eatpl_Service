import { CONFIG } from "./config.js";
import { search, status, kakaoPlace, kakaoSearchUrl, storePhotos, storeAmenities, regionOf, geocode } from "./api.js";
import { MODES, ALL_CATEGORIES, applyMode } from "./modes.js";
import { hours, holiday, rankTier, tierHtml, area, catLabel, catIcon, buildMessage } from "./format.js";
import { createSheet } from "./sheet.js";
import { shareLink, readShare, isKakaoInApp, kakaoExternalUrl } from "./share.js";
import { attachSuggest, resolveQuery } from "./suggest.js";
import { svg } from "./icons.js";
import { recommend, topReasons, DAYS, todayKST } from "./recommend.js";
import { amenityStates, AMENITY_TEXT } from "./amenities-fmt.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const DESKTOP = window.matchMedia("(min-width: 900px)");

const state = {
  mode: "dinner",
  categories: new Set(MODES.dinner.categories),
  headcount: 8,
  day: null, // null = 오늘
  teamAges: new Set(),
  teamGender: null, // male | female | mixed
  excluded: 0, // 휴무·영업 외로 제외된 수
  prefs: new Set(), // 우선 보기: room | park | cork
  all: [], // 검색 결과 전체 (정렬됨)
  stores: [], // 화면에 보이는 목록 = all 에 룸·주차·콜키지 필터 적용
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
const storeById = (id) => state.stores.find((s) => s.id === id) || state.all.find((s) => s.id === id) || state.candidates.find((s) => s.id === id) || state.extra.get(id);
const inCand = (id) => state.candidates.some((c) => c.id === id);

// 정적 버튼 아이콘
$("searchIc").innerHTML = svg("search", 20);
$("locateBtn").innerHTML = svg("locate", 22);
document.querySelectorAll("[data-close], #epClose, #inapp .icon-btn").forEach((b) => (b.innerHTML = svg("close", 20)));

// ---------- 지도 ----------
const map = L.map("map", { zoomControl: false }).setView([37.57, 126.99], 14);
map.attributionControl.setPrefix(false);
window.__hp = { map }; // e2e 확인용 // "Leaflet" 접두어 제거 (OSM·잇플 출처 표기는 유지)
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

const hi = (u) => (u ? String(u).replace("/130x130_85_c/", "/320x320_85_c/") : u);
function thumbHtml(s, size = 22, label = true) {
  const photo = hi(s.photo?.pin?.thumb || s.photo?.images?.[0]?.thumb);
  if (photo) return `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" />`;
  if (s.photo === undefined && s.photoLoading) return `<span class="tile skel"></span>`;
  return `<span class="tile${s.group ? " g" : ""}">${svg(catIcon(s.category), size)}${label ? `<small>${esc(catLabel(s.category))}</small>` : ""}</span>`;
}

function storeMarkerHtml(s, i, more = 0) {
  const active = s.id === state.activeId;
  const moreBadge = more > 0 ? `<b class="mk-more" data-more>+${more}</b>` : "";
  if (!active && i >= LABELED) return `<div class="mk mini"><div class="mk-pin${s.group ? " g" : ""}"><span class="mk-in">${svg(catIcon(s.category), 12)}</span></div>${moreBadge}</div>`;
  const photo = hi(s.photo?.pin?.thumb);
  const inner = photo ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" />` : svg(catIcon(s.category), 18);
  const pop = active
    ? `<div class="mk-pop" data-pop>
        <span class="mk-pop-th">${thumbHtml(s, 18, false)}</span>
        <span class="mk-pop-t"><b>${esc(s.name)}</b><span>${tierHtml(s.rank)} ${esc(catLabel(s.category))}</span>${amenityBadges(s, 12, false)}</span>
        ${svg("chevron", 16)}
      </div>`
    : "";
  return `<div class="mk${active ? " is-active" : ""}">
    ${pop}${active ? '<i class="mk-halo"></i>' : ""}
    <div class="mk-pin${(s.order ?? i) < HOT ? " hot" : ""}${photo ? " has-photo" : ""}"><span class="mk-in">${inner}</span></div>
    ${rankTier(s.rank) ? `<span class="mk-rk t${rankTier(s.rank).t}">${rankTier(s.rank).label}</span>` : ""}${moreBadge}
  </div>`;
}

// 핀 묶기 (결정론): 우선순위(선택 > 매출 순위) 순으로 놓으며, 이미 놓인 핀과 화면 거리가 가까우면 그 핀에 합친다.
// 대표 핀은 그대로 보이고 '+n' 배지(누르면 묶음 확대). 확대 18 이상이면 묶지 않는다.
const PIN_R = { big: 25, mini: 16 }; // 화면상 핀 반경(px) — 물방울이 기준점 위로 그려지는 만큼 여유
function renderMarkers() {
  layer.clearLayers();
  markers.clear();
  const z = map.getZoom();
  const items = state.stores
    .map((s, i) => ({ s, i, p: map.project([s.lat, s.lng], z), big: s.id === state.activeId || i < LABELED }))
    .sort((a, b) => (a.s.id === state.activeId ? -1 : a.i) - (b.s.id === state.activeId ? -1 : b.i));
  const seeds = [];
  for (const it of items) {
    const r = it.big ? PIN_R.big : PIN_R.mini;
    const host = z < 19 && it.s.id !== state.activeId ? seeds.find((sd) => sd.p.distanceTo(it.p) < sd.r + r + 4) : null;
    if (host) host.members.push(it);
    else seeds.push({ ...it, r, members: [it] });
  }
  for (const sd of seeds) {
    const { s, i } = sd;
    const more = sd.members.length - 1;
    const m = L.marker([s.lat, s.lng], {
      icon: L.divIcon({ className: "", html: storeMarkerHtml(s, i, more), iconSize: null, iconAnchor: [0, 0] }),
      title: more ? `${s.name} 외 ${more}곳` : s.name,
      zIndexOffset: s.id === state.activeId ? 100000 : sd.big ? 5000 - i * 20 : 1000 - i,
    })
      .on("click", (e) => {
        const t = e.originalEvent?.target;
        if (t?.closest?.("[data-more]")) {
          const pts = sd.members.map(({ s: v }) => [v.lat, v.lng]);
          return auto(() => map.fitBounds(L.latLngBounds(pts), { ...fitPadding(), maxZoom: Math.min(z + 3, 18) }));
        }
        const pop = t?.closest?.("[data-pop]");
        if (pop) return openDetail(s, pop);
        select(s.id, "map");
      })
      .addTo(layer);
    m._members = sd.members.length;
    markers.set(s.id, m);
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
// 프로그램이 움직인 이동(결과 맞춤·선택 이동)은 '여기서 검색' 버튼을 띄우지 않는다.
// 횟수로 세면 실제로 안 움직였을 때 moveend 가 안 와서 어긋나므로 시간 창으로 판단.
let autoUntil = 0;
const auto = (fn) => {
  autoUntil = performance.now() + 1200;
  fn();
};
function focusStore(s) {
  const c = cover();
  const z = Math.max(map.getZoom(), 16);
  const visCx = (c.left + window.innerWidth) / 2;
  const visCy = (c.top + (window.innerHeight - c.bottom)) / 2 + 40; // 미니 카드 공간
  const off = L.point(window.innerWidth / 2 - visCx, window.innerHeight / 2 - visCy);
  auto(() => map.flyTo(map.unproject(map.project([s.lat, s.lng], z).add(off), z), z, { duration: 0.5 }));
}
// 결과 0곳: 원점 좌표가 있으면 그곳으로, 없으면 검색어를 좌표로 바꿔 이동
async function moveToQuery(my) {
  let p = state.origin && Number.isFinite(state.origin.lat) ? state.origin : null;
  if (!p) p = await geocode(($("loc").value || "").replace(/\s*(근처|일대)$/, ""));
  if (!p || my !== seq) return;
  const c = cover();
  const z = 15;
  const off = L.point((c.left - 0) / 2, (c.top - c.bottom) / 2);
  auto(() => map.flyTo(map.unproject(map.project([p.lat, p.lng], z).subtract(off), z), z, { duration: 0.6 }));
}
function fitAll() {
  if (!state.stores.length) return;
  const pts = state.stores.map((s) => [s.lat, s.lng]);
  if (state.origin) pts.push([state.origin.lat, state.origin.lng]);
  auto(() => map.fitBounds(L.latLngBounds(pts), { ...fitPadding(), maxZoom: 16 }));
}

// ---------- 바텀시트 ----------
const sheet = createSheet({
  sheet: $("sheet"),
  head: $("sheetHead"),
  top: $("top"),
  onChange: () => auto(() => map.invalidateSize({ pan: false })), // 시트 높이 변화는 사용자 이동이 아님
});

// ---------- 모드 탭 ----------
// ---------- 상단 펼침 버튼 (모드·인원) ----------
// 접힌 상태: 현재 값 하나 + ▾ / 누르면 그 자리에서 선택지가 펼쳐지고, 고르면 접힌다. 한 번에 하나만.
let openPicker = null;
function pickerHtml(id, items, cur) {
  if (openPicker === id)
    return items.map((it) => `<button type="button" role="radio" data-k="${it.k}" aria-checked="${it.k === cur.k}">${it.label}${it.sub ? `<small>${it.sub}</small>` : ""}</button>`).join("");
  return `<button type="button" class="pk-cur" data-toggle aria-expanded="false">${cur.label}${svg("down", 14)}</button>`;
}
function renderTabs() {
  const modes = Object.entries(MODES).map(([k, m]) => ({ k, label: m.label }));
  $("modePicker").innerHTML = pickerHtml("mode", modes, modes.find((m) => m.k === state.mode));
  const sizes = SIZES.map((z) => ({ k: String(z.n), label: z.label, sub: z.sub }));
  const cur = sizeOf(state.headcount);
  $("sizePicker").innerHTML = pickerHtml("size", sizes, { k: String(cur.n), label: cur.label });
  const days = [{ k: "today", label: "오늘" }, ...["월", "화", "수", "목", "금", "토", "일"].map((d) => ({ k: d, label: d }))];
  const dk = state.day || "today";
  $("dayPicker").innerHTML = pickerHtml("day", days, { k: dk, label: state.day ? `${state.day}요일` : `오늘(${todayKST()})` });
  $("modePicker").classList.toggle("open", openPicker === "mode");
  $("sizePicker").classList.toggle("open", openPicker === "size");
  $("dayPicker").classList.toggle("open", openPicker === "day");
  $("quick").classList.toggle("has-open", !!openPicker);
}
function onPicker(id, e) {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.dataset.toggle !== undefined) {
    openPicker = openPicker === id ? null : id;
    return renderTabs();
  }
  const k = b.dataset.k;
  openPicker = null;
  if (id === "mode") {
    if (k === state.mode) return renderTabs();
    if (state.origin?.kind === "store") clearOrigin();
    setMode(k);
  } else if (id === "day") {
    const d = k === "today" ? null : k;
    if (d === state.day) return renderTabs();
    state.day = d;
    renderTabs();
  } else {
    if (Number(k) === state.headcount) return renderTabs();
    state.headcount = Number(k);
    renderTabs();
  }
  run();
}
$("modePicker").addEventListener("click", (e) => onPicker("mode", e));
$("sizePicker").addEventListener("click", (e) => onPicker("size", e));
$("dayPicker").addEventListener("click", (e) => onPicker("day", e));
// 바깥 클릭이면 접기 — 버튼을 다시 그리면 e.target 이 떨어져 나가므로 이벤트 경로로 판정
document.addEventListener("click", (e) => {
  if (openPicker && !e.composedPath().some((el) => el.classList?.contains("picker"))) (openPicker = null), renderTabs();
});
function setMode(k) {
  state.mode = k;
  state.categories = new Set(MODES[k].categories);
  renderTabs();
  renderFilterCount();
}

// ---------- 필터 시트 ----------
let pending = null;
// 업종 버튼 (두 번째 줄 맨 앞): 선택된 업종 요약. 모드 기본값과 다르면 주황.
function renderFilterCount() {
  const sel = ALL_CATEGORIES.filter((c) => state.categories.has(c));
  const labels = [...new Set(sel.map(catLabel))];
  const text = !labels.length ? "업종 선택" : labels.length === 1 ? labels[0] : `${labels[0]} 외 ${labels.length - 1}`;
  const def = MODES[state.mode].categories;
  const custom = sel.length !== def.length || sel.some((c) => !def.includes(c));
  $("filterBtn").classList.toggle("custom", custom);
  $("filterBtn").innerHTML = `${svg("sliders", 15)}<span>${esc(text)}</span>${svg("down", 13)}`;
}
function renderCatGrid() {
  $("catGrid").innerHTML = ALL_CATEGORIES.map(
    (c) => `<button type="button" class="cat-tile" data-cat="${esc(c)}" aria-pressed="${pending.cats.has(c)}">
      ${svg(catIcon(c), 22)}<span>${esc(catLabel(c))}</span></button>`
  ).join("");


}
$("filterBtn").addEventListener("click", () => {
  pending = { cats: new Set(state.categories), ages: new Set(state.teamAges), gender: state.teamGender };
  renderCatGrid();
  renderAges();
  $("filterDialog").showModal();
});
$("catGrid").addEventListener("click", (e) => {
  const c = e.target.closest("[data-cat]")?.dataset.cat;
  if (!c) return;
  pending.cats.has(c) ? pending.cats.delete(c) : pending.cats.add(c);
  renderCatGrid();
});

// 우선 보기 (메인 화면): 누르면 현재 목록만 다시 정렬 — 재검색·API 호출 없음
function renderPrefs() {
  $("prefRow").innerHTML = PREFS.map(
    (p) => `<button type="button" class="pref" data-pref="${p.k}" aria-label="${p.label}" aria-pressed="${state.prefs.has(p.k)}">${svg(p.icon, 15)}<span class="pl">${p.label}</span></button>`
  ).join("");
}
$("prefRow").addEventListener("click", (e) => {
  const k = e.target.closest("[data-pref]")?.dataset.pref;
  if (!k) return;
  state.prefs.has(k) ? state.prefs.delete(k) : state.prefs.add(k);
  renderPrefs();
  resort();
});
// 룸·주차·콜키지 필터: '있어요'로 확인된 매장만 (여러 개면 모두 만족). 미확인 매장은 확인을 시작하고 오는 대로 반영.
function applyPrefs() {
  const on = [...state.prefs];
  state.stores = on.length ? state.all.filter((s) => (s.amen || s.photo) && on.every((k) => PREF_OK[k](amenOf(s)))) : state.all;
  if (state.activeId && !state.stores.some((s) => s.id === state.activeId)) closePreview(false);
}
// 정밀 확인 범위: 검색 결과 전체(최대 60곳). 매출 순위 순으로 6곳씩 — 매장당 3회, 1일 캐시
const AMEN_SCOPE = CONFIG.maxPins;
const amenOf = (s) => s.amen || s.photo?.amenities || {};
function prefsPending() {
  return state.prefs.size ? state.all.slice(0, AMEN_SCOPE).filter((s) => !s.amen && !s.amenDone).length : 0;
}
async function loadAmenities(s) {
  if (!s || s.amen || s.amenLoading) return;
  s.amenLoading = true;
  const a = await storeAmenities(s);
  s.amenLoading = false;
  s.amenDone = true;
  if (a) s.amen = a;
  refreshStore(s);
}
function resort() {
  if (state.prefs.size) state.all.slice(0, AMEN_SCOPE).forEach(loadAmenities);
  applyPrefs();
  $("results").scrollTop = 0;
  renderResults();
  renderMarkers();
  if (state.preview) openPreview();
}
let reapplyT = 0;
function scheduleReapply() {
  clearTimeout(reapplyT);
  reapplyT = setTimeout(() => {
    const before = state.stores.map((s) => s.id).join();
    applyPrefs();
    if (state.stores.map((s) => s.id).join() !== before || !prefsPending()) {
      renderResults();
      renderMarkers();
      if (state.preview) openPreview();
    }
  }, 350);
}
$("filterReset").addEventListener("click", () => {
  pending = { cats: new Set(MODES[state.mode].categories), ages: new Set(), gender: null };
  renderAges();
  renderCatGrid();
});
$("filterApply").addEventListener("click", () => {
  if (!pending.cats.size) return toast("업종을 선택하세요");
  state.categories = pending.cats;
  state.teamAges = pending.ages;
  state.teamGender = pending.gender;
  $("filterDialog").close();
  renderFilterCount();
  run();
});

// 모든 다이얼로그: [data-close] 버튼, 바깥(배경) 클릭으로 닫기
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d || e.target.closest("[data-close]")) d.id === "detail" ? closeDetail() : d.close();
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
let searching = false;
async function run() {
  const my = ++seq;
  searching = true;
  $("areaBtn").hidden = true;
  if (state.shared) {
    state.shared = false;
    history.replaceState(null, "", location.pathname);
  }
  closePreview(false);
  const mode = MODES[state.mode];
  if (!$("loc").value.trim()) $("loc").value = CONFIG.defaultLocation;
  const locations = state.origin?.queries || [state.origin?.query || $("loc").value.trim()];
  const categories = [...state.categories];
  $("resultCount").textContent = "검색 중…";
  try {
    if (!categories.length) throw new Error("업종을 선택하세요");
    const lists = await Promise.all(locations.map((location) => search({ keyword: mode.keyword, location, categories })));
    const seen = new Set();
    const raw = lists.flat().filter((s) => !seen.has(s.id) && seen.add(s.id));
    if (my !== seq) return;
    const all = applyMode(state.mode, raw, { headcount: state.headcount, groupThreshold: CONFIG.groupThreshold });
    const near = state.origin?.kind === "area" ? inArea(all, state.origin) : state.origin ? nearby(all, state.origin) : all;
    const ranked = rankStores(near);
    state.total = ranked.length;
    state.all = ranked.slice(0, CONFIG.maxPins);
    state.all.forEach((s, i) => (s.order = i));
    state.stores = state.all;
    if (status.fellBack) toast("실데이터 연결 실패 · 모의 데이터");
  } catch (err) {
    if (my !== seq) return;
    console.error(err);
    state.all = [];
    state.stores = [];
    state.total = 0;
    toast(err.message || "불러오기 실패");
  }
  state.activeId = null;
  $("results").scrollTop = 0;
  renderMarkers();
  if (state.origin?.kind === "area") markSearched();
  else if (state.stores.length) fitAll();
  else moveToQuery(my); // 결과가 없어도 검색한 곳으로 지도 이동
  setTimeout(() => (searching = false), 1300);
  if (sheet.snap === "peek") sheet.set("half");
  await photosFirst(my);
}

// 사진 있는 매장을 먼저: 상위 PHOTO_N 곳의 사진을 최대 PHOTO_WAIT ms 동안 확인한 뒤 한 번만 정렬.
// 같은 그룹 안에서는 매출 순위 유지. 늦게 온 사진은 순서를 바꾸지 않고 썸네일만 채운다.
const PHOTO_N = 24;
const PHOTO_WAIT = 3000;
async function photosFirst(my) {
  const head = state.all.slice(0, PHOTO_N);
  head.forEach((s) => s.photo === undefined && (s.photoLoading = true));
  applyPrefs();
  renderResults(); // 스켈레톤
  const all = Promise.all(head.map(loadPhotos));
  await Promise.race([all, new Promise((r) => setTimeout(r, PHOTO_WAIT))]);
  if (my !== seq) return;
  const has = (s) => !!(s.photo?.pin || s.photo?.images?.length);
  const pref = (s) => [...state.prefs].filter((k) => PREF_OK[k](amenOf(s))).length;
  const sorted = [...head].sort((a, b) => pref(b) - pref(a) || has(b) - has(a) || a.order - b.order);
  state.all = [...sorted, ...state.all.slice(PHOTO_N)];
  if (state.prefs.size) state.all.slice(0, AMEN_SCOPE).forEach(loadAmenities);
  applyPrefs();
  head.forEach((s) => s.photo === undefined || delete s.photoLoading);
  renderResults();
  renderMarkers();
}

// ---------- 추천 ----------
const recCtx = (s) => ({
  mode: state.mode,
  headcount: state.headcount,
  day: state.day || todayKST(),
  teamAges: state.teamAges,
  teamGender: state.teamGender,
  amenity: amenityStates(amenOf(s)),
  hasPhoto: !!(s.photo?.pin || s.photo?.images?.length),
  partner: [], // 제휴 데이터(오늘 현황·시간대 분포·방문 후 이동)를 받으면 여기에 특징으로 추가
});
const computeRec = (s) => (s.rec = recommend(s, recCtx(s)));
function rankStores(list) {
  list.forEach(computeRec);
  const ok = list.filter((s) => !s.rec.blocked);
  state.excluded = list.length - ok.length;
  return ok.sort((a, b) => b.rec.score - a.rec.score || a.rank - b.rank || a.id.localeCompare(b.id));
}
// 룸·주차·콜키지는 아이콘·상세 줄로 따로 보이므로 이유 문구에서는 뺀다 (점수에는 반영)
const AMENITY_REASON = /^(룸 있어요|룸 없어요|주차 가능|콜키지 가능)$/;
const recNoAmen = (rec) => rec && { ...rec, reasons: rec.reasons.filter((r) => !AMENITY_REASON.test(r.t)) };
// 현재 결과에서 이유별 비율 (흔한 이유는 목록에서 뒤로)
let reasonShare = new Map();
function updateReasonShare() {
  const cnt = new Map();
  for (const s of state.stores) for (const r of s.rec?.reasons || []) cnt.set(r.t, (cnt.get(r.t) || 0) + 1);
  const n = Math.max(1, state.stores.length);
  reasonShare = new Map([...cnt].map(([t, c]) => [t, c / n]));
}
// 추천 이유 배지: 계열별 아이콘·색 (손님 = 연주황 / 시간 = 연파랑 / 장소·평판 = 연노랑 / 주의 = 회색)
const REASON_STYLE = [
  [/회식 적합/, "users", "key"],
  [/단골|손님|또래/, "user", "people"],
  [/붐빔|붐비는/, "clock", "time"],
  [/늦게까지|새벽까지/, "moon", "time"],
  [/연중무휴/, "calendar", "time"],
  [/전국 상위/, "trend", "place"],
  [/동네 맛집/, "pin", "place"],
  [/도보|멀어요/, "walk", "place"],
];
const reasonStyle = (t) => (REASON_STYLE.find(([re]) => re.test(t)) || [0, "check", "people"]).slice(1);
const reasonBadge = (r, warn = false) => {
  const [ic, kind] = reasonStyle(r.t);
  return `<span class="rb ${warn ? "warn" : kind}">${svg(ic, 12)}${esc(r.t)}</span>`;
};
function whyHtml(s) {
  const { good, warn } = topReasons(recNoAmen(s.rec), 3, (t) => reasonShare.get(t) || 0);
  if (!good.length && !warn) return "";
  return `<div class="why">${good.map((r) => reasonBadge(r)).join("")}${warn ? reasonBadge(warn, true) : ""}</div>`;
}

// 팀 연령대 (필터 시트)
const AGES = ["20대", "30대", "40대", "50대"];
const GENDERS = [["male", "남성"], ["female", "여성"], ["mixed", "남녀 함께"]];
function renderAges() {
  $("ageRow").innerHTML = AGES.map((a) => `<button type="button" class="pref" data-age="${a}" aria-pressed="${pending.ages.has(a)}">${a}${a === "50대" ? "+" : ""}</button>`).join("");
  $("genderRow").innerHTML = GENDERS.map(([k, l]) => `<button type="button" class="pref" data-gender="${k}" aria-pressed="${pending.gender === k}">${l}</button>`).join("");
}
$("genderRow").addEventListener("click", (e) => {
  const k = e.target.closest("[data-gender]")?.dataset.gender;
  if (!k) return;
  pending.gender = pending.gender === k ? null : k; // 다시 누르면 해제
  renderAges();
});
$("ageRow").addEventListener("click", (e) => {
  const a = e.target.closest("[data-age]")?.dataset.age;
  if (!a) return;
  pending.ages.has(a) ? pending.ages.delete(a) : pending.ages.add(a);
  renderAges();
});

// ---------- 목록 ----------
function rowHtml(s) {
  const dist = s.dist != null ? `<span class="dist">${state.origin?.kind === "store" ? fmtWalk(s.dist) : fmtDist(s.dist)}</span> · ` : "";
  return `
  <li class="row${s.id === state.activeId ? " active" : ""}" data-id="${esc(s.id)}">
    <div class="thumb">${thumbHtml(s)}</div>
    <div class="info">
      <div class="name">${esc(s.name)}</div>
      <div class="meta">${dist}${tierHtml(s.rank)}${rankTier(s.rank) ? " " : ""}${esc(catLabel(s.category))} · ${esc(area(s))}</div>
      <div class="meta">${esc(hours(s))} · ${esc(holiday(s))}</div>
      ${whyHtml(s)}${amenityBadges(s)}
    </div>
    ${addBtn(s, "add")}
  </li>`;
}
const tagsHtml = (s) => {
  const t = [s.group ? "<em>회식 적합</em>" : "", s.local ? "<span>동네 맛집</span>" : ""].filter(Boolean);
  return t.length ? `<div class="tags">${t.join("")}</div>` : "";
};
// 룸·주차·콜키지 아이콘 배지 (미리보기): '있어요'인 것만. 없음·미확인은 표시하지 않는다 (상세에서만 구분)
const AM_ICON = { room: ["door", "룸"], park: ["parking", "주차"], cork: ["wine", "콜키지"] };
function amenityBadges(s, size = 14, labels = true) {
  const st = amenityStates(amenOf(s));
  const on = Object.entries(AM_ICON).filter(([k]) => st[k] === "yes");
  if (!on.length) return "";
  return `<div class="am-badges">${on
    .map(([k, [ic, label]]) => `<span class="am-b on" title="${AMENITY_TEXT[k].yes}">${svg(ic, size)}${labels ? label : ""}</span>`)
    .join("")}</div>`;
}

// 인원 프리셋 (대표 인원 = 필터 계산용, 10명 이상이면 회식 적합만)
const SIZES = [
  { n: 1, label: "혼밥", sub: "1명" },
  { n: 2, label: "둘이서", sub: "2명" },
  { n: 4, label: "소모임", sub: "3~4명" },
  { n: 8, label: "팀 회식", sub: "5~9명" },
  { n: 12, label: "대규모", sub: "10명+" },
];
const sizeOf = (hc) => [...SIZES].reverse().find((z) => hc >= z.n) || SIZES[0];
const PREFS = [
  { k: "room", label: "룸", icon: "door" },
  { k: "park", label: "주차", icon: "parking" },
  { k: "cork", label: "콜키지", icon: "wine" },
];
// 필터 판정 = 상세 화면 표기와 같은 함수 (amenityStates)
const PREF_OK = {
  room: (a) => amenityStates(a).room === "yes",
  park: (a) => amenityStates(a).park === "yes",
  cork: (a) => amenityStates(a).cork === "yes",
};

// 상세 화면 편의 정보: 있어요 / 없어요 / 미확인 (+ 금액이 있으면 작게)
function amenityRows(s) {
  if (!s.amen && !s.amenDone) return `<li class="am-loading">${svg("door", 20)}<div><b>룸·주차·콜키지 확인 중…</b></div></li>`;
  const st = amenityStates(amenOf(s));
  const row = (k, note) =>
    `<li class="am-row ${st[k]}">${svg(AM_ICON[k][0], 20)}<div><b>${AMENITY_TEXT[k][st[k]]}</b>${note ? `<span>${esc(note)}</span>` : ""}</div></li>`;
  return row("room", st.roomNote) + row("park", st.parkNote) + row("cork", st.corkNote);
}
function addBtn(s, cls) {
  const on = inCand(s.id);
  const full = state.candidates.length >= CONFIG.maxCandidates;
  return `<button type="button" class="${cls}${on ? " on" : ""}" data-add="${esc(s.id)}" aria-label="${on ? "후보에서 빼기" : "후보에 담기"}" ${!on && full ? "disabled" : ""}>${svg(on ? "check" : "plus", 20)}</button>`;
}

function renderResults() {
  updateReasonShare();
  const o = state.origin;
  const where = state.shared
    ? "공유받은 후보"
    : !o
      ? MODES[state.mode].label
      : o.kind === "store"
        ? `${o.name} 근처 ${fmtDist(state.radius)}`
        : o.kind === "area"
          ? `${o.name} 일대`
          : `${o.kind === "place" ? o.name : o.dong || "내 주변"} ${fmtDist(state.radius)}`;
  const on = PREFS.filter((p) => state.prefs.has(p.k)).map((p) => p.label);
  const pend = prefsPending();
  const n = on.length
    ? `${state.stores.length}곳`
    : state.total > state.stores.length ? `${state.total}곳(상위 ${state.stores.length})` : `${state.stores.length}곳`;
  $("resultCount").textContent = `${n} · ${where}${on.length ? ` · ${on.join("·")}` : ""}${pend ? ` · 확인 중 ${pend}` : ""}`;
  $("headSub").textContent = state.excluded && !state.shared ? `${state.day ? state.day + "요일" : "오늘"} 휴무·영업 외 ${state.excluded}곳 제외 · 최근 1개월 결제 기준` : "최근 1개월 결제 기준";
  renderStatus();
  $("results").innerHTML = state.stores.length
    ? state.stores.map(rowHtml).join("")
    : `<li class="empty">${state.prefs.size ? (prefsPending() ? "확인 중…" : "조건에 맞는 매장이 없어요") : "결과 없음"}</li>`;
}
function refreshStore(s) {
  if (s.rec) computeRec(s);
  if (state.prefs.size) scheduleReapply();
  // 사진 로드·후보 변경 후 해당 매장이 보이는 곳만 다시 그린다
  const i = state.stores.indexOf(s);
  if (i >= 0 && markers.has(s.id)) markers.get(s.id).setIcon(L.divIcon({ className: "", html: storeMarkerHtml(s, i, (markers.get(s.id)._members || 1) - 1), iconSize: null, iconAnchor: [0, 0] }));
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
        <div class="pv-sub">${tierHtml(s.rank)}<span>${esc(catLabel(s.category))}</span><span>${esc(area(s))}</span>${dist}</div>
        <div class="pv-meta">${svg("clock", 14)} ${esc(hours(s))} · ${esc(holiday(s))}</div>
        ${whyHtml(s)}${amenityBadges(s)}
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
  if (e.target.closest("a[data-eatpl]")) e.preventDefault();
  const t = e.target.closest("[data-eatpl],[data-add],[data-share-one],[data-next],[data-detail],[data-add-second],[data-rm],[data-tone]");
  if (!t) return;
  const d = t.dataset;
  if (d.eatpl) return openEatpl(storeById(d.eatpl));
  if (d.add) return toggleCandidate(d.add);
  if (d.addSecond) return toggleCandidate(d.addSecond, "2차");
  if (d.rm) return toggleCandidate(d.rm);
  if (d.shareOne) return shareStore(storeById(d.shareOne));
  if (d.next) return findSecondStop(storeById(d.next));
  if (d.detail) return openDetail(storeById(d.detail), t.closest(".pv-card") || t);
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
// 카드 → 전체 화면으로 펼치기 (clip-path FLIP). 닫을 때는 원래 카드 자리로 접는다.
const REDUCE = window.matchMedia("(prefers-reduced-motion: reduce)");
const EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
let detailSrc = null;
function insetFrom(el, box) {
  const r = el.getBoundingClientRect();
  if (!r.width || r.bottom < 0 || r.top > innerHeight) return null; // 화면 밖이면 사용 안 함
  const v = [r.top - box.top, box.right - r.right, box.bottom - r.bottom, r.left - box.left].map((x) => `${Math.max(0, x)}px`);
  return `inset(${v.join(" ")} round 20px)`;
}
function openDetail(s, srcEl) {
  if (!s) return;
  detailStore = s;
  detailSrc = srcEl || null;
  renderDetail(s);
  const d = $("detail");
  d.showModal();
  d.scrollTop = 0;
  if (!REDUCE.matches) {
    const from = srcEl && insetFrom(srcEl, d.getBoundingClientRect());
    if (from) {
      d.animate([{ clipPath: from, opacity: 0.6 }, { clipPath: "inset(0px 0px 0px 0px round 0px)", opacity: 1 }], { duration: 440, easing: EASE });
      d.querySelector(".dt-hero")?.animate([{ transform: "scale(1.06)", filter: "brightness(0.92)" }, { transform: "none", filter: "none" }], { duration: 520, easing: EASE });
    } else {
      d.animate([{ transform: "translateY(48px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: EASE });
    }
    d.querySelector(".dt-body")?.animate([{ transform: "translateY(28px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 420, delay: 140, easing: EASE, fill: "backwards" });
    d.querySelector(".dt-bar")?.animate([{ transform: "translateY(100%)" }, { transform: "none" }], { duration: 360, delay: 200, easing: EASE, fill: "backwards" });
  }
  // 열린 뒤 크기 확정 → 미니 지도 재계산
  requestAnimationFrame(() => detailMap?.invalidateSize().setView([s.lat, s.lng], 16));
  loadPhotos(s);
  loadAmenities(s);
  resolveKakao(s);
}
function renderDetail(s, keepScroll = false) {
  const imgs = s.photo?.images || [];
  const on = inCand(s.id);
  // 썸네일 최대 320px → 화면 폭 전체로 늘리지 않고 정사각 갤러리로 (흐림 방지)
  const hero = imgs.length
    ? `<div class="dt-gallery${imgs.length === 1 ? " one" : ""}" id="dtTrack">${imgs
        .map((im) => `<a href="${esc(im.source)}" target="_blank" rel="noopener nofollow"><img src="${esc(hi(im.thumb))}" alt="" referrerpolicy="no-referrer" onerror="this.parentElement.remove()" /></a>`)
        .join("")}</div>`
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
      <div class="dt-sub">${tierHtml(s.rank, "구내 ")}${tierHtml(s.rankAll, "전국 ")}<span>${esc(catLabel(s.category))}</span></div>
      ${tagsHtml(s)}
      ${recDetail(s)}
      <ul class="dt-rows">
        <li>${svg("clock", 20)}<div><b>${esc(hours(s))}</b><span>${esc(holiday(s))} · 최근 1개월 결제 기준</span></div></li>
        ${amenityRows(s)}
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

  detailMap?.remove();
  detailMap = L.map("dtMap", { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, boxZoom: false, keyboard: false }).setView([s.lat, s.lng], 16);
  detailMap.attributionControl.setPrefix(false);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(detailMap);
  L.marker([s.lat, s.lng], { icon: L.divIcon({ className: "", html: `<div class="mk"><div class="mk-pin hot"><span class="mk-in">${svg(catIcon(s.category), 18)}</span></div></div>`, iconSize: null, iconAnchor: [0, 0] }) }).addTo(detailMap);
}
let closing = false;
async function closeDetail() {
  const d = $("detail");
  if (!d.open || closing) return;
  closing = true;
  if (!REDUCE.matches) {
    const to = detailSrc?.isConnected && insetFrom(detailSrc, d.getBoundingClientRect());
    const anim = to
      ? d.animate([{ clipPath: `inset(${d.scrollTop ? 0 : 0}px 0px 0px 0px round 0px)`, opacity: 1 }, { clipPath: to, opacity: 0.4 }], { duration: 360, easing: EASE })
      : d.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(60px)", opacity: 0 }], { duration: 240, easing: "ease-in" });
    await anim.finished.catch(() => {});
  }
  d.close();
  closing = false;
}
// Esc / 안드로이드 뒤로(취소)도 애니메이션 닫기
$("detail").addEventListener("cancel", (e) => {
  e.preventDefault();
  closeDetail();
});
$("detail").addEventListener("close", () => {
  detailMap?.remove();
  detailMap = null;
  detailStore = null;
});

function recDetail(s) {
  const r = recNoAmen(s.rec);
  if (!r || r.blocked || !r.reasons.length) return "";
  return `<div class="rec-box"><b>추천 이유</b><ul>${r.reasons
    .map((x) => `<li class="${x.w > 0 ? "pos " + reasonStyle(x.t)[1] : "neg"}">${svg(reasonStyle(x.t)[0], 15)}${esc(x.t)}</li>`)
    .join("")}</ul></div>`;
}

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
      .map((s) => ((s.rec = recommend(s, { ...recCtx(s), mode: "after" })), s))
      .filter((s) => !s.rec.blocked)
      .sort((a, b) => b.rec.score - a.rec.score)
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
          <div class="meta">${tierHtml(s.rank)}${rankTier(s.rank) ? " " : ""}${esc(catLabel(s.category))} · ${esc(area(s))}</div>
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
              <span>${tierHtml(s.rank)} ${fmtWalk(s.dist)}</span>
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
  // 공유 창에는 본문 + "위치·상세 보기:" 뒤에 링크(url)를 따로 — 대부분의 앱이 본문 끝에 링크를 붙여준다
  $("shareBtn").onclick = () => {
    const text = buildMessage(state.candidates, { modeNoun: MODES[state.mode].noun, tone: state.tone, link: null });
    shareText("회식 장소 후보", `${text}\n\n위치·상세 보기:`, shareLink(state.candidates, state.mode));
  };
}

// 공유: Web Share API(안드로이드·iOS 공유 창). 링크는 url 로 따로 넘긴다(안드로이드가 본문 속 긴 링크보다 안정적).
// 없거나(카카오톡 등 인앱 브라우저) 실패하면 문구+링크 복사로 대신하고 이유를 알린다.
async function shareText(title, text, url) {
  const data = url ? { title, text, url } : { title, text };
  if (navigator.share) {
    if (!navigator.canShare || navigator.canShare(data)) {
      try {
        await navigator.share(data);
        return;
      } catch (e) {
        if (e.name === "AbortError") return; // 사용자가 닫음
        console.warn("share failed", e);
        await copyText(url ? `${text}\n${url}` : text);
        return toast(`공유 창을 열 수 없어 복사했어요 (${e.name})`);
      }
    }
  }
  await copyText(url ? `${text}\n${url}` : text);
  toast(isKakaoInApp() ? "복사됨 · 대화방에 붙여넣으세요" : "이 브라우저는 공유 창이 없어 복사했어요");
}
function shareStore(s) {
  if (!s) return;
  shareText(s.name, `${s.name} (${catLabel(s.category)} · ${area(s)})`, shareLink([s], state.mode));
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
// ---------- 이 지역에서 검색 ----------
// 사용자가 지도를 직접 옮기면 버튼 표시 → 보이는 영역(검색 바·시트 제외)의 가운데·네 모서리가 속한 구(최대 2개)를
// 검색하고, 그 영역 안의 매장만 남긴다. 지도는 움직이지 않는다.
let lastView = null; // 마지막 검색 시점의 보이는 중심·줌
function visibleBounds() {
  const c = cover();
  const nw = map.containerPointToLatLng([c.left, c.top]);
  const se = map.containerPointToLatLng([window.innerWidth, window.innerHeight - c.bottom]);
  return { n: nw.lat, w: nw.lng, s: se.lat, e: se.lng };
}
const centerOf = (b) => ({ lat: (b.n + b.s) / 2, lng: (b.w + b.e) / 2 });
function markSearched() {
  lastView = visibleBounds();
  $("areaBtn").hidden = true;
}
const MANY_VISIBLE = 5; // 화면에 결과가 이만큼 보이면 버튼을 띄우지 않는다
map.on("moveend", () => {
  if (performance.now() < autoUntil || searching) return markSearched();
  if (!lastView || state.shared) return;
  $("areaBtn").hidden = !leftSearchArea();
});
// '검색했던 영역을 실제로 벗어났나' — 휴대폰은 보이는 지도가 작아서 '화면의 몇 %' 기준이면 조금만 밀어도 뜬다
//  1) 보이는 중심이 마지막 검색 영역(10% 여유) 밖이거나, 축소해 보이는 범위가 검색 영역의 2.5배 초과
//  2) 지도 전체(가려진 곳 포함)에 결과가 5곳 미만
function leftSearchArea() {
  const v = visibleBounds();
  const L0 = lastView;
  const padLat = (L0.n - L0.s) * 0.1, padLng = (L0.e - L0.w) * 0.1;
  const c = centerOf(v);
  const centerOut = c.lat > L0.n + padLat || c.lat < L0.s - padLat || c.lng > L0.e + padLng || c.lng < L0.w - padLng;
  const zoomedOut = (v.n - v.s) * (v.e - v.w) > 2.5 * (L0.n - L0.s) * (L0.e - L0.w);
  if (!centerOut && !zoomedOut) return false;
  const m = map.getBounds();
  const inMap = state.stores.filter((s) => m.contains([s.lat, s.lng])).length;
  return inMap < MANY_VISIBLE;
}
function inArea(list, o) {
  state.radius = 0;
  for (const s of list) s.dist = meters(o, s);
  return list.filter((s) => s.lat <= o.b.n && s.lat >= o.b.s && s.lng >= o.b.w && s.lng <= o.b.e);
}
$("areaBtn").innerHTML = `${svg("search", 16)}<span>이 지역에서 검색</span>`;
$("areaBtn").addEventListener("click", async () => {
  const btn = $("areaBtn");
  btn.classList.add("busy");
  const b = visibleBounds();
  const c = centerOf(b);
  // 너무 넓으면 의미 없음 (잇플은 구 단위 상위 100건)
  if (meters({ lat: b.n, lng: b.w }, { lat: b.s, lng: b.e }) > 20000) {
    btn.classList.remove("busy");
    return toast("지도를 더 확대해 주세요");
  }
  try {
    const pts = [c, { lat: b.n, lng: b.w }, { lat: b.n, lng: b.e }, { lat: b.s, lng: b.w }, { lat: b.s, lng: b.e }];
    const regions = await Promise.all(pts.map((p) => regionOf(p.lat, p.lng).catch(() => null)));
    const center = regions[0] || regions.find(Boolean);
    if (!center) throw new Error("행정구역 조회 실패");
    // 가운데 구 + 모서리에서 가장 많이 걸친 다른 구 1개
    const others = regions.slice(1).filter((r) => r && r.query !== center.query).map((r) => r.query);
    const second = others.sort((x, y) => others.filter((v) => v === y).length - others.filter((v) => v === x).length)[0];
    clearOrigin();
    state.origin = { kind: "area", ...c, b, name: center.dong || center.query, queries: [center.query, second].filter(Boolean) };
    $("loc").value = `${state.origin.name} 일대`;
    await run();
  } catch (e) {
    toast(e.message || "검색 실패");
  } finally {
    btn.classList.remove("busy");
    markSearched();
  }
});

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
        auto(() => map.setView([o.lat, o.lng], 16));
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
  $("detail").open && $("detail").close(); // 화면 전환이라 즉시 닫음
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
renderPrefs();
renderFilterCount();
renderTray();
const shared = readShare();
if (shared) {
  state.shared = true;
  if (MODES[shared.mode]) state.mode = shared.mode;
  renderTabs();
  state.all = state.stores = shared.stores;
  state.stores.forEach(computeRec);
  state.stores.forEach((s, i) => (s.order = i));
  state.total = shared.stores.length;
  renderResults();
  renderMarkers();
  fitAll();
  state.stores.forEach(loadPhotos);
} else run();
