// 룸·콜키지·주차 추출 — 실측에서 나온 실제 블로그 문장 + 함정 사례
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRoom, extractCorkage, extractParking, summarizeAmenities, parseWon, fmtWon, roomLabel, corkLabel, parkLabel } from "../lib/amenities.mjs";

test("금액 파싱·표기", () => {
  assert.equal(parseWon("1", "만원"), 10000);
  assert.equal(parseWon("1.5", "만 원"), 15000);
  assert.equal(parseWon("5", "천원"), 5000);
  assert.equal(parseWon("10,000", "원"), 10000);
  assert.equal(fmtWon(10000), "1만원");
  assert.equal(fmtWon(15000), "1.5만원");
  assert.equal(fmtWon(5000), "5천원");
  assert.equal(fmtWon(300000), "30만원");
});

test("룸: 실제 문장 (안동장·상무초밥·종삼육·태양)", () => {
  assert.equal(extractRoom("1층과 2층은 일반 손님, 3·4층은 룸으로 구성되어 있어 다양한 자리 선택이 가능해요")?.state, "yes");
  assert.equal(extractRoom("2층에는 별도 룸이 2개 있어서 저희는 2층 룸으로 !")?.state, "yes");
  assert.equal(extractRoom("가게정보: 3층 단독건물 업장. 단체석,룸 있음.")?.state, "yes");
  assert.equal(extractRoom("2층의 프라이빗 룸 태양 시청점 서울특별시 중구")?.state, "yes");
  assert.equal(extractRoom("회식하기 너무 좋고 프라이빗한 2층 VIP룸도 있었다는 점")?.state, "yes");
});

test("룸: 없음·잡음 단어", () => {
  assert.equal(extractRoom("룸은 없고 홀만 있어요")?.state, "no");
  assert.equal(extractRoom("레스트룸이 깨끗해요"), null);
  assert.equal(extractRoom("머쉬룸 리조또가 맛있어요"), null);
  assert.equal(extractRoom("룸살롱 아님"), null);
  assert.equal(extractRoom("쇼룸 같은 인테리어"), null);
});

test("룸 비용: 룸비·최소 주문·룸비 없음", () => {
  const a = extractRoom("단체룸 있음. 룸차지 1만원 따로 받아요");
  assert.equal(a.state, "yes");
  assert.deepEqual(a.fee, { won: 10000, per: "" });
  const b = extractRoom("룸 이용 시 최소 주문 금액은 30만원입니다");
  assert.equal(b.minOrder, 300000);
  assert.equal(extractRoom("룸비 없음, 예약만 하면 돼요").feeFree, true);
  assert.deepEqual(extractRoom("룸 사용료 인당 5천원").fee, { won: 5000, per: "인당" });
});

test("콜키지: 실제 문장 (북악정) + 상태", () => {
  assert.deepEqual(extractCorkage("와인한병 들고 갔는데 콜키지는 1만원이고 잔은 저기 사진에"), { state: "paid", won: 10000 });
  assert.deepEqual(extractCorkage("콜키지 프리라서 와인 들고 갔어요"), { state: "free" });
  assert.deepEqual(extractCorkage("콜키지 병당 2만원"), { state: "paid", won: 20000 });
  assert.deepEqual(extractCorkage("콜키지 10,000원 받습니다"), { state: "paid", won: 10000 });
  assert.deepEqual(extractCorkage("콜키지 불가 매장입니다"), { state: "no" });
  assert.deepEqual(extractCorkage("콜키지 가능한 고깃집"), { state: "yes" });
  assert.equal(extractCorkage("와인 리스트가 다양"), null);
});

test("주차: 발렛·무료 시간·가능·협소·불가·인근", () => {
  assert.deepEqual(extractParking("발렛 파킹 가능해서 편했어요"), { state: "valet" });
  assert.deepEqual(extractParking("건물 주차장 2시간 무료"), { state: "free", hours: 2 });
  assert.deepEqual(extractParking("주차 1시간 지원됩니다"), { state: "free", hours: 1 });
  assert.deepEqual(extractParking("주차: 가능"), { state: "yes" });
  assert.deepEqual(extractParking("전용 주차장 있어요"), { state: "yes" });
  assert.deepEqual(extractParking("주차 공간이 협소해요"), { state: "limited" });
  assert.deepEqual(extractParking("주차는 불가합니다"), { state: "no" });
  assert.deepEqual(extractParking("근처 공영주차장 이용하세요"), { state: "nearby" });
  assert.equal(extractParking("분위기가 좋아요"), null);
});

test("집계: 다수결 + 다르면 mixed, 같은 글은 1번만", () => {
  const docs = [
    { url: "a", title: "", contents: "콜키지는 1만원" },
    { url: "a", title: "", contents: "콜키지는 1만원" }, // 같은 글
    { url: "b", title: "", contents: "콜키지 1만원 받아요" },
    { url: "c", title: "", contents: "콜키지 프리" },
    { url: "d", title: "", contents: "3층은 룸으로 구성. 룸차지 2만원" },
    { url: "e", title: "", contents: "주차 2시간 무료" },
    { url: "f", title: "", contents: "주차 공간이 협소" },
    { url: "g", title: "", contents: "건물 주차장 2시간 무료" },
  ];
  const a = summarizeAmenities(docs);
  assert.deepEqual({ state: a.corkage.state, won: a.corkage.won, count: a.corkage.count, mixed: a.corkage.mixed }, { state: "paid", won: 10000, count: 2, mixed: true });
  assert.equal(a.room.state, "yes");
  assert.equal(a.room.fee.won, 20000);
  assert.deepEqual({ state: a.parking.state, hours: a.parking.hours, count: a.parking.count }, { state: "free", hours: 2, count: 2 });
  assert.equal(roomLabel(a.room), "룸 · 룸비 2만원");
  assert.equal(corkLabel(a.corkage), "콜키지 1만원");
  assert.equal(parkLabel(a.parking), "주차 2시간 무료");
  // 결정론: 입력 순서가 같으면 결과도 같다
  assert.deepEqual(summarizeAmenities(docs), a);
});

test("유료: 주차 유료·발렛비·콜키지 유료(금액 없이)", () => {
  assert.deepEqual(extractParking("주차는 유료예요"), { state: "paid" });
  assert.deepEqual(extractParking("주차비 시간당 3,000원"), { state: "paid" });
  assert.deepEqual(extractParking("발렛비 3천원 받아요"), { state: "valet", paid: true });
  assert.deepEqual(extractParking("근처 유료주차장 이용"), { state: "nearby" });
  assert.deepEqual(extractCorkage("유아의자 있음 콜키지 유료(병당 1만원)"), { state: "paid", won: 10000 });
  assert.deepEqual(extractCorkage("콜키지 유료"), { state: "paid", won: null });
  assert.equal(corkLabel({ state: "paid", won: null }), "콜키지 유료");
  assert.equal(parkLabel({ state: "paid" }), "유료 주차");
});
