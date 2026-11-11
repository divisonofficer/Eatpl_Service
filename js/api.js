// 데이터 계층 — eat.pl API 정의서 v1 필드 기준. UI는 normalize()된 Store만 본다.
//
// 검색 전략: location + merTpbuzNm 을 업종 칩마다 1회 호출 (100건 상한 회피, 대분류는 서버에서만 필터 가능)
// 키워드 검색(회식·심야 등)은 k-skill-proxy 미지원 → live 에서는 생략, 필드 기반 필터로 대체.
import { CONFIG } from "./config.js";
import { TM128 } from "./geo-def.js";
import { cleanName } from "./legal-name.js";

const toWgs = (x, y) => {
  const [lng, lat] = window.proj4(TM128, "WGS84", [Number(x), Number(y)]);
  return { lat, lng };
};

const keyOf = (r) => (r.merUrl && r.merUrl !== "https://web.paybooc.ai/" ? r.merUrl : `${r.merNm}|${r.merAddr}`);

function normalize(r, kwSet) {
  const { lat, lng } = toWgs(r.xaxsVal, r.yaxsVal);
  const c = r.vistCstmrRnkList || {};
  return {
    id: keyOf(r),
    name: cleanName(r.merNm), // 사업자(법인)명 표기는 정규식으로 제거 — 화면에는 상호만
    category: r.merTpbuzNm || "-",
    address: r.merAddr || "",
    lat,
    lng,
    rank: r.ccgSaleRnk, // number, 표기 시 String() 그대로 — 반올림 금지
    rankAll: r.allSaleRnk,
    group: r.empyVsitYn === true,
    local: r.loclPrsnPpltYn === true,
    busyTime: r.congestionTizn || "",
    busyDay: r.congestionDwk || "",
    open: r.srtTime || "",
    close: r.endTime || "",
    holidays: Array.isArray(r.hldyDwk) ? r.hldyDwk : [],
    customers: [c.rk01, c.rk02, c.rk03].filter(Boolean),
    url: r.merUrl,
    tel: r.merTpno || "",
    kw: kwSet.has(keyOf(r)),
  };
}

const unwrap = (json) => json.items || json.data || [];

// ---------- live: 로컬 서버 → k-skill-proxy ----------
async function liveCall({ keyword, location, merTpbuzNm }) {
  if (keyword) return []; // 미지원
  const qs = new URLSearchParams({ location, merTpbuzNm });
  const res = await fetch(`${CONFIG.liveUrl}?${qs}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return unwrap(json);
}

// ---------- proxy: 자체 닷홈 프록시 ----------
async function proxyCall(params) {
  const res = await fetch(CONFIG.proxyUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Demo-Token": CONFIG.proxyToken },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (json.rspCode !== "00000") throw new Error(`${json.rspCode} ${json.rspMessage}`);
  return unwrap(json);
}

// ---------- mock: 서버 측 필터를 흉내 ----------
let mockCache = null;
const loadMock = async () => (mockCache ||= await fetch(CONFIG.mockUrl).then((r) => r.json()));
async function mockCall({ keyword, location, merTpbuzNm }) {
  return unwrap(await loadMock())
    .filter(
      (r) =>
        (!location || r.merAddr.includes(location)) &&
        (!merTpbuzNm || r.merTpbuzNm === merTpbuzNm || r._tpbuzL === merTpbuzNm) &&
        (!keyword || r._keywords.includes(keyword))
    )
    .sort((a, b) => a.allSaleRnk - b.allSaleRnk)
    .slice(0, 100);
}

const CALLS = { live: liveCall, proxy: proxyCall, mock: mockCall };
export const status = { source: CONFIG.source, fellBack: false, error: "" };

async function searchWith(call, { keyword, location, categories }) {
  const [lists, kwList] = await Promise.all([
    Promise.all(categories.map((c) => call({ location, merTpbuzNm: c }))),
    keyword ? call({ keyword, location }).catch(() => []) : [],
  ]);
  const kwSet = new Set(kwList.map(keyOf));
  const seen = new Map();
  for (const r of lists.flat()) if (r.merUrl && !seen.has(keyOf(r))) seen.set(keyOf(r), r); // 상세 링크 없는 행 제외
  return [...seen.values()].map((r) => normalize(r, kwSet));
}

export async function search(q) {
  if (status.source === "mock") return searchWith(mockCall, q);
  try {
    const out = await searchWith(CALLS[status.source], q);
    status.fellBack = false;
    status.error = "";
    return out;
  } catch (e) {
    console.warn("실데이터 실패 → 모의 데이터 폴백", e);
    status.fellBack = true;
    status.error = e.message;
    return searchWith(mockCall, q);
  }
}

// ---------- 카카오맵 장소 링크 (사진·리뷰는 카카오맵에서 확인) ----------
// 카카오 로컬 키워드 검색(공식 API, k-skill-proxy 경유)으로 place_url 을 찾는다. 사진 URL은 API가 주지 않음.
// 확신이 없으면 카카오맵 검색 링크로 대체 (추측 매칭 금지).
const kakaoCache = new Map();
const squash = (t) => String(t).replace(/\([^)]*\)|주식회사|\(주\)|㈜|[^0-9A-Za-z가-힣]/g, "").toLowerCase();
const addrTokens = (a) => new Set(String(a).split(/\s+/).filter((t) => /[구군동로길]$/.test(t)));

export const kakaoSearchUrl = (s) => `https://map.kakao.com/?q=${encodeURIComponent(`${s.name} ${s.address.split(" ").slice(0, 2).join(" ")}`)}`;

export async function kakaoPlace(s) {
  if (status.source === "mock" || status.fellBack) return null;
  if (kakaoCache.has(s.id)) return kakaoCache.get(s.id);
  const p = (async () => {
    const q = new URLSearchParams({ query: s.name.replace(/\([^)]*\)/g, " ").trim(), size: "10" });
    const res = await fetch(`/api/kakao/keyword?${q}`);
    if (!res.ok) return null;
    const docs = (await res.json()).documents || [];
    const want = squash(s.name);
    const mine = addrTokens(s.address);
    const hits = docs.filter((d) => {
      const n = squash(d.place_name);
      const nameOk = n && want && (n.includes(want) || want.includes(n));
      const addrOk = [...addrTokens(`${d.road_address_name} ${d.address_name}`)].some((t) => mine.has(t));
      return nameOk && addrOk && ["FD6", "CE7"].includes(d.category_group_code); // 음식점·카페
    });
    return hits.length === 1 ? { url: hits[0].place_url, name: hits[0].place_name, category: hits[0].category_name } : null;
  })().catch(() => null);
  kakaoCache.set(s.id, p);
  return p;
}

// ---------- 매장 사진 (서버 /api/photos — lib/photos.mjs 결정론 필터) ----------
// pin: 이름+주소/전화로 검증된 사진 1장(없으면 null) / images: 카드용 최대 3장
// 키 미설정(501)이면 이후 호출 생략. 동시 3건으로 제한 (외부 API 호출량 보호)
const photoCache = new Map();
let photosDisabled = false;
let active = 0;
const waiters = [];
const slot = () => (active < 6 ? (active++, Promise.resolve()) : new Promise((r) => waiters.push(r)));
const release = () => (waiters.length ? waiters.shift()() : active--);

export function storePhotos(s) {
  if (photosDisabled || status.source === "mock" || status.fellBack) return Promise.resolve(null);
  if (photoCache.has(s.id)) return photoCache.get(s.id);
  const q = new URLSearchParams({ name: s.name, addr: s.address, tel: s.tel || "", lat: s.lat.toFixed(6), lng: s.lng.toFixed(6) });
  const p = slot()
    .then(() => fetch(`/api/photos?${q}`))
    .then(async (r) => {
      if (r.status === 501) photosDisabled = true;
      return r.ok ? r.json() : null;
    })
    .catch(() => null)
    .finally(release);
  photoCache.set(s.id, p);
  return p;
}

// ---------- 현위치 → 잇플 location 문자열 ----------
// 잇플은 주소 부분일치 검색 → 법정동 주소의 "시도 약칭 + 시군구" 로 만든다 (예: "서울 종로구", "경기 용인시 기흥구")
const SIDO = {
  서울특별시: "서울", 부산광역시: "부산", 대구광역시: "대구", 인천광역시: "인천", 광주광역시: "광주", 대전광역시: "대전",
  울산광역시: "울산", 세종특별자치시: "세종", 경기도: "경기", 강원도: "강원", 강원특별자치도: "강원", 충청북도: "충북",
  충청남도: "충남", 전라북도: "전북", 전북특별자치도: "전북", 전라남도: "전남", 경상북도: "경북", 경상남도: "경남",
  제주특별자치도: "제주",
};
export async function regionOf(lat, lng) {
  const res = await fetch(`/api/kakao/coord2region?${new URLSearchParams({ x: lng.toFixed(6), y: lat.toFixed(6) })}`);
  if (!res.ok) throw new Error("행정구역 조회 실패");
  const docs = (await res.json()).documents || [];
  const b = docs.find((d) => d.region_type === "B") || docs[0];
  if (!b) throw new Error("행정구역 조회 실패");
  const sido = SIDO[b.region_1depth_name] || b.region_1depth_name;
  return { query: `${sido} ${b.region_2depth_name}`.trim(), dong: b.region_3depth_name, label: b.address_name };
}

// ---------- 룸·콜키지·주차 정밀 (/api/amenities — 상세 열기·필터 켤 때만) ----------
const amenCache = new Map();
export function storeAmenities(s) {
  if (photosDisabled || status.source === "mock" || status.fellBack) return Promise.resolve(null);
  if (amenCache.has(s.id)) return amenCache.get(s.id);
  const q = new URLSearchParams({ name: s.name, addr: s.address, tel: s.tel || "", lat: s.lat.toFixed(6), lng: s.lng.toFixed(6) });
  const p = slot()
    .then(() => fetch(`/api/amenities?${q}`))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (j?.amenities ? { ...j.amenities, reserve: j.reserve || null } : null)) // reserve: 예약 힌트(블로그)
    .catch(() => null)
    .finally(release);
  amenCache.set(s.id, p);
  return p;
}

// ---------- 잇플 상세 '편의 서비스' (공식 주차 여부) — /api/facilities ----------
// { parking: yes|no|null, wifi } — 매장 1곳 = 서버가 상세 페이지 1회 조회(1일 캐시). 목록·상세·필터가 이 값을 우선한다.
const facCache = new Map();
let facDisabled = false;
export function storeFacilities(s) {
  if (facDisabled || status.source === "mock" || status.fellBack || !s.url) return Promise.resolve(null);
  if (facCache.has(s.id)) return facCache.get(s.id);
  const p = slot()
    .then(() => fetch(`/api/facilities?${new URLSearchParams({ url: s.url })}`))
    .then((r) => {
      if (r.status === 501) facDisabled = true;
      return r.ok ? r.json() : null;
    })
    .catch(() => null)
    .finally(release);
  facCache.set(s.id, p);
  return p;
}

// ---------- 룸 있음 검증 (K-EXAONE, 서버가 호출) — 상세를 열 때만 ----------
// { room, verified } — verified=false 면 규칙 추정 그대로(한도·실패 폴백). 모델 호출이 느릴 수 있어(수십 초) 사진 슬롯을 쓰지 않는다.
const roomCache = new Map();
export function verifyRoomOnline(s) {
  if (photosDisabled || status.source === "mock" || status.fellBack) return Promise.resolve(null);
  if (roomCache.has(s.id)) return roomCache.get(s.id);
  const q = new URLSearchParams({ name: s.name, addr: s.address, tel: s.tel || "", lat: s.lat.toFixed(6), lng: s.lng.toFixed(6), verify: "1" });
  const p = fetch(`/api/amenities?${q}`, { signal: AbortSignal.timeout(58000) })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  roomCache.set(s.id, p);
  return p;
}

// ---------- 검색어 → 좌표 (결과가 없을 때 지도 이동용) ----------
const geoCache = new Map();
export function geocode(q) {
  q = String(q || "").trim();
  if (!q) return Promise.resolve(null);
  if (!geoCache.has(q))
    geoCache.set(
      q,
      fetch(`/api/kakao/keyword?${new URLSearchParams({ query: q, size: "1" })}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => {
          const d = j?.documents?.[0];
          return d ? { lat: Number(d.y), lng: Number(d.x), name: d.place_name } : null;
        })
        .catch(() => null)
    );
  return geoCache.get(q);
}
