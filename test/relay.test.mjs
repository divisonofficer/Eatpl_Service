// /api/amenities 라우트 스모크 — 네트워크는 가짜(fetch 스텁). 디스크 캐시(.cache)를 건드리지 않도록 VERCEL 환경으로 로드.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.VERCEL = "1";
process.env.KAKAO_REST_KEY = "test-kakao";
delete process.env.EXAONE_API_KEY;
delete process.env.ROOM_VERIFY;

const calls = [];
let exaoneBody = '[{"id":1,"room":"no"}]';
let exaoneFail = 0; // 앞으로 N번은 500 (서비스 일시 장애)
globalThis.fetch = async (url, init) => {
  const u = String(url);
  calls.push(u);
  if (u.includes("api.exaone.ai") && exaoneFail > 0) {
    exaoneFail--;
    return new Response('{"error":{"message":"temporary"}}', { status: 500 });
  }
  if (u.includes("api.exaone.ai")) {
    return new Response(JSON.stringify({ choices: [{ message: { content: exaoneBody } }], usage: { total_tokens: 5 } }), {
      status: 200,
      headers: { "x-day-rate-limit-remaining": "50" },
    });
  }
  // 카카오: 블로그 검색 → 이 가게 글 1건 (이름 + 도로명 주소 일치 → verified), 장소 검색은 비움
  // 검색어(가게 이름 + 도로/동)의 가게 이름을 그대로 글에 쓴다 → 테스트마다 가게 이름이 달라도 '이 가게 글'로 인정된다
  const store = decodeURIComponent(new URL(u).searchParams.get("query") || "").split(" ")[0];
  const docs = u.includes("/search/blog")
    ? [{ url: `https://blog.example/${store}`, title: `${store} 후기`, contents: `${store} 서울 종로구 종로 1 룸이 있어요 단체 회식하기 좋아요` }]
    : [];
  return new Response(JSON.stringify({ documents: docs }), { status: 200 });
};

const { handleApi } = await import("../lib/relay.mjs");
const params = (name, extra = {}) =>
  new URLSearchParams({ name, addr: "서울 종로구 종로 1 (종로1가)", tel: "", lat: "37.57", lng: "126.99", ...extra });

test("amenities: 기본 호출이 200 이고 규칙 기반 룸 있음을 돌려준다", async () => {
  const r = await handleApi("/api/amenities", params("테스트식당"), {});
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.amenitiesFull, true);
  assert.equal(j.amenities.room.state, "yes");
});

test("amenities: 필수 값이 없으면 400", async () => {
  const r = await handleApi("/api/amenities", new URLSearchParams({ name: "x" }), {});
  assert.equal(r.status, 400);
});

test("verify: 키가 없으면 규칙 결과로 폴백하고 CDN 에 캐시하지 않는다", async () => {
  const r = await handleApi("/api/amenities", params("폴백식당", { verify: "1" }), {});
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.verified, false);
  assert.equal(j.reason, "no-key");
  assert.equal(j.room.state, "yes");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(!calls.some((u) => u.includes("api.exaone.ai")), "키 없이 모델을 호출하면 안 된다");
});

test("verify: 모델이 '없음'으로 판정하면 룸 없음으로 바로잡고 성공 결과만 캐시한다", async () => {
  process.env.EXAONE_API_KEY = "test-exaone";
  const r = await handleApi("/api/amenities", params("검증식당", { verify: "1" }), {});
  const j = JSON.parse(r.body);
  assert.equal(j.verified, true);
  assert.equal(j.room.state, "no");
  assert.match(r.headers["cache-control"], /s-maxage=/);
  const before = calls.filter((u) => u.includes("api.exaone.ai")).length;
  const again = await handleApi("/api/amenities", params("검증식당", { verify: "1" }), {});
  assert.equal(again.headers["x-cache"], "HIT");
  assert.equal(calls.filter((u) => u.includes("api.exaone.ai")).length, before, "캐시 적중 시 모델 재호출 금지");
});

test("verify: 모델 출력이 깨지면 폴백(캐시 안 함)", async () => {
  process.env.EXAONE_API_KEY = "test-exaone";
  exaoneBody = "잘 모르겠어요";
  const r = await handleApi("/api/amenities", params("깨짐식당", { verify: "1" }), {});
  const j = JSON.parse(r.body);
  assert.equal(j.verified, false);
  assert.equal(j.reason, "bad-output");
  assert.equal(r.headers["cache-control"], "no-store");
});

test("verify: 5xx 한 번은 재시도해 성공, 연속 실패는 폴백(캐시 안 함)", async () => {
  process.env.EXAONE_API_KEY = "test-exaone";
  exaoneBody = '[{"id":1,"room":"no"}]';
  exaoneFail = 1;
  const ok = await handleApi("/api/amenities", params("재시도식당", { verify: "1" }), {});
  assert.equal(JSON.parse(ok.body).verified, true);
  exaoneFail = 2;
  const bad = await handleApi("/api/amenities", params("장애식당", { verify: "1" }), {});
  const j = JSON.parse(bad.body);
  assert.equal(j.verified, false);
  assert.equal(j.reason, "error");
  assert.equal(j.room.state, "yes");
  assert.equal(bad.headers["cache-control"], "no-store");
});

test("verify: ROOM_VERIFY=off 면 모델을 부르지 않는다", async () => {
  process.env.EXAONE_API_KEY = "test-exaone";
  process.env.ROOM_VERIFY = "off";
  const before = calls.filter((u) => u.includes("api.exaone.ai")).length;
  const r = await handleApi("/api/amenities", params("꺼짐식당", { verify: "1" }), {});
  assert.equal(JSON.parse(r.body).reason, "off");
  assert.equal(calls.filter((u) => u.includes("api.exaone.ai")).length, before);
  delete process.env.ROOM_VERIFY;
});
