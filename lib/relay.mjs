// API 중계 — 로컬(server.mjs)과 Vercel 함수(api/*.mjs)가 같이 쓴다.
// handleApi(path, searchParams, headers) → { status, headers, body(string) }
//
//  /api/eatpl/search        잇플 가맹점 검색 (k-skill-proxy)           CDN 6시간
//  /api/kakao/keyword       카카오 로컬 키워드 (k-skill-proxy)          CDN 1일
//  /api/kakao/coord2region  좌표 → 행정구역 (k-skill-proxy)             CDN 7일
//  /api/photos              매장 사진 결정론 필터 (카카오 검색, 자체 키)  CDN 1일
//
// 캐시: 인스턴스 메모리(로컬·웜 함수) + Cache-Control s-maxage (Vercel CDN, URL 단위).
// k-skill-proxy 한도(IP당 60회/분)를 서비스 전체가 나눠 쓰므로 CDN 캐시가 핵심.
import { storeKeys, matchPlace, rankImages } from "./photos.mjs";

const PROXY = () => process.env.KSKILL_PROXY_BASE_URL || "https://k-skill-proxy.nomadamas.org";
const H = 3600;

const ROUTES = {
  "/api/eatpl/search": { upstream: () => `${PROXY()}/v1/bccard-eatpl/search`, params: ["location", "merTpbuzNm", "merNm"], sMaxAge: 6 * H },
  "/api/kakao/keyword": { upstream: () => `${PROXY()}/v1/kakao-map/search/keyword`, params: ["query", "size"], sMaxAge: 24 * H },
  "/api/kakao/coord2region": { upstream: () => `${PROXY()}/v1/kakao-map/coord2region`, params: ["x", "y"], sMaxAge: 7 * 24 * H },
  "/api/photos": { handler: photos, sMaxAge: 24 * H },
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
// 잇플 매장 요약(name, addr, tel, lat, lng) → 카카오 로컬 1 + 이미지 1 + 블로그 2 = 4회 호출 (모두 자체 키)
// → lib/photos.mjs 결정론 필터 → 핀용 1장(검증된 것만) + 카드용 최대 3장
const kakaoApi = async (path, params) => {
  const r = await fetch(`https://dapi.kakao.com${path}?${new URLSearchParams(params)}`, {
    headers: { authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`kakao ${path} ${r.status}`);
  return (await r.json()).documents || [];
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
  const [placeDocs, images, blogRoad, blogDong] = await Promise.all([
    placeLookup(nameDong),
    kakaoApi("/v2/search/image", { query: nameRoad, size: "30", sort: "accuracy" }),
    kakaoApi("/v2/search/blog", { query: nameRoad, size: "50", sort: "accuracy" }),
    kakaoApi("/v2/search/blog", { query: nameDong, size: "50", sort: "accuracy" }),
  ]);
  const place = matchPlace(store, placeDocs);
  const r = rankImages({ store, place, images, texts: [...blogRoad, ...blogDong] });
  const pick = (x) => x && { thumb: x.thumb, source: x.source, site: x.site, level: x.level, evidence: x.evidence };
  const body = JSON.stringify({
    pin: pick(r.pin),
    images: r.ranked.slice(0, 3).map(pick),
    place: place && { name: place.place_name, url: place.place_url },
    query: nameRoad,
  });
  memSet(key, body);
  console.log(`[photos] ${q.name} → pin=${r.pin ? "Y" : "-"} kept=${r.ranked.length}`);
  return cached(body, route.sMaxAge, "MISS");
}
