// 예약 힌트(블로그 언급) + 화면용 예약 링크
import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeReserve } from "../lib/reserve.mjs";
import { telHref, naverMapSearchUrl, safeCatchtable, reserveHint } from "../js/reserve-fmt.js";

const doc = (n, contents) => ({ url: `https://blog.example/${n}`, title: "", contents });

test("예약 채널 언급을 글 단위로 센다 (같은 글 중복 제외)", () => {
  const docs = [
    doc(1, "네이버 예약하고 갔어요"),
    doc(2, "캐치테이블로 예약 성공"),
    doc(3, "네이버예약 할인 받았어요 캐치 테이블도 됨"),
    doc(3, "중복 글"),
    doc(4, "그냥 맛있어요"),
  ];
  const r = summarizeReserve(docs);
  assert.deepEqual(r.channels, [
    { k: "catchtable", label: "캐치테이블", count: 2 },
    { k: "naver", label: "네이버 예약", count: 2 },
  ]);
  assert.equal(r.catchtable, null);
});

test("예약 권장 / 예약 없이 이용 언급", () => {
  const r = summarizeReserve([doc(1, "주말엔 예약 필수예요"), doc(2, "예약하시는 걸 추천해요"), doc(3, "예약 없이 바로 들어갔어요")]);
  assert.equal(r.recommend, 2);
  assert.equal(r.walkin, 1);
});

test("캐치테이블 매장 링크는 주소·전화까지 맞은 글(linkDocs)에서만", () => {
  const link = "https://app.catchtable.co.kr/ct/shop/sushiichi_gwanghwamun";
  const withLink = doc(1, `예약은 ${link}?from=share 여기서`);
  assert.equal(summarizeReserve([withLink]).catchtable, null, "이름만 맞은 글의 링크는 쓰지 않는다");
  assert.equal(summarizeReserve([withLink], { linkDocs: [withLink] }).catchtable, link);
});

test("빈 입력 안전", () => {
  assert.deepEqual(summarizeReserve(undefined), { channels: [], recommend: 0, walkin: 0, catchtable: null });
});

test("telHref: 국내 번호만, 가짜 번호 제외", () => {
  assert.equal(telHref("02-123-4567"), "tel:021234567");
  assert.equal(telHref("010-1234-5678"), "tel:01012345678");
  assert.equal(telHref("031-1234-5678"), "tel:03112345678");
  assert.equal(telHref("02-000-0000"), null);
  assert.equal(telHref("1588-1234"), null);
  assert.equal(telHref(""), null);
  assert.equal(telHref(undefined), null);
  assert.equal(telHref("javascript:alert(1)"), null);
});

test("naverMapSearchUrl: 이름 + 동을 인코딩", () => {
  assert.equal(naverMapSearchUrl("보돌미역 종로타워점", "종로2가"), "https://map.naver.com/p/search/" + encodeURIComponent("보돌미역 종로타워점 종로2가"));
  assert.equal(naverMapSearchUrl("부촌", ""), "https://map.naver.com/p/search/" + encodeURIComponent("부촌"));
});

test("safeCatchtable: 캐치테이블 매장 주소 형식만 통과", () => {
  assert.equal(safeCatchtable("https://app.catchtable.co.kr/ct/shop/Kangbyul"), "https://app.catchtable.co.kr/ct/shop/Kangbyul");
  assert.equal(safeCatchtable("https://evil.example/ct/shop/x"), null);
  assert.equal(safeCatchtable("javascript:alert(1)"), null);
  assert.equal(safeCatchtable(null), null);
});

test("reserveHint: 언급이 있을 때만 한 줄", () => {
  assert.equal(reserveHint(null), "");
  assert.equal(reserveHint({ channels: [], recommend: 0, walkin: 0 }), "");
  assert.equal(reserveHint({ channels: [{ label: "네이버 예약", count: 3 }], recommend: 2, walkin: 0 }), "블로그 언급: 네이버 예약 3 · 예약 권장 2");
});
