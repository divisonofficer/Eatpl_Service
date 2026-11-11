// 법인(사업자)명 표기 제거 — 정규식 기반. 실제 잇플 가맹점명 형태 포함
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, isLegalName } from "../js/legal-name.js";
import { storeKeys } from "../lib/photos.mjs";

test("법인 형태 표기를 떼고 상호만 남긴다", () => {
  assert.equal(cleanName("주식회사 달그리고나무"), "달그리고나무");
  assert.equal(cleanName("달그리고나무 주식회사"), "달그리고나무");
  assert.equal(cleanName("(주)신화푸드"), "신화푸드");
  assert.equal(cleanName("신화푸드(주)"), "신화푸드");
  assert.equal(cleanName("㈜한림정"), "한림정");
  assert.equal(cleanName("유한회사 맛나식당"), "맛나식당");
  assert.equal(cleanName("농업회사법인 들녘 주식회사"), "들녘");
});

test("전각 괄호 （주）도 처리 (실데이터: 송추가마골인어반/동경（주）)", () => {
  assert.equal(cleanName("송추가마골인어반/동경（주）"), "송추가마골인어반/동경");
  assert.equal(cleanName("（주）한우마을"), "한우마을");
  assert.equal(cleanName("( 주 ) 한우마을"), "한우마을");
});

test("지점명 괄호·일반 이름은 그대로", () => {
  assert.equal(cleanName("양촌리(길동점)"), "양촌리(길동점)");
  assert.equal(cleanName("깐부치킨 충정로역점"), "깐부치킨 충정로역점");
  assert.equal(cleanName("부촌"), "부촌");
  assert.equal(cleanName("주식당"), "주식당"); // '주식' 만으로는 법인 표기가 아님
  assert.equal(cleanName("주식회사식당"), "식당"); // 표기 자체가 이름 앞에 붙은 형태는 제거
});

test("전부 지워지면 원본 유지, 빈 값 안전", () => {
  assert.equal(cleanName("(주)"), "(주)");
  assert.equal(cleanName("주식회사"), "주식회사");
  assert.equal(cleanName(""), "");
  assert.equal(cleanName(null), "");
  assert.equal(cleanName(undefined), "");
});

test("가장자리에 남은 구분 기호 정리", () => {
  assert.equal(cleanName("주식회사 / 맛집"), "맛집");
  assert.equal(cleanName("맛집 - (주)"), "맛집");
});

test("isLegalName: 반복 호출에도 결과가 같다 (g 플래그 lastIndex 함정 방지)", () => {
  for (let i = 0; i < 3; i++) {
    assert.equal(isLegalName("주식회사 달그리고나무"), true);
    assert.equal(isLegalName("부촌"), false);
    assert.equal(isLegalName("한림정（주）"), true);
  }
});

test("서버 검색 키(storeKeys)도 같은 정규식 — 전각 표기 법인명이 약한 이름으로 분류되고 core 는 상호", () => {
  const k = storeKeys({ merNm: "한우마을（주）", merAddr: "서울 종로구 종로 1 (종로1가)" });
  assert.equal(k.core, "한우마을");
  assert.equal(k.weakName, true);
  const k2 = storeKeys({ merNm: "주식회사 달그리고나무", merAddr: "서울 종로구 종로 1 (종로1가)" });
  assert.equal(k2.core, "달그리고나무");
});
