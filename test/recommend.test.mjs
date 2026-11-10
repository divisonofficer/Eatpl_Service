// 추천 엔진 — 결정론·제외 조건·핵심 신호
import { test } from "node:test";
import assert from "node:assert/strict";
import { recommend, openDuring, topReasons } from "../js/recommend.js";

const base = { rank: 5, rankAll: 3, group: false, local: false, busyDay: "", busyTime: "", open: "1100", close: "2300", holidays: [], customers: ["20대여성", "30대여성", "20대남성"] };
const S = (o) => ({ ...base, ...o });
const ctx = (o) => ({ mode: "dinner", headcount: 8, day: "금", ...o });

test("영업 시간: 자정 넘김·24시간·결제 기준 여유", () => {
  assert.equal(openDuring(S({ open: "1700", close: "0200" }), 1800, 2100), true);
  assert.equal(openDuring(S({ open: "1100", close: "1500" }), 1800, 2100), false);
  assert.equal(openDuring(S({ open: "0600", close: "0559" }), 2200, 2400), true); // 사실상 24시간
  assert.equal(openDuring(S({ open: "1130", close: "1940" }), 1800, 2100), true); // 절반 이상
  assert.equal(openDuring(S({ open: "", close: "" }), 1800, 2100), true); // 정보 없음
});

test("제외: 고른 요일 휴무, 시간대 영업 안 함", () => {
  assert.equal(recommend(S({ holidays: ["금"] }), ctx()).blocked, "금 휴무");
  assert.equal(recommend(S({ open: "0700", close: "1500" }), ctx()).blocked, "저녁 영업 안 함");
  assert.equal(recommend(S({ open: "0700", close: "1500" }), ctx({ mode: "lunch" })).blocked, null);
});

test("30~50대 남성 단골·회식 적합이 순위를 끌어올린다", () => {
  const plain = recommend(S({ rank: 3 }), ctx());
  const office = recommend(S({ rank: 3, customers: ["30대남성", "40대남성", "20대여성"] }), ctx());
  const both = recommend(S({ rank: 3, group: true, customers: ["40대남성"] }), ctx());
  assert.ok(office.score > plain.score && both.score > office.score);
  assert.deepEqual(topReasons(both).good.map((r) => r.t), ["회식 적합", "30~50대 남성 단골"]);
  // 1위가 아니면 신호 없음
  assert.ok(!recommend(S({ customers: ["20대여성", "40대남성"] }), ctx()).reasons.some((r) => r.t.includes("남성 단골")));
});

test("붐빔: 같은 요일·시간대면 주의, 다른 시간대면 가산", () => {
  const busy = recommend(S({ busyDay: "금", busyTime: "저녁" }), ctx());
  assert.equal(topReasons(busy).warn.t, "금 저녁 붐빔 · 예약 권장");
  assert.ok(recommend(S({ busyTime: "점심" }), ctx()).reasons.some((r) => r.t === "저녁엔 덜 붐빔"));
});

test("인원 적으면 회식 적합 비중 ↓, 룸은 8명 이상에서 비중 ↑", () => {
  const g = (hc) => recommend(S({ group: true }), ctx({ headcount: hc })).reasons.find((r) => r.t === "회식 적합").w;
  assert.ok(g(8) > g(4) && g(4) > g(1));
  const room = (hc) => recommend(S({}), ctx({ headcount: hc, amenity: { room: "yes" } })).reasons.find((r) => r.t === "룸 있어요").w;
  assert.ok(room(12) > room(4));
});

test("거리·팀 연령대", () => {
  assert.ok(recommend(S({ dist: 200 }), ctx()).reasons.some((r) => r.t === "도보 3분"));
  assert.ok(recommend(S({}), ctx({ teamAges: new Set(["30대"]) })).reasons.some((r) => r.t === "우리 팀 또래 단골"));
});

test("결정론: 같은 입력이면 같은 결과", () => {
  const s = S({ group: true, busyTime: "저녁", customers: ["30대남성"], dist: 500 });
  assert.deepEqual(recommend(s, ctx({ amenity: { room: "yes", park: "no" } })), recommend(s, ctx({ amenity: { room: "yes", park: "no" } })));
});
