// 사진 검색어 개선 — 브랜드명 후보(nameVariants) + 카카오 장소 재매칭(resolveStore, /api/photos 경유)
// 네트워크는 가짜(fetch 스텁). VERCEL 환경으로 로드해 디스크 캐시(.cache)를 건드리지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nameVariants } from "../lib/photos.mjs";

test("nameVariants: 회사명 토큰·법인 표기·지점명을 떼고 브랜드명 후보를 만든다", () => {
  assert.deepEqual(nameVariants("(주)보돌에프엔비 보돌미역 종로타워점"), ["보돌미역", "보돌에프엔비 보돌미역"]);
  assert.deepEqual(nameVariants("주식회사 엄용백(엄용백돼지구이집광화문점)"), ["엄용백"]);
  assert.deepEqual(nameVariants("깐부치킨 충정로역점"), ["깐부치킨"]);
  assert.deepEqual(nameVariants("양촌리(길동점)"), ["양촌리"]);
});

test("nameVariants: 'A/B' 복합명은 조각별 후보, 전각 （주）도 제거", () => {
  assert.deepEqual(nameVariants("송추가마골인어반/동경（주）광화문지점"), ["송추가마골인어반/동경", "송추가마골인어반", "동경"]);
});

test("nameVariants: 단어 하나뿐인 회사형 이름은 지우지 않고, 짧은 조각·중복은 버린다", () => {
  assert.deepEqual(nameVariants("한우푸드"), ["한우푸드"]);
  assert.deepEqual(nameVariants("부촌"), ["부촌"]);
  assert.deepEqual(nameVariants("A/B"), ["A/B"]); // 1글자 조각 제외
  assert.equal(nameVariants("완백부대찌개 고사리 꽃삼겹 맛집 본점 신관", 2).length, 2); // 최대 개수
  assert.deepEqual(nameVariants(""), []);
});

// ---------- 라우트: 첫 매칭 실패 → 브랜드명 + 구로 재매칭 → 정식 상호로 검색 ----------
process.env.VERCEL = "1";
process.env.KAKAO_REST_KEY = "test-kakao";

const LAT = 37.57, LNG = 126.99;
const local = []; // 카카오 장소 검색에 들어간 검색어
const searched = []; // 이미지 검색에 들어간 검색어
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const q = u.searchParams.get("query") || "";
  const ok = (documents) => new Response(JSON.stringify({ documents }), { status: 200 });
  if (u.pathname.includes("/local/search/keyword")) {
    local.push(q);
    // 가짜 카카오: "보돌미역 종로구" 로 찾을 때만 장소가 나온다 (사업자명 그대로는 못 찾음)
    if (q === "보돌미역 종로구")
      return ok([{ id: "1", place_name: "보돌미역 종로타워점", category_group_code: "FD6", x: String(LNG), y: String(LAT), road_address_name: "서울 종로구 종로 1", address_name: "서울 종로구 종로1가 1", phone: "" }]);
    if (q.startsWith("잘되는집"))
      return ok([{ id: "2", place_name: "잘되는집", category_group_code: "FD6", x: String(LNG), y: String(LAT), road_address_name: "서울 종로구 종로 1", address_name: "서울 종로구 종로1가 1", phone: "" }]);
    return ok([]);
  }
  const brand = q.split(" ")[0];
  if (u.pathname.includes("/search/image")) {
    searched.push(q);
    return ok([{ collection: "blog", doc_url: `https://blog.example/${brand}`, image_url: `https://img.example/${brand}.jpg`, thumbnail_url: `https://img.example/${brand}_t.jpg`, width: "600", height: "600", display_sitename: "블로그" }]);
  }
  if (u.pathname.includes("/search/blog")) {
    return ok([{ url: `https://blog.example/${brand}`, title: `${brand} 후기`, contents: `${brand} 서울 종로구 종로 1 맛있어요` }]);
  }
  return new Response("not found", { status: 404 });
};

const { handleApi } = await import("../lib/relay.mjs");
const params = (name) => new URLSearchParams({ name, addr: "서울 종로구 종로 1 (종로1가)", tel: "", lat: String(LAT), lng: String(LNG) });

test("photos: 사업자명으로 장소를 못 찾으면 브랜드명으로 다시 찾아 정식 상호로 검색한다", async () => {
  const r = await handleApi("/api/photos", params("(주)보돌에프엔비 보돌미역 종로타워점"), {});
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.place?.name, "보돌미역 종로타워점");
  assert.equal(j.query, "보돌미역 종로");
  assert.ok(j.images.length >= 1, "정식 상호 검색으로 사진이 나와야 한다");
  assert.ok(local.includes("보돌미역 종로구"));
});

test("photos: 첫 매칭이 성공한 매장은 검색어가 바뀌지 않고 추가 장소 검색도 없다", async () => {
  const before = local.length;
  const r = await handleApi("/api/photos", params("잘되는집"), {});
  const j = JSON.parse(r.body);
  assert.equal(j.query, "잘되는집 종로");
  assert.equal(local.length - before, 1, "장소 검색은 1회만");
});

test("photos: 후보로도 못 찾으면 원래 이름 그대로 검색 (장소 검색은 최대 1 + 3회)", async () => {
  const before = local.length;
  const r = await handleApi("/api/photos", params("어디에도없는식당 본관 신관 별관"), {});
  const j = JSON.parse(r.body);
  assert.equal(j.place, null);
  assert.ok(j.query.startsWith("어디에도없는식당"));
  assert.ok(local.length - before <= 4);
});
