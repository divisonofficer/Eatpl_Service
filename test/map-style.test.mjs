// 생성된 지도 스타일(vendor/map-style.json) 점검 — tools/build-map-style.mjs 결과가 의도대로인지
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const style = JSON.parse(readFileSync(new URL("../vendor/map-style.json", import.meta.url), "utf8"));
const layer = (id) => style.layers.find((l) => l.id === id);

test("MapLibre 스타일 v8, OpenFreeMap 출처(키·한도 없음)", () => {
  assert.equal(style.version, 8);
  assert.match(style.sources.openmaptiles.url, /^https:\/\/tiles\.openfreemap\.org\//);
  assert.match(style.glyphs, /^https:\/\/tiles\.openfreemap\.org\//);
});

test("핀을 가리는 장식 제거: 3D 건물·음영 기복·하위 POI", () => {
  for (const id of ["building-3d", "natural_earth", "poi_r20", "poi_r7", "highway-shield-non-us"]) assert.equal(layer(id), undefined, id);
  assert.ok(!style.layers.some((l) => /shield/.test(l.id)), "도로 번호 표지 없음");
  assert.ok(layer("poi_transit"), "역·정류장 라벨은 남긴다");
});

test("카카오풍 색: 공원 초록·물 파랑·간선 노랑", () => {
  assert.equal(layer("park").paint["fill-color"], "#d3ebc4");
  assert.equal(layer("water").paint["fill-color"], "#aad3f2");
  assert.equal(layer("road_trunk_primary").paint["line-color"], "#fff1c2");
  assert.equal(layer("road_motorway").paint["line-color"], "#fbd277");
});

test("라벨 글꼴에 이탤릭 없음 (한글 지명이 기울어 보이지 않게)", () => {
  for (const l of style.layers) for (const f of l.layout?.["text-font"] || []) assert.ok(!/Italic/.test(f), `${l.id}: ${f}`);
});

test("라벨은 한국어 이름 우선 (영문 병기 없음)", () => {
  const labels = style.layers.filter((l) => l.layout?.["text-field"] && !/shield|one_way/.test(l.id));
  assert.ok(labels.length > 10);
  for (const l of labels) assert.deepEqual(l.layout["text-field"], ["coalesce", ["get", "name:ko"], ["get", "name"]], l.id);
});
