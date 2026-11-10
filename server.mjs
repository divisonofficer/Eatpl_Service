// 로컬 데모 서버 (의존성 없음): node server.mjs  → http://localhost:8000
//  - 정적 파일 서빙
//  - GET /api/eatpl/search?location=&merTpbuzNm=&merNm=  → k-skill-proxy 중계
//    (k-skill-proxy는 CORS 헤더가 없어 브라우저 직접 호출 불가. IP당 60회/분 제한)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { storeKeys, matchPlace, rankImages } from "./lib/photos.mjs";

// .env (KAKAO_REST_KEY 등) — 파일이 없으면 무시
try { process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url))); } catch {}

const PORT = Number(process.env.PORT || 8000);
const PROXY = process.env.KSKILL_PROXY_BASE_URL || "https://k-skill-proxy.nomadamas.org";
const ROUTES = {
  // 잇플 가맹점 검색
  "/api/eatpl/search": { upstream: `${PROXY}/v1/bccard-eatpl/search`, params: ["location", "merTpbuzNm", "merNm"] },
  // 카카오 로컬 키워드 검색(공식 API) — 카카오맵 장소 링크(place_url) 해석용. 사진은 제공되지 않음
  "/api/kakao/keyword": { upstream: `${PROXY}/v1/kakao-map/search/keyword`, params: ["query", "size"] },
  // 좌표 → 행정구역 (현위치 검색용)
  "/api/kakao/coord2region": { upstream: `${PROXY}/v1/kakao-map/coord2region`, params: ["x", "y"] },
  // 다음 이미지 검색 (카카오 공식 API, 자체 REST 키 필요). 카카오맵 장소 사진 스크래핑은 하지 않는다.
  // 응답은 썸네일·출처만 남겨 전달 — 화면에서 반드시 출처 링크와 함께 노출
  "/api/images": {
    upstream: "https://dapi.kakao.com/v2/search/image",
    params: ["query"],
    fixed: { size: "6", sort: "accuracy" },
    requires: "KAKAO_REST_KEY",
    headers: () => ({ authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` }),
    map: (j) => ({
      images: (j.documents || []).map((d) => ({
        thumb: d.thumbnail_url, source: d.doc_url, site: d.display_sitename, w: d.width, h: d.height,
      })),
    }),
  },
};
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const CACHE_TTL = 10 * 60 * 1000;
const cache = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
};

async function relay(url, res, route) {
  const params = new URLSearchParams();
  for (const k of route.params) {
    const v = url.searchParams.get(k)?.trim().slice(0, 50);
    if (v) params.set(k, v);
  }
  if (![...params.keys()].length) return send(res, 400, { error: `${route.params.join(", ")} 중 하나 필요` });
  if (route.requires && !process.env[route.requires]) return send(res, 501, { error: `${route.requires} 미설정 (.env)` });
  for (const [k, v] of Object.entries(route.fixed || {})) params.set(k, v);

  const key = `${url.pathname}?${params}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return send(res, 200, hit.body, "HIT");

  try {
    const up = await fetch(`${route.upstream}?${params}`, { signal: AbortSignal.timeout(20000), headers: { accept: "application/json", ...(route.headers?.() || {}) } });
    let body = await up.text();
    if (up.ok && route.map) body = JSON.stringify(route.map(JSON.parse(body)));
    if (up.ok) cache.set(key, { at: Date.now(), body });
    console.log(`[relay] ${up.status} ${decodeURIComponent(key)}`);
    return send(res, up.status, body, "MISS");
  } catch (e) {
    console.error("[relay] upstream error", e.message);
    return send(res, 502, { error: `upstream: ${e.message}` });
  }
}

function send(res, status, body, cacheState) {
  res.writeHead(status, { "content-type": MIME[".json"], ...(cacheState ? { "x-cache": cacheState } : {}) });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// ---------- 매장 사진 (결정론 필터) ----------
// 입력: 잇플 매장 요약(name, addr, tel, lat, lng) → 카카오 장소 1 + 이미지 검색 1 + 블로그 검색 2 = 4회 호출
// 출력: 핀용 1장(검증된 것만) + 카드용 최대 3장. 24시간 캐시.
const PHOTO_TTL = 24 * 60 * 60 * 1000;
const photoCache = new Map();
const kakaoApi = async (path, params) => {
  const r = await fetch(`https://dapi.kakao.com${path}?${new URLSearchParams(params)}`, {
    headers: { authorization: `KakaoAK ${process.env.KAKAO_REST_KEY}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`kakao ${path} ${r.status}`);
  return (await r.json()).documents || [];
};

async function photos(url, res) {
  if (!process.env.KAKAO_REST_KEY) return send(res, 501, { error: "KAKAO_REST_KEY 미설정 (.env)" });
  const q = Object.fromEntries(["name", "addr", "tel", "lat", "lng"].map((k) => [k, url.searchParams.get(k)?.slice(0, 120) || ""]));
  const store = { merNm: q.name, merAddr: q.addr, merTpno: q.tel, lat: Number(q.lat), lng: Number(q.lng) };
  if (!store.merNm || !store.merAddr || !Number.isFinite(store.lat) || !Number.isFinite(store.lng)) return send(res, 400, { error: "name, addr, lat, lng 필요" });

  const key = JSON.stringify(q);
  const hit = photoCache.get(key);
  if (hit && Date.now() - hit.at < PHOTO_TTL) return send(res, 200, hit.body, "HIT");

  try {
    const k0 = storeKeys(store);
    const road = (store.merAddr.match(/\s(\S+(?:로|길))\s*\d/) || [])[1] || "";
    const dong = (store.merAddr.match(/\(([^),]+)/) || [])[1]?.trim() || "";
    const nameRoad = `${k0.core} ${road}`.trim();
    const nameDong = `${k0.core} ${dong}`.trim();
    // 카카오 장소는 k-skill-proxy 경유 (지번·전화 확보용)
    const placeDocs = await fetch(`${PROXY}/v1/kakao-map/search/keyword?${new URLSearchParams({ query: nameDong, size: "15" })}`, {
      signal: AbortSignal.timeout(10000),
    }).then((r) => (r.ok ? r.json() : { documents: [] })).then((j) => j.documents || []).catch(() => []);
    const [images, blogRoad, blogDong] = await Promise.all([
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
    photoCache.set(key, { at: Date.now(), body });
    console.log(`[photos] ${q.name} → pin=${r.pin ? "Y" : "-"} kept=${r.ranked.length}`);
    return send(res, 200, body, "MISS");
  } catch (e) {
    console.error("[photos]", e.message);
    return send(res, 502, { error: e.message });
  }
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/api/photos") return photos(url, res);
  if (ROUTES[url.pathname]) return relay(url, res, ROUTES[url.pathname]);
  const path = normalize(join(ROOT, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
  if (!path.startsWith(ROOT) || /\/(\.git|tools|proxy|lib|docs)\//.test(path)) return send(res, 404, { error: "not found" });
  try {
    const data = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(data);
  } catch {
    send(res, 404, { error: "not found" });
  }
}).listen(PORT, () => console.log(`회식픽 데모 → http://localhost:${PORT}  (proxy: ${PROXY})`));
