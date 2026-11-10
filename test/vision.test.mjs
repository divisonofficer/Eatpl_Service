// 사진 내용 판정 규칙 (모델 추론 없이 judge 만) — 기준값 회귀 방지
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { judge, FACE_SCORE, FACE_AREA, NEG_SUM } from "../lib/vision.mjs";

const LABELS = readFileSync(new URL("../models/imagenet-labels.txt", import.meta.url), "utf8").trim().split("\n").map((l) => l.slice(10).split(",")[0].trim());
const prob = (pairs) => {
  const p = new Array(1000).fill(0);
  let rest = 1;
  for (const [name, v] of pairs) {
    p[LABELS.indexOf(name)] = v;
    rest -= v;
  }
  p[LABELS.indexOf("restaurant")] += rest; // 나머지는 식당
  return p;
};

test("기준값", () => {
  assert.equal(FACE_SCORE, 0.97);
  assert.equal(FACE_AREA, 0.03);
  assert.equal(NEG_SUM, 0.3);
});

test("얼굴: 크고 확실한 얼굴만 탈락 (실내 작은 손님·간판 오탐은 통과)", () => {
  const p = prob([["hot pot", 0.8]]);
  assert.equal(judge({ faces: [{ s: 1.0, a: 0.225 }], prob: p }).reason, "face"); // 방송 캡처 (부촌 #0)
  assert.equal(judge({ faces: [{ s: 0.95, a: 0.004 }], prob: p }).ok, true); // 실내 손님 (#21)
  assert.equal(judge({ faces: [{ s: 0.8, a: 0.317 }], prob: p }).ok, true); // 간판 오탐 (#5)
  assert.equal(judge({ faces: [{ s: 0.95, a: 0.035 }], prob: p }).ok, true); // 음식 오탐 (#48)
});

test("엉뚱한 사진: 스티커·제품·문서류 확률 합 ≥ 0.3 이면 탈락", () => {
  assert.equal(judge({ faces: [], prob: prob([["wall clock", 0.3], ["envelope", 0.14]]) }).reason, "offtopic"); // 캐릭터 스티커
  assert.equal(judge({ faces: [], prob: prob([["packet", 0.3], ["sunscreen", 0.25]]) }).reason, "offtopic"); // 요거트 제품
  assert.equal(judge({ faces: [], prob: prob([["menu", 0.98]]) }).ok, true); // 메뉴판은 통과
  assert.equal(judge({ faces: [], prob: prob([["streetcar", 0.87]]) }).ok, true); // 가게 외관이 전차로 오인돼도 통과
});
