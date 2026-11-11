// 메뉴판 사진 — 분류 점수(menuScore), 원문 날짜 전달(rankImages), /api/menu 라우트 (네트워크는 가짜)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { menuScore, MENU_MIN } from "../lib/vision.mjs";
import { rankImages } from "../lib/photos.mjs";

const LABELS = readFileSync(new URL("../models/imagenet-labels.txt", import.meta.url), "utf8").trim().split("\n").map((l) => l.slice(10).split(",")[0].trim());

test("menuScore: ImageNet 'menu' 클래스 확률을 그대로 쓴다, 기준값 0.3", () => {
  const p = new Array(1000).fill(0);
  p[LABELS.indexOf("menu")] = 0.42;
  assert.equal(menuScore(p), 0.42);
  assert.equal(menuScore(null), null);
  assert.equal(MENU_MIN, 0.3);
});

test("rankImages: 이미지 원문 글 날짜를 함께 돌려준다 (가격 시점 표기용)", () => {
  const store = { merNm: "테스트식당", merAddr: "서울 종로구 종로 1 (종로1가)", lat: 37.57, lng: 126.99 };
  const images = [{ collection: "blog", doc_url: "https://blog.example/1", image_url: "https://img.example/1.jpg", thumbnail_url: "https://img.example/t.jpg", width: "600", height: "600", datetime: "2025-04-12T10:00:00.000+09:00" }];
  const texts = [{ url: "https://blog.example/1", title: "테스트식당 메뉴판", contents: "테스트식당 서울 종로구 종로 1 메뉴" }];
  const r = rankImages({ store, place: null, images, texts });
  assert.equal(r.ranked[0].date, "2025-04-12");
});

// ---------- 라우트 ----------
process.env.VERCEL = "1";
process.env.KAKAO_REST_KEY = "test-kakao";
const imageQueries = [];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  const q = u.searchParams.get("query") || "";
  const ok = (documents) => new Response(JSON.stringify({ documents }), { status: 200 });
  if (u.pathname.includes("/local/search/keyword")) return ok([]);
  if (u.pathname.includes("/search/image")) {
    imageQueries.push(q);
    // 썸네일이 카카오 CDN 이 아니면 이미지 분석을 하지 않는다 → 메뉴판으로 인정되지 않는다
    return ok([{ collection: "blog", doc_url: "https://blog.example/m", image_url: "https://img.example/m.jpg", thumbnail_url: "https://img.example/m_t.jpg", width: "600", height: "600", datetime: "2025-04-12T10:00:00.000+09:00" }]);
  }
  if (u.pathname.includes("/search/blog")) return ok([{ url: "https://blog.example/m", title: "메뉴식당 메뉴판", contents: "메뉴식당 서울 종로구 종로 1 메뉴판 소주 5,000원" }]);
  return new Response("not found", { status: 404 });
};
const { handleApi } = await import("../lib/relay.mjs");
const params = (name) => new URLSearchParams({ name, addr: "서울 종로구 종로 1 (종로1가)", tel: "", lat: "37.57", lng: "126.99" });

test("/api/menu: 상호 + 구 + '메뉴판' 으로 검색하고, 메뉴판 판정을 못 하면 빈 목록", async () => {
  const r = await handleApi("/api/menu", params("주식회사 메뉴식당"), {});
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.query, "메뉴식당 종로 메뉴판");
  assert.deepEqual(j.images, []);
  assert.match(r.headers["cache-control"], /s-maxage=604800/);
  assert.ok(imageQueries.includes("메뉴식당 종로 메뉴판"));
});

test("/api/menu: 필수 값이 없으면 400, 키가 없으면 501", async () => {
  assert.equal((await handleApi("/api/menu", new URLSearchParams({ name: "x" }), {})).status, 400);
  delete process.env.KAKAO_REST_KEY;
  assert.equal((await handleApi("/api/menu", params("메뉴식당"), {})).status, 501);
  process.env.KAKAO_REST_KEY = "test-kakao";
});
