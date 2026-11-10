// API 중계 — 로컬(server.mjs)과 Vercel 함수(api/*.mjs)가 같이 쓴다.
// handleApi(path, searchParams, headers) → { status, headers, body(string) }
//
//  /api/eatpl/search        잇플 가맹점 검색 (k-skill-proxy)           CDN 6시간
//  /api/kakao/keyword       카카오 로컬 키워드 (k-skill-proxy)          CDN 1일
//  /api/kakao/coord2region  좌표 → 행정구역 (k-skill-proxy)             CDN 7일
//  /api/photos              매장 사진 결정론 필터 + 편의 정보 대략치 (카카오 4회)  CDN 1일
//  /api/amenities           룸·콜키지·주차 정밀 (기본 2회 + 전용 3회, 같은 인스턴스면 기본은 캐시)  CDN 1일
//
// 캐시: 인스턴스 메모리(로컬·웜 함수) + Cache-Control s-maxage (Vercel CDN, URL 단위).
// k-skill-proxy 한도(IP당 60회/분)를 서비스 전체가 나눠 쓰므로 CDN 캐시가 핵심.
import { storeKeys, matchPlace, rankImages, verifyText } from "./photos.mjs";
import { summarizeAmenities } from "./amenities.mjs";
import { checkThumb } from "./vision.mjs";

const PROXY = () => process.env.KSKILL_PROXY_BASE_URL || "https://k-skill-proxy.nomadamas.org";
const H = 3600;

const ROUTES = {
  "/api/eatpl/search": { upstream: () => `${PROXY()}/v1/bccard-eatpl/search`, params: ["location", "merTpbuzNm", "merNm"], sMaxAge: 6 * H },
  "/api/kakao/keyword": { upstream: () => `${PROXY()}/v1/kakao-map/search/keyword`, params: ["query", "size"], sMaxAge: 24 * H },
  "/api/kakao/coord2region": { upstream: () => `${PROXY()}/v1/kakao-map/coord2region`, params: ["x", "y"], sMaxAge: 7 * 24 * H },
  "/api/photos": { handler: photos, sMaxAge: 24 * H },
  "/api/amenities": { handler: amenitiesRoute, sMaxAge: 24 * H },
};
export const API_PATHS = Object.keys(ROUTES);

const mem = new Map();
const MEM_TTL = 10 * 60 * 1000;
const MEM_MAX = 2000;
function memGet(k, ttl = MEM_TTL) {
  const hit = mem.get(k);
  return hit && Date.now() - hit.at < ttl ? hit.body : null;
}
function memSet(k, body) {
  if (mem.size >= MEM_MAX) mem.delete(mem.keys().next().value);
  mem.set(k, { at: Date.now(), body });
}

const json = (status, obj, extra = {}) => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  body: typeof obj === "string" ? obj : JSON.stringify(obj),
});
const cached = (body, sMaxAge, state) =>
  json(200, body, {
    "cache-control": `public, max-age=300, s-maxage=${sMaxAge}, stale-while-revalidate=${sMaxAge * 4}`,
    "x-cache": state,
  });

// 다른 사이트의 브라우저에서 우리 중계를 쓰는 것을 막는다 (스크립트 남용까지 막지는 못함)
function crossSite(headers) {
  const site = headers["sec-fetch-site"];
  return site && !["same-origin", "none"].includes(site);
}

export async function handleApi(path, sp, headers = {}) {
  const route = ROUTES[path];
  if (!route) return json(404, { error: "not found" });
  if (crossSite(headers)) return json(403, { error: "forbidden" });
  try {
    if (route.handler) return await route.handler(sp, route);
    return await relay(path, sp, route);
  } catch (e) {
    console.error(`[api] ${path}`, e.message);
    return json(502, { error: `upstream: ${e.message}` });
  }
}

async function relay(path, sp, route) {
  const params = new URLSearchParams();
  for (const k of route.params) {
    const v = sp.get(k)?.trim().slice(0, 50);
    if (v) params.set(k, v);
  }
  if (![...params.keys()].length) return json(400, { error: `${route.params.join(", ")} 중 하나 필요` });
  const key = `${path}?${params}`;
  const hit = memGet(key);
  if (hit) return cached(hit, route.sMaxAge, "HIT");

  const up = await fetch(`${route.upstream()}?${params}`, { signal: AbortSignal.timeout(20000), headers: { accept: "application/json" } });
  const body = await up.text();
  console.log(`[relay] ${up.status} ${decodeURIComponent(key)}`);
  if (!up.ok) return json(up.status, body);
  memSet(key, body);
  return cached(body, route.sMaxAge, "MISS");
}

// ---------- 매장 사진 ----------
// 잇플 매장 요약(name, addr, tel, lat, lng) → 카카오 로컬 1 + 이미지 1 + 블로그 5 = 7회 호출 (모두 자체 키)
// → 텍스트 검증(photos.mjs) → 사진 내용 검사(vision.mjs) → 핀 1장 + 카드 3장 / 룸·콜키지·주차(amenities.mjs)
// → lib/photos.mjs 결정론 필터 → 핀용 1장(검증된 것만) + 카드용 최대 3장
// 카카오 호출 캐시: 같은 요청은 인스턴스 메모리 1일 + (로컬 개발만) 디스크 3일 — 테스트 반복·재시작 시 재호출 방지
const KAKAO_MEM = new Map();
const DISK = !process.env.VERCEL && process.env.NODE_ENV !== "production";
const DISK_TTL = 3 * 24 * 3600 * 1000;
async function diskGet(key) {
  if (!DISK) return null;
  try {
    const { readFile, stat } = await import("node:fs/promises");
    const f = await diskPath(key);
    if (Date.now() - (await stat(f)).mtimeMs > DISK_TTL) return null;
    return JSON.parse(await readFile(f, "utf8"));
  } catch {
    return null;
  }
}
async function diskSet(key, val) {
  if (!DISK) return;
  try {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const f = await diskPath(key);
    await mkdir(f.slice(0, f.lastIndexOf("/")), { recursive: true });
    await writeFile(f, JSON.stringify(val));
  } catch {}
}
async function diskPath(key) {
  const { createHash } = await import("node:crypto");
  const { fileURLToPath } = await import("node:url");
  return fileURLToPath(new URL(`../.cache/kakao/${createHash("sha1").update(key).digest("hex")}.json`, import.meta.url));
}
const kakaoApi = (path, params) => {
  const url = `https://dapi.kakao.com${path}?${new URLSearchParams(params)}`;
  const hit = KAKAO_MEM.get(url);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.p;
  const p = (async () => {
    const d = await diskGet(url);
    if (d) return d;
    if (process.env.DEBUG_KAKAO) console.log("[kakao-net]", decodeURIComponent(url.replace("https://dapi.kakao.com", "")));
    const r = await fetch(url, { headers: { authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`kakao ${path} ${r.status}`);
    const docs = (await r.json()).documents || [];
    diskSet(url, docs);
    return docs;
  })();
  p.catch(() => KAKAO_MEM.delete(url));
  KAKAO_MEM.set(url, { at: Date.now(), p });
  if (KAKAO_MEM.size > 5000) KAKAO_MEM.delete(KAKAO_MEM.keys().next().value);
  return p;
};

// 장소 조회: 자체 키 카카오 로컬 API 우선. 앱에서 카카오맵(로컬) 서비스가 꺼져 있으면(403)
// k-skill-proxy 로 폴백 (한도 공유 주의 — 카카오 디벨로퍼스에서 서비스를 켜면 폴백 안 탐)
let localDisabled = false;
async function placeLookup(query) {
  if (!localDisabled) {
    try {
      return await kakaoApi("/v2/local/search/keyword.json", { query, size: "15" });
    } catch (e) {
      if (/ 403$/.test(e.message)) {
        localDisabled = true;
        console.warn("[photos] 카카오 로컬 API 비활성(403) → k-skill-proxy 폴백");
      } else return [];
    }
  }
  return fetch(`${PROXY()}/v1/kakao-map/search/keyword?${new URLSearchParams({ query, size: "15" })}`, { signal: AbortSignal.timeout(10000) })
    .then((r) => (r.ok ? r.json() : { documents: [] }))
    .then((j) => j.documents || [])
    .catch(() => []);
}

async function photos(sp, route) {
  if (!process.env.KAKAO_REST_KEY) return json(501, { error: "KAKAO_REST_KEY 미설정" });
  const q = Object.fromEntries(["name", "addr", "tel", "lat", "lng"].map((k) => [k, sp.get(k)?.slice(0, 120) || ""]));
  const store = { merNm: q.name, merAddr: q.addr, merTpno: q.tel, lat: Number(q.lat), lng: Number(q.lng) };
  if (!store.merNm || !store.merAddr || !Number.isFinite(store.lat) || !Number.isFinite(store.lng)) {
    return json(400, { error: "name, addr, lat, lng 필요" });
  }
  const key = `photos:${JSON.stringify(q)}`;
  const hit = memGet(key, route.sMaxAge * 1000);
  if (hit) return cached(hit, route.sMaxAge, "HIT");

  const k0 = storeKeys(store);
  const road = (store.merAddr.match(/\s(\S+(?:로|길))\s*\d/) || [])[1] || "";
  const dong = (store.merAddr.match(/\(([^),]+)/) || [])[1]?.trim() || "";
  const nameRoad = `${k0.core} ${road}`.trim();
  const nameDong = `${k0.core} ${dong}`.trim();
  // 장소(지번·전화) 조회도 자체 키로 카카오 로컬 API 직접 호출 — k-skill-proxy 한도(60회/분)는 잇플 검색에 남긴다
  // 기본 4회 (목록용). 룸·콜키지·주차 전용 검색 3회는 /api/amenities 에서 필요할 때만.
  const [placeDocs, images, blogRoad, blogDong] = await Promise.all([
    placeLookup(nameDong),
    kakaoApi("/v2/search/image", { query: nameRoad, size: "30", sort: "accuracy" }),
    kakaoApi("/v2/search/blog", { query: nameRoad, size: "50", sort: "accuracy" }),
    kakaoApi("/v2/search/blog", { query: nameDong, size: "50", sort: "accuracy" }),
  ]);
  const [blogRoom, blogCork, blogPark] = [[], [], []];
  const place = matchPlace(store, placeDocs);
  const r = rankImages({ store, place, images, texts: [...blogRoad, ...blogDong] });

  // 사진 내용 검사: 텍스트 검증 순위대로 최대 10장 → 인물·엉뚱한 사진 제외. 판정 실패(null)는 통과로 둔다.
  const cand = r.ranked.slice(0, 10);
  const verdicts = await Promise.all(cand.map((x) => checkThumb(x.thumb)));
  const passed = cand.filter((x, i) => verdicts[i]?.ok !== false);
  const dropped = cand.map((x, i) => verdicts[i]?.ok === false && verdicts[i].reason).filter(Boolean);
  const pinImg = passed.find((x) => x.level === "verified" && x.w / x.h >= 0.9) || null;

  // 편의 정보: 모든 블로그 결과 중 이 매장 글만
  const keys = storeKeys(store, place);
  const mine = [...blogRoad, ...blogDong, ...blogRoom, ...blogCork, ...blogPark].filter((d) =>
    ["verified", "likely", "risky"].includes(verifyText(d, keys).level)
  );
  const amenities = summarizeAmenities(mine);

  // 카카오 검색 썸네일 최대 크기는 320px (130px 는 화면에서 흐림)
  const big = (u) => String(u).replace("/130x130_85_c/", "/320x320_85_c/");
  const pick = (x) => x && { thumb: big(x.thumb), source: x.source, site: x.site, level: x.level, evidence: x.evidence };
  const body = JSON.stringify({
    pin: pick(pinImg),
    images: passed.slice(0, 3).map(pick),
    amenities,
    amenitiesFull: false, // 기본 글만 본 대략치 — 정밀은 /api/amenities
    place: place && { name: place.place_name, url: place.place_url },
    query: nameRoad,
    vision: { checked: verdicts.filter(Boolean).length, dropped },
  });
  memSet(key, body);
  console.log(`[photos] ${q.name} → pin=${pinImg ? "Y" : "-"} kept=${passed.length}/${r.ranked.length} dropped=${dropped.join(",") || "-"} room=${amenities.room?.state || "-"} cork=${amenities.corkage?.state || "-"} park=${amenities.parking?.state || "-"}`);
  return cached(body, route.sMaxAge, "MISS");
}

// ---------- 편의 정보 정밀 (상세 열기·필터 켤 때만) ----------
async function amenitiesRoute(sp, route) {
  if (!process.env.KAKAO_REST_KEY) return json(501, { error: "KAKAO_REST_KEY 미설정" });
  const q = Object.fromEntries(["name", "addr", "tel", "lat", "lng"].map((k) => [k, sp.get(k)?.slice(0, 120) || ""]));
  const store = { merNm: q.name, merAddr: q.addr, merTpno: q.tel, lat: Number(q.lat), lng: Number(q.lng) };
  if (!store.merNm || !store.merAddr || !Number.isFinite(store.lat) || !Number.isFinite(store.lng)) return json(400, { error: "name, addr, lat, lng 필요" });
  const key = `amen:${JSON.stringify(q)}`;
  const hit = memGet(key, route.sMaxAge * 1000);
  if (hit) return cached(hit, route.sMaxAge, "HIT");
  const k0 = storeKeys(store);
  const road = (store.merAddr.match(/\s(\S+(?:로|길))\s*\d/) || [])[1] || "";
  const dong = (store.merAddr.match(/\(([^),]+)/) || [])[1]?.trim() || "";
  const nameRoad = `${k0.core} ${road}`.trim();
  const nameDong = `${k0.core} ${dong}`.trim();
  const opt = (query) => kakaoApi("/v2/search/blog", { query, size: "30", sort: "accuracy" }).catch(() => []);
  const [placeDocs, blogRoad, blogDong, blogRoom, blogCork, blogPark] = await Promise.all([
    placeLookup(nameDong),
    kakaoApi("/v2/search/blog", { query: nameRoad, size: "50", sort: "accuracy" }).catch(() => []),
    kakaoApi("/v2/search/blog", { query: nameDong, size: "50", sort: "accuracy" }).catch(() => []),
    opt(`${nameDong} 룸`),
    opt(`${nameDong} 콜키지`),
    opt(`${nameDong} 주차`),
  ]);
  const keys = storeKeys(store, matchPlace(store, placeDocs));
  const mine = [...blogRoad, ...blogDong, ...blogRoom, ...blogCork, ...blogPark].filter((d) => ["verified", "likely", "risky"].includes(verifyText(d, keys).level));
  const body = JSON.stringify({ amenities: summarizeAmenities(mine), amenitiesFull: true });
  memSet(key, body);
  return cached(body, route.sMaxAge, "MISS");
}
