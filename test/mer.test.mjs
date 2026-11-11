// 잇플 상세 '편의 서비스' 파서 + 공식 주차 여부 병합 규칙
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFacilities, MER_URL } from "../lib/mer.mjs";
import { mergeParking, amenityStates } from "../js/amenities-fmt.js";

// 실제 상세 페이지(2026-11) 마크업 발췌
const block = (items) => `<div class="service-wrap"> <p class="tit">편의 서비스</p> <ul class="service-list">${items} </ul> </div>`;
const li = (ico, text) => ` <li class="item"> <span class="ico"><img src="https://cdn.paybooc.co.kr/static/assets/out/merchant/images/ico-${ico}.svg" alt=""></span> <span>${text}</span> </li>`;

test("주차가능·불가·와이파이를 읽는다", () => {
  assert.deepEqual(parseFacilities(block(li("wifi-on", "WI-FI 제공") + li("parking-on", "주차가능"))), { parking: "yes", wifi: "yes" });
  assert.deepEqual(parseFacilities(block(li("wifi-on", "WI-FI 제공") + li("parking-off", "주차불가"))), { parking: "no", wifi: "yes" });
  assert.deepEqual(parseFacilities(block(li("parking-off", "주차불가"))), { parking: "no", wifi: null });
});

test("항목이 없으면 null (없음으로 단정하지 않는다)", () => {
  assert.deepEqual(parseFacilities(block("")), { parking: null, wifi: null });
  assert.deepEqual(parseFacilities("<html></html>"), { parking: null, wifi: null });
  assert.deepEqual(parseFacilities(""), { parking: null, wifi: null });
  assert.deepEqual(parseFacilities(undefined), { parking: null, wifi: null });
});

test("목록 블록이 없으면 noscript 요약 '주차: 가능|불가' 로 보완", () => {
  assert.equal(parseFacilities("<noscript>wifi: 제공<br>주차: 가능<br>이용자 리뷰 요약: ...</noscript>").parking, "yes");
  assert.equal(parseFacilities("<noscript>주차: 불가<br></noscript>").parking, "no");
});

test("다른 서비스 아이콘이 섞여도 주차만 골라낸다", () => {
  const h = block(li("pet-on", "반려동물 동반") + li("parking-on", "주차가능"));
  assert.equal(parseFacilities(h).parking, "yes");
});

test("MER_URL: 잇플 프로필 주소만 허용 (임의 주소 중계 금지)", () => {
  assert.ok(MER_URL.test("https://web.paybooc.ai/mer/web/profile/3x5ATwfSkOmIcXDE2Q2MDg"));
  assert.ok(!MER_URL.test("http://web.paybooc.ai/mer/web/profile/abc"));
  assert.ok(!MER_URL.test("https://evil.example/mer/web/profile/abc"));
  assert.ok(!MER_URL.test("https://web.paybooc.ai/mer/web/profile/abc/../../x"));
  assert.ok(!MER_URL.test("https://web.paybooc.ai.evil.com/mer/web/profile/abc"));
  assert.ok(!MER_URL.test("https://web.paybooc.ai/mer/web/profile/abc?x=1"));
});

test("병합: 공식 '가능'은 블로그의 '없음·인근 주차장·언급 없음'을 바로잡는다", () => {
  for (const blog of [{ state: "no" }, { state: "nearby" }, undefined, null]) {
    assert.deepEqual(mergeParking(blog, "yes"), { state: "yes", official: true });
    assert.equal(amenityStates({ parking: mergeParking(blog, "yes") }).park, "yes");
  }
});

test("병합: 공식 '가능' + 블로그에 구체 정보(발렛·무료 시간)가 있으면 그 정보를 유지", () => {
  const valet = { state: "valet" }, free = { state: "free", hours: 2 };
  assert.equal(mergeParking(valet, "yes"), valet);
  assert.equal(mergeParking(free, "yes"), free);
});

test("병합: 공식 '불가'는 블로그의 '가능'을 덮되 발렛은 유지", () => {
  assert.deepEqual(mergeParking({ state: "free", hours: 2 }, "no"), { state: "no", official: true });
  assert.deepEqual(mergeParking({ state: "yes" }, "no"), { state: "no", official: true });
  const valet = { state: "valet" };
  assert.equal(mergeParking(valet, "no"), valet);
});

test("병합: 공식 값이 없으면 블로그 추정 그대로", () => {
  const b = { state: "paid" };
  assert.equal(mergeParking(b, null), b);
  assert.equal(mergeParking(undefined, null), undefined);
});
