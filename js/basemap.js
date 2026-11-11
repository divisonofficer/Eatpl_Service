// 지도 배경 — 카카오맵풍 벡터 지도(MapLibre + OpenFreeMap, 키·한도 없음, vendor/map-style.json).
// Leaflet 은 그대로(핀·묶기·이동은 Leaflet), 배경 레이어만 바꾼다.
// 폴백: WebGL 없음, ?raster 강제, 스타일이 제때 안 뜸(OpenFreeMap 장애 등) → OSM 래스터 타일.
const OSM = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
// ?v= : vendor/ 는 CDN·브라우저에 7일 캐시(vercel.json) — 스타일을 다시 만들면 이 번호를 올릴 것
const STYLE = "vendor/map-style.json?v=3";
const STYLE_TIMEOUT = 6000;

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

const raster = (attribution) => L.tileLayer(OSM, { maxZoom: 19, attribution: `${attribution}© OpenStreetMap` });

// attribution: 앞에 붙일 출처(예: 잇플 표기). 지도 데이터 출처는 여기서 붙인다.
// 앞에 붙일 출처(잇플 표기)는 배경 레이어와 별도로 등록한다 — 벡터 플러그인은 스타일의 출처 문구만 써서 잇플 표기가 사라진다.
export function attachBaseMap(map, { attribution = "" } = {}) {
  if (attribution) map.attributionControl?.addAttribution(attribution);
  const prefix = "";
  const forceRaster = new URLSearchParams(location.search).has("raster");
  if (forceRaster || !window.maplibregl || !L.maplibreGL || !hasWebGL()) return raster(prefix).addTo(map);
  const layer = L.maplibreGL({ style: STYLE, attribution: "OpenFreeMap © OpenMapTiles © OpenStreetMap" }).addTo(map);
  const gl = layer.getMaplibreMap?.();
  const fallback = () => {
    if (!map.hasLayer(layer)) return;
    console.warn("[basemap] 벡터 지도 로드 실패 → OSM 래스터");
    map.removeLayer(layer);
    raster(prefix).addTo(map);
  };
  const t = setTimeout(() => gl && !gl.isStyleLoaded() && fallback(), STYLE_TIMEOUT);
  gl?.once("load", () => clearTimeout(t));
  return layer;
}
