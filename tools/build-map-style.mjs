// 카카오맵풍 지도 스타일 생성기 — OpenFreeMap 'liberty' 스타일에서 색·라벨만 바꿔 vendor/map-style.json 으로 저장
// 사용: node tools/build-map-style.mjs   (배포에는 결과 JSON 만 포함, 이 스크립트는 .vercelignore 의 tools/ 로 제외)
//
// 바꾸는 것: 땅·공원·물·건물·도로 색(카카오맵 톤), 라벨은 한국어 이름 우선, 3D 건물·음영 기복·하위 POI 제거(핀이 묻히지 않게)
// 바꾸지 않는 것: 타일·폰트·스프라이트 출처(OpenFreeMap, 키·한도 없음), 레이어 구조
import { writeFile } from "node:fs/promises";

const SRC = "https://tiles.openfreemap.org/styles/liberty";
const OUT = new URL("../vendor/map-style.json", import.meta.url);

// 카카오맵 화면에서 고른 톤 (근사값 — 정확한 공식 팔레트 아님)
const C = {
  land: "#f5f4f0",
  residential: "rgba(234, 232, 226, 0.45)",
  park: "#d3ebc4",
  grass: "#d9eecb",
  wood: "#c9e3b6",
  water: "#aad3f2",
  waterway: "#9fcbee",
  building: "#e9e6e0",
  buildingLine: "#dcd8d1",
  school: "#f2efe2",
  hospital: "#f8e7e7",
  minor: "#ffffff",
  minorCase: "#dedad3",
  street: "#ffffff",
  streetCase: "#d9d4ca",
  major: "#fff1c2",
  majorCase: "#e8cf8a",
  motorway: "#fbd277",
  motorwayCase: "#e3a947",
  rail: "#c9c9c9",
  text: "#4a4a4a",
  textStrong: "#2b2b2b",
  roadText: "#6f6f6f",
  halo: "#ffffff",
};

// 레이어 id → 덮어쓸 paint (부분)
const PAINT = {
  background: { "background-color": C.land },
  park: { "fill-color": C.park, "fill-outline-color": C.park },
  park_outline: { "line-color": C.park },
  landuse_residential: { "fill-color": C.residential },
  landcover_wood: { "fill-color": C.wood },
  landcover_grass: { "fill-color": C.grass },
  landuse_pitch: { "fill-color": C.grass },
  landuse_track: { "fill-color": C.grass },
  landuse_cemetery: { "fill-color": C.grass },
  landuse_hospital: { "fill-color": C.hospital },
  landuse_school: { "fill-color": C.school },
  water: { "fill-color": C.water },
  waterway_tunnel: { "line-color": C.waterway },
  waterway_river: { "line-color": C.waterway },
  waterway_other: { "line-color": C.waterway },
  building: { "fill-color": C.building, "fill-outline-color": C.buildingLine },
};

// 도로: 이름 규칙으로 색 지정 (tunnel_/road_/bridge_ 공통)
function roadPaint(id) {
  const casing = id.endsWith("_casing");
  if (/rail/.test(id)) return id.endsWith("hatching") ? null : { "line-color": C.rail };
  if (/motorway/.test(id)) return { "line-color": casing ? C.motorwayCase : C.motorway };
  if (/trunk_primary/.test(id)) return { "line-color": casing ? C.majorCase : C.major };
  if (/secondary_tertiary|_link/.test(id)) return { "line-color": casing ? C.streetCase : C.street };
  if (/minor|street|service_track/.test(id)) return { "line-color": casing ? C.minorCase : C.minor };
  return null;
}

// 핀이 주인공 — 지도 쪽 장식은 덜어낸다
// 도로 번호 표지(shield)도 제거 — 회식 장소 고르는 데 필요 없고 핀과 겹친다
const DROP = new Set(["natural_earth", "building-3d", "poi_r20", "poi_r7", "road_area_pattern", "highway-shield-non-us", "highway-shield-us-interstate", "road_shield_us"]);
const KO = ["coalesce", ["get", "name:ko"], ["get", "name"]];

const style = await (await fetch(SRC)).json();
let recolored = 0, relabeled = 0;
style.layers = style.layers
  .filter((l) => !DROP.has(l.id))
  .map((l) => {
    const paint = PAINT[l.id] || (l["source-layer"] === "transportation" && l.type === "line" ? roadPaint(l.id) : null);
    if (paint) {
      l.paint = { ...(l.paint || {}), ...paint };
      recolored++;
    }
    const tf = l.layout?.["text-field"];
    if (tf && !/shield|one_way/.test(l.id)) {
      l.layout["text-field"] = KO;
      relabeled++;
    }
    // 카카오처럼 지명을 똑바로 (원본은 동·물 이름에 이탤릭 — 한글은 기기 글꼴로 그려져 기울어 보인다)
    const font = l.layout?.["text-font"];
    if (Array.isArray(font)) l.layout["text-font"] = font.map((f) => f.replace(/ Italic$/, " Regular"));
    if (l.type === "symbol" && l.paint) {
      if ("text-color" in l.paint) l.paint["text-color"] = /^label_(city|town|state|country)/.test(l.id) ? C.textStrong : /^highway-name/.test(l.id) ? C.roadText : C.text;
      if ("text-halo-color" in l.paint) l.paint["text-halo-color"] = C.halo;
    }
    return l;
  });
style.name = "hoesikpick-kakao-like (from OpenFreeMap liberty)";
style.metadata = { ...(style.metadata || {}), "hoesikpick:source": SRC, "hoesikpick:generated": "tools/build-map-style.mjs" };

await writeFile(OUT, JSON.stringify(style));
console.log(`map-style.json: 레이어 ${style.layers.length}개 (색 ${recolored}, 한국어 라벨 ${relabeled})`);
