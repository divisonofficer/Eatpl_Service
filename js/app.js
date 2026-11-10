import { CONFIG } from "./config.js";
import { search, status, kakaoPlace, kakaoSearchUrl, storePhotos, regionOf } from "./api.js";
import { MODES, ALL_CATEGORIES, applyMode } from "./modes.js";
import { hours, holiday, rankLabel, area, icon, catLabel, buildMessage } from "./format.js";
import { createSheet } from "./sheet.js";
import { shareLink, readShare, isKakaoInApp, kakaoExternalUrl } from "./share.js";
import { attachSuggest } from "./suggest.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = {
  mode: "dinner",
  categories: new Set(MODES.dinner.categories),
  stores: [],
  total: 0,
  candidates: [],
  activeId: null,
  shared: false, // 공유 링크로 들어온 후보 보기 모드
  origin: null, // 현위치 검색 { lat, lng, acc, query, dong }
  radius: 0, // 현위치 검색 시 실제 적용된 반경(m)
};

// ---------- 지도 ----------
const map = L.map("map", { zoomControl: false, attributionControl: true }).setView([37.57, 126.99], 14);
L.control.zoom({ position: "bottomright" }).addTo(map);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "eat.pl 잇플 · BC카드 결제 데이터 기반 | © OpenStreetMap",
}).addTo(map);
const layer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map); // 내 위치 (검색 결과와 별도)
const markers = new Map();

// 상위 매장·선택 매장이 위로 (Leaflet 기본은 위도순)
const zOf = (s) => (s.id === state.activeId ? 100000 : Math.max(0, 5000 - state.stores.indexOf(s) * 50));
const LABELED = 8; // 상위 N곳만 라벨 핀, 나머지는 점 (겹침 완화)
function pinIcon(s, active) {
  if (!active && state.stores.indexOf(s) >= LABELED) {
    return L.divIcon({ className: "", html: `<div class="dot-pin ${s.group ? "pin-group" : "pin-normal"}"></div>`, iconSize: null, iconAnchor: [0, 0] });
  }
  const photo = s.photo?.pin?.thumb;
  const tone = s.group ? "pin-group" : "pin-normal";
  const cls = `pin ${tone}${active ? " pin-active" : ""}${photo ? " pin-photo" : ""}`;
  const body = photo
    ? `<img src="${esc(photo)}" alt="" referrerpolicy="no-referrer" /><span class="pin-name">${esc(s.name)}</span><span class="pin-rk">${esc(s.rank)}%</span>`
    : `<span class="pin-name">${esc(s.name)}</span>${esc(s.rank)}%`;
  return L.divIcon({
    className: "",
    html: `<div class="pinwrap ${tone}"><i class="leader"></i><i class="anchor"></i><div class="${cls}">${body}</div></div>`,
    iconSize: null,
    iconAnchor: [0, 0],
  });
}

// ---------- 핀 겹침 정리 (결정론) ----------
// 우선순위(선택 > 매출 순위) 순으로 버블 자리를 잡는다. 겹치면 주변 후보 위치로 옮기고
// 실제 위치엔 점 + 연결선을 남긴다. 2바퀴 안에 자리가 없으면 점으로 접는다.
// zoomend/moveend 마다 다시 계산 → CSS transition 으로 버블이 미끄러지듯 이동.
const TAIL = 6;
function candidates(w, h) {
  const out = [[0, 0]];
  for (const k of [1, 2]) {
    const sx = (w / 2 + 10) * k, up = (h + 8) * k, side = h / 2 + TAIL;
    out.push(
      [sx, side], [-sx, side], // 오른쪽·왼쪽 (버블 세로 중앙 = 앵커)
      [w * 0.55 * k, -up * 0.7], [-w * 0.55 * k, -up * 0.7], // 위 대각
      [0, -up], // 더 위
      [0, h + TAIL * 2 + 4 + (k - 1) * up], // 아래
      [w * 0.55 * k, h + 10], [-w * 0.55 * k, h + 10] // 아래 대각
    );
  }
  return out;
}
const overlap = (a, b) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

function declutter() {
  const items = [];
  for (const s of state.stores) {
    const el = markers.get(s.id)?.getElement()?.querySelector(".pinwrap");
    if (el) items.push({ s, el, bubble: el.querySelector(".pin"), p: map.latLngToContainerPoint([s.lat, s.lng]) });
  }
  // 다른 매장의 실제 위치(점 핀 포함)는 버블이 가리지 않도록 장애물로 등록
  const obstacles = [];
  for (const s of state.stores) {
    const p = map.latLngToContainerPoint([s.lat, s.lng]);
    obstacles.push({ id: s.id, x1: p.x - 5, x2: p.x + 5, y1: p.y - 5, y2: p.y + 5 });
  }
  // 상단 검색 바·바텀시트(데스크톱은 좌측 패널)에 가려지는 영역도 피한다
  const c = sheet.coverage(), W = window.innerWidth, H = window.innerHeight;
  if (c.top) obstacles.push({ id: "ui-top", x1: 0, x2: W, y1: -9999, y2: c.top });
  if (c.bottom) obstacles.push({ id: "ui-sheet", x1: 0, x2: W, y1: H - c.bottom, y2: 9999 });
  if (c.left) obstacles.push({ id: "ui-panel", x1: -9999, x2: c.left, y1: 0, y2: H });
  const meP = state.origin && map.latLngToContainerPoint([state.origin.lat, state.origin.lng]);
  if (meP) obstacles.push({ id: "me", x1: meP.x - 9, x2: meP.x + 9, y1: meP.y - 9, y2: meP.y + 9 });

  const rank = (it) => (it.s.id === state.activeId ? -1 : state.stores.indexOf(it.s));
  items.sort((a, b) => rank(a) - rank(b));
  const placed = [];
  for (const it of items) {
    const w = it.bubble.offsetWidth, h = it.bubble.offsetHeight;
    let pick = null;
    for (const [dx, dy] of candidates(w, h)) {
      const r = { x1: it.p.x - w / 2 + dx - 2, x2: it.p.x + w / 2 + dx + 2, y1: it.p.y - h - TAIL + dy - 2, y2: it.p.y - TAIL + dy + 2 };
      if (placed.some((q) => overlap(q, r)) || obstacles.some((o) => o.id !== it.s.id && overlap(o, r))) continue;
      pick = { dx, dy, r };
      break;
    }
    const forceShow = it.s.id === state.activeId; // 선택한 핀은 겹쳐도 항상 표시
    if (!pick && forceShow) pick = { dx: 0, dy: 0, r: null };
    it.el.classList.toggle("collapsed", !pick);
    if (!pick) continue;
    if (pick.r) placed.push(pick.r);
    const moved = Math.hypot(pick.dx, pick.dy) > 1;
    // 연결선: 실제 위치 → 버블 중심 (버블이 선 끝을 덮음)
    const cx = pick.dx, cy = pick.dy - TAIL - h / 2;
    it.el.classList.toggle("moved", moved);
    it.el.style.setProperty("--dx", `${pick.dx}px`);
    it.el.style.setProperty("--dy", `${pick.dy}px`);
    it.el.style.setProperty("--len", `${moved ? Math.hypot(cx, cy) : 0}px`);
    it.el.style.setProperty("--ang", `${Math.atan2(cy, cx)}rad`);
  }
}
let declutterRaf = 0;
const scheduleDeclutter = () => {
  cancelAnimationFrame(declutterRaf);
  declutterRaf = requestAnimationFrame(declutter);
};
map.on("zoomend moveend resize", scheduleDeclutter);

// 시트/패널에 가려지는 영역을 빼고 맞춘다
function fitPadding() {
  const c = sheet.coverage();
  return { paddingTopLeft: [c.left + 24, c.top + 24], paddingBottomRight: [24, c.bottom + 24] };
}
function focusStore(s) {
  const c = sheet.coverage();
  const z = Math.max(map.getZoom(), 16);
  // 가려지지 않은 영역의 중심에 오도록 지도 중심을 보정
  const visCx = (c.left + window.innerWidth) / 2;
  const visCy = (c.top + (window.innerHeight - c.bottom)) / 2;
  const off = L.point(window.innerWidth / 2 - visCx, window.innerHeight / 2 - visCy);
  const target = map.unproject(map.project([s.lat, s.lng], z).add(off), z);
  map.flyTo(target, z, { duration: 0.5 });
}

function renderMap(fit = true) {
  layer.clearLayers();
  markers.clear();
  state.stores.forEach((s) => {
    const m = L.marker([s.lat, s.lng], { icon: pinIcon(s, s.id === state.activeId), title: s.name, riseOnHover: true, zIndexOffset: zOf(s) })
      .on("click", () => select(s.id, "map"))
      .addTo(layer);
    markers.set(s.id, m);
  });
  loadTopPhotos();
  scheduleDeclutter();
  if (fit && state.stores.length) {
    const pts = state.stores.map((s) => [s.lat, s.lng]);
    if (state.origin) pts.push([state.origin.lat, state.origin.lng]);
    map.fitBounds(L.latLngBounds(pts), { ...fitPadding(), maxZoom: 16 });
  }
}
map.on("click", () => state.activeId && select(null, "map"));

// ---------- 바텀시트 ----------
const sheet = createSheet({
  sheet: $("sheet"),
  head: $("sheetHead"),
  top: $("top"),
  onChange: () => {
    map.invalidateSize({ pan: false });
    scheduleDeclutter();
  },
});

// ---------- 조건 바 ----------
function renderTabs() {
  $("modeTabs").innerHTML = Object.entries(MODES)
    .map(([k, m]) => `<button type="button" role="tab" data-mode="${k}" aria-selected="${k === state.mode}">${m.label}</button>`)
    .join("");
}
function renderChips() {
  const ordered = [...ALL_CATEGORIES.filter((c) => state.categories.has(c)), ...ALL_CATEGORIES.filter((c) => !state.categories.has(c))];
  $("chips").innerHTML = ordered.map(
    (c) => `<button type="button" class="chip" data-cat="${esc(c)}" aria-pressed="${state.categories.has(c)}">${esc(catLabel(c))}</button>`
  ).join("");
}

$("modeTabs").addEventListener("click", (e) => {
  const k = e.target.closest("[data-mode]")?.dataset.mode;
  if (!k || k === state.mode) return;
  if (state.origin?.kind === "store") clearOrigin();
  state.mode = k;
  state.categories = new Set(MODES[k].categories);
  renderTabs();
  renderChips();
  run();
});
$("chipsMore").addEventListener("click", () => {
  const open = $("chipsRow").classList.toggle("expanded");
  $("chipsMore").textContent = open ? "접기" : "더보기";
  $("chipsMore").setAttribute("aria-expanded", String(open));
  if (!open) $("chips").scrollLeft = 0;
});
$("chips").addEventListener("click", (e) => {
  const c = e.target.closest("[data-cat]")?.dataset.cat;
  if (!c) return;
  state.categories.has(c) ? state.categories.delete(c) : state.categories.add(c);
  renderChips();
  clearTimeout(run._t);
  run._t = setTimeout(run, 400); // 칩 연타 시 호출 묶기 (프록시 60회/분 제한)
});
$("loc").addEventListener("input", () => clearOrigin());
$("filters").addEventListener("submit", (e) => {
  e.preventDefault();
  $("loc").blur();
  run();
});
$("headcount").addEventListener("change", run);

// ---------- 검색 ----------
let seq = 0;
async function run() {
  const my = ++seq;
  if (state.shared) {
    state.shared = false;
    history.replaceState(null, "", location.pathname);
  }
  const mode = MODES[state.mode];
  if (!$("loc").value.trim()) $("loc").value = CONFIG.defaultLocation;
  const location = state.origin?.query || $("loc").value.trim();
  const categories = [...state.categories];
  $("resultCount").textContent = "검색 중…";
  try {
    if (!categories.length) throw new Error("업종을 선택하세요");
    const raw = await search({ keyword: mode.keyword, location, categories });
    if (my !== seq) return; // 늦게 도착한 이전 검색 결과 무시
    const all = applyMode(state.mode, raw, { headcount: Number($("headcount").value), groupThreshold: CONFIG.groupThreshold });
    const near = state.origin ? nearby(all, state.origin) : all;
    state.total = near.length;
    state.stores = near.slice(0, CONFIG.maxPins);
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
  renderResults();
  renderMap();
  if (sheet.snap === "peek") sheet.set("half");
}

// ---------- 결과 카드 ----------
function card(s) {
  const inCand = state.candidates.some((c) => c.id === s.id);
  const full = state.candidates.length >= CONFIG.maxCandidates;
  const open = s.id === state.activeId;
  return `
  <li class="card${open ? " open" : ""}" data-id="${esc(s.id)}">
    <div class="thumb${s.group ? " group" : ""}" aria-hidden="true">${
      s.photo?.pin ? `<img src="${esc(s.photo.pin.thumb)}" alt="" referrerpolicy="no-referrer" />` : icon(s)
    }</div>
    <div class="info">
      <div class="name">${esc(s.name)}</div>
      <div class="meta">${s.dist != null ? `<span class="dist">${state.origin?.kind === "store" ? fmtWalk(s.dist) : fmtDist(s.dist)}</span> · ` : ""}<span class="rank">${esc(rankLabel(s))}</span> · ${esc(catLabel(s.category))} · ${esc(area(s))}</div>
      <div class="meta">${esc(hours(s))} · ${esc(holiday(s))}</div>
      <div class="tags">${s.group ? "<em>회식 적합</em>" : ""}${s.local ? "<span>동네 맛집</span>" : ""}${
        s.busyTime ? `<span>${esc(s.busyDay)} ${esc(s.busyTime)} 붐빔</span>` : ""
      }</div>
      <button type="button" class="go-eatpl" data-eatpl="${esc(s.id)}">잇플 상세 보기 ›</button>
    </div>
    <button class="add${inCand ? " on" : ""}" data-add="${esc(s.id)}" aria-label="${inCand ? "후보에서 빼기" : "후보에 담기"}"
      ${!inCand && full ? "disabled" : ""}>${inCand ? "✓" : "+"}</button>
    <div class="detail">
      ${photosHtml(s)}
      <button type="button" class="cta" data-eatpl="${esc(s.id)}"><span>잇플에서 상세 보기</span></button>
      ${state.mode === "dinner" && !state.shared ? `<button type="button" class="next-stop" data-next="${esc(s.id)}">이 근처 2차 찾기</button>` : ""}
      <dl>
        <dt>주소</dt><dd>${esc(s.address)}</dd>
        <dt>영업</dt><dd>${esc(hours(s))} · ${esc(holiday(s))}</dd>
        <dt>랭킹</dt><dd>구내 ${esc(rankLabel(s))} · 전국 상위 ${esc(String(s.rankAll))}%</dd>
        ${s.customers.length ? `<dt>주 고객</dt><dd>${esc(s.customers.join(", "))}</dd>` : ""}
      </dl>
      <div class="sublinks">
        <a href="${esc(s.url)}" target="_blank" rel="noopener">잇플 새 창으로 열기 ↗</a>
        <a data-kakao="${esc(s.id)}" href="${esc(kakaoSearchUrl(s))}" target="_blank" rel="noopener">카카오맵 사진·리뷰</a>
      </div>
    </div>
  </li>`;
}

function renderResults() {
  // 개수를 앞에 둬서 말줄임돼도 보이게: "8곳 · 왕초바베큐 근처 300m"
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
  $("results").innerHTML =
    (state.stores.length
      ? state.stores.map(card).join("")
      : `<li class="empty">결과 없음</li>`);
  if (state.activeId) {
    const s = state.stores.find((v) => v.id === state.activeId);
    resolveKakao(s);
    loadPhotos(s);
  }
}

// 사진 영역: 로딩 전엔 자리만, 결과 없으면 숨김. 출처 링크 필수.
function photosHtml(s) {
  if (s.photo === null || (s.photo && !s.photo.images?.length)) return "";
  if (!s.photo) return `<div class="photos loading" aria-hidden="true"><i></i><i></i><i></i></div>`;
  return `<div class="photos">${s.photo.images
    .map(
      (im) => `<a href="${esc(im.source)}" target="_blank" rel="noopener nofollow" title="출처: ${esc(im.site || im.source)}">
        <img src="${esc(im.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.parentElement.remove()" /></a>`
    )
    .join("")}</div>`;
}

// 사진 로드 → 상태에 저장 → 핀·카드 갱신 (같은 매장 중복 호출은 api 캐시가 흡수)
async function loadPhotos(s) {
  if (!s || s.photo !== undefined) return;
  const res = await storePhotos(s);
  s.photo = res; // null = 없음/실패
  if (state.stores.includes(s)) {
    markers.get(s.id)?.setIcon(pinIcon(s, s.id === state.activeId));
    scheduleDeclutter();
    const li = document.querySelector(`.card[data-id="${CSS.escape(s.id)}"]`);
    if (li) li.outerHTML = card(s);
  }
}
const loadTopPhotos = () => state.stores.slice(0, LABELED).forEach(loadPhotos);

async function resolveKakao(s) {
  if (!s) return;
  const place = await kakaoPlace(s);
  const a = document.querySelector(`[data-kakao="${CSS.escape(s.id)}"]`);
  if (place && a) {
    a.href = place.url;
    a.title = `${place.name} · ${place.category}`;
  }
}

$("results").addEventListener("click", (e) => {
  const nx = e.target.closest("[data-next]");
  if (nx) return findSecondStop(state.stores.find((s) => s.id === nx.dataset.next));
  const ep = e.target.closest("[data-eatpl]");
  if (ep) return openEatpl(state.stores.find((s) => s.id === ep.dataset.eatpl));
  const add = e.target.closest("[data-add]");
  if (add) return toggleCandidate(add.dataset.add);
  if (e.target.closest("a")) return;
  const li = e.target.closest(".card");
  if (li) select(li.dataset.id === state.activeId ? null : li.dataset.id, "list");
});

function select(id, from) {
  const prev = state.activeId;
  state.activeId = id;
  for (const x of [prev, id]) {
    const s = state.stores.find((v) => v.id === x);
    if (s) markers.get(x)?.setIcon(pinIcon(s, x === id)).setZIndexOffset(zOf(s));
  }
  scheduleDeclutter();
  renderResults();
  const s = state.stores.find((v) => v.id === id);
  if (!s) return;
  if (from === "map" && sheet.snap === "peek") sheet.set("half");
  requestAnimationFrame(() => {
    focusStore(s);
    document.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: from === "map" ? "start" : "nearest", behavior: "smooth" });
  });
}

// ---------- 후보 & 안내문 ----------
function toggleCandidate(id) {
  const i = state.candidates.findIndex((c) => c.id === id);
  if (i >= 0) state.candidates.splice(i, 1);
  else if (state.candidates.length < CONFIG.maxCandidates) {
    const s = state.stores.find((v) => v.id === id);
    s.stage = state.mode === "dinner" ? "1차" : state.mode === "after" ? "2차" : "";
    state.candidates.push(s);
    if (state.candidates.length === CONFIG.maxCandidates) toast("후보 3곳 선택됨");
  }
  renderResults();
  renderTray();
}

function renderTray() {
  const n = state.candidates.length;
  $("candCount").textContent = n;
  $("candBtn").disabled = !n;
  $("candList").innerHTML = state.candidates
    .map((c) => `<li>${esc(c.name)} <button type="button" data-rm="${esc(c.id)}" aria-label="빼기">✕</button></li>`)
    .join("");
  const tone = document.querySelector('input[name="tone"]:checked').value;
  $("message").value = n
    ? buildMessage(state.candidates, { modeNoun: MODES[state.mode].noun, tone, link: shareLink(state.candidates, state.mode) })
    : "";
  if (!n && $("msgDialog").open) $("msgDialog").close();
}

$("candBtn").addEventListener("click", () => {
  renderTray();
  $("msgDialog").showModal();
});
$("candList").addEventListener("click", (e) => {
  const id = e.target.closest("[data-rm]")?.dataset.rm;
  if (id) toggleCandidate(id);
});
document.querySelectorAll('input[name="tone"]').forEach((r) => r.addEventListener("change", renderTray));
$("msgDialog").addEventListener("click", (e) => e.target === $("msgDialog") && $("msgDialog").close());

$("copyBtn").addEventListener("click", async () => {
  await copyText($("message").value);
  toast("복사됨");
});

$("shareBtn").addEventListener("click", async () => {
  const text = $("message").value;
  if (navigator.share) {
    try {
      await navigator.share({ title: "회식 장소 후보", text });
      return;
    } catch (e) {
      if (e.name === "AbortError") return;
    }
  }
  await copyText(text);
  toast("복사됨");
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    $("message").select();
    document.execCommand("copy");
  }
}

// ---------- 잇플 상세 모달 ----------
// iframe src 와 새 창 링크 모두 merUrl 원본 그대로. 추적 파라미터·리다이렉트 없음.
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
const closeEatpl = () => $("eatplDialog").close();
$("epClose").addEventListener("click", closeEatpl);
$("eatplDialog").addEventListener("click", (e) => e.target === $("eatplDialog") && closeEatpl());
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

// ---------- 현위치 ----------
const RADII = [800, 1500, 3000]; // 결과가 MIN_NEAR 미만이면 다음 반경으로 넓힘
const MIN_NEAR = 5;
const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10}m` : `${(m / 1000).toFixed(1)}km`);
function meters(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const x = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// 모드 정렬(매출 랭킹 등)은 유지하고, 반경으로만 거른다
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
    const badge = o.kind === "store" ? "<b>1차</b>" : "<b class=\"pl\">기준</b>";
    L.marker([o.lat, o.lng], {
      icon: L.divIcon({ className: "", html: `<div class="first-stop">${badge}${esc(o.name)}</div>`, iconSize: null }),
      interactive: false,
      zIndexOffset: 200000,
    }).addTo(meLayer);
    return;
  }
  if (o.acc && o.acc < 2000) L.circle([o.lat, o.lng], { radius: o.acc, color: "#1a73e8", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(meLayer);
  L.marker([o.lat, o.lng], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: null }), interactive: false, zIndexOffset: 200000 }).addTo(meLayer);
}

const GEO_ERR = {
  1: "위치 권한 필요",
  2: "위치 확인 실패",
  3: "위치 확인 시간 초과",
};
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

// ---------- 1차 → 2차 ----------
// 1차 장소를 원점으로 도보 반경(300m → 600m → 1km) 안의 2차 후보를 찾는다
const WALK_RADII = [300, 600, 1000];
const fmtWalk = (m) => `도보 ${Math.max(1, Math.round(m / 75))}분`; // 성인 보행 약 75m/분
// "서울 종로구 …" → "서울 종로구", "경기 용인시 기흥구 …" → "경기 용인시 기흥구"
function guOf(address) {
  const t = String(address).split(/\s+/);
  const i = t.findIndex((x, k) => k > 0 && /[구군]$/.test(x));
  if (i > 0) return t.slice(0, i + 1).join(" ");
  return t.slice(0, 2).join(" ");
}
function findSecondStop(s) {
  if (!s) return;
  if (!state.candidates.some((c) => c.id === s.id) && state.candidates.length < CONFIG.maxCandidates) {
    s.stage = "1차";
    state.candidates.push(s);
    renderTray();
  }
  state.origin = { kind: "store", id: s.id, name: s.name, lat: s.lat, lng: s.lng, radii: WALK_RADII, query: guOf(s.address) };
  drawMe(state.origin);
  $("locateBtn").classList.remove("on");
  $("loc").value = `${s.name} 근처`;
  state.mode = "after";
  state.categories = new Set(MODES.after.categories);
  renderTabs();
  renderChips();
  run();
}

// ---------- 검색어 추천 ----------
const PLACE_RADII = [500, 1000, 2000];
attachSuggest({
  input: $("loc"),
  box: $("suggest"),
  onPick(it) {
    clearOrigin();
    if (it.kind === "gu") {
      $("loc").value = it.label;
    } else {
      // 역·장소: 그 지점 기준 반경 검색 (잇플 검색은 그 장소가 속한 구로)
      state.origin = { kind: "place", name: it.label, lat: it.lat, lng: it.lng, radii: PLACE_RADII, query: guOf(it.address) };
      drawMe(state.origin);
    }
    $("loc").blur();
    run();
  },
});

// ---------- init ----------
$("loc").value = CONFIG.defaultLocation;
if (isKakaoInApp()) {
  $("inappOpen").href = kakaoExternalUrl(location.href);
  $("inapp").hidden = false;
}
const shared = readShare();
if (shared) {
  // 공유 링크로 진입: API 호출 없이 링크에 담긴 후보만 표시
  state.shared = true;
  if (MODES[shared.mode]) state.mode = shared.mode;
  state.stores = shared.stores;
  state.total = shared.stores.length;
  renderTabs();
  renderChips();
  renderTray();
  renderResults();
  renderMap();
} else {
  renderTabs();
  renderChips();
  renderTray();
  run();
}
