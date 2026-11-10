// node --test  — 사진 필터 엔진(lib/photos.mjs) 회귀 테스트. 실데이터 조사에서 나온 함정 사례를 고정한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { storeKeys, verifyText, matchPlace, rankImages, normUrl } from "../lib/photos.mjs";

const store = (o) => ({ merNm: "", merAddr: "", merTpno: "", lat: 37.57, lng: 126.99, ...o });
const doc = (title, contents, url = "https://blog.naver.com/a/1") => ({ title, contents, url });

test("storeKeys: 법인명 제거·지점 분리·약한 이름", () => {
  const k1 = storeKeys(store({ merNm: "양촌리(길동점)", merAddr: "서울 강동구 천호대로 1108 전층 (성내동)" }));
  assert.equal(k1.core, "양촌리");
  assert.equal(k1.branchSq, "길동점");
  assert.equal(k1.dongSq, "성내동");
  assert.deepEqual(k1.addrKeys, [{ kind: "road", key: "천호대로1108" }]);

  const k2 = storeKeys(store({ merNm: "깐부치킨 충정로역점", merAddr: "서울 중구 서소문로 38 1층 101호 (중림동,대우디오센터)" }));
  assert.equal(k2.core, "깐부치킨");
  assert.equal(k2.branchSq, "충정로역점");

  assert.equal(storeKeys(store({ merNm: "주식회사 트리거", merAddr: "서울 강남구 강남대로98길 12 4층 (역삼동)" })).weakName, true);
  assert.equal(storeKeys(store({ merNm: "부촌", merAddr: "서울 종로구 종로 200-12 ,1층 (종로4가)" })).weakName, true); // 2글자
});

test("storeKeys: 무효 전화번호(0000/1111) 제외, 카카오 지번 키 추가", () => {
  const k = storeKeys(
    store({ merNm: "쭈노치킨가게", merAddr: "서울 중구 마른내로 43 (초동)", merTpno: "02-0000-0000" }),
    { address_name: "서울 중구 초동 19-3", road_address_name: "서울 중구 마른내로 43", phone: "02-2279-5977" }
  );
  assert.deepEqual(k.phones, [["02", "2279", "5977"]]);
  assert.ok(k.addrKeys.some((a) => a.kind === "jibun" && a.key === "초동193"));
});

test("verifyText: 이름+도로명 일치 → verified", () => {
  const k = storeKeys(store({ merNm: "종로수정식당", merAddr: "서울 종로구 삼일대로20길 15 지상1,2층(관수동)" }));
  const v = verifyText(doc("종로 관수동 수정식당", "주소 서울특별시 종로구 삼일대로20길 15 전화 ..."), k);
  // 블로그는 '수정식당'으로 줄여 부를 수 있지만 core 는 '종로수정식당' → 이름 불일치면 verified 아님
  assert.notEqual(v.level, "verified");
  const v2 = verifyText(doc("종로수정식당 후기", "서울 종로구 삼일대로20길 15"), k);
  assert.equal(v2.level, "verified");
  assert.ok(v2.evidence.includes("road"));
});

test("verifyText: 동명이점 — 글의 주소가 우리 주소와 다르면 conflict (나루토 사례)", () => {
  const k = storeKeys(store({ merNm: "나루토", merAddr: "서울 마포구 독막로9길 26 지1층(서교동)" }));
  const v = verifyText(doc("서교동 꼬치요리 나루토 오모테나시", "나루토 오모테나시 서울특별시 마포구 독막로5길 17 1층"), k);
  assert.equal(v.level, "conflict");
});

test("verifyText: 번지 경계 — 200-1 은 200-12 와 다르다", () => {
  const k = storeKeys(store({ merNm: "가나다식당", merAddr: "서울 종로구 종로 200-1 (종로4가)" }));
  const v = verifyText(doc("가나다식당", "서울 종로구 종로 200-12 1층"), k);
  assert.notEqual(v.level, "verified");
});

test("verifyText: 전화번호 일치만으로도 주소 근거 인정", () => {
  const k = storeKeys(store({ merNm: "매일스시횟집", merAddr: "서울 마포구 숭문길 34 ,1층 (염리동)" }), { phone: "02-3273-8289" });
  const v = verifyText(doc("매일스시횟집 방문", "예약 02) 3273-8289"), k);
  assert.equal(v.level, "verified");
  assert.ok(v.evidence.includes("phone"));
});

test("verifyText: 인물·방송 위험 글은 risky (주소가 맞아도 제외)", () => {
  const k = storeKeys(store({ merNm: "카미야", merAddr: "서울 마포구 와우산로21길 28-6 지하1층(서교동)" }));
  const v = verifyText(doc("홍대 카미야 또간집 풍자 추천", "서울 마포구 와우산로21길 28-6"), k);
  assert.equal(v.level, "risky");
});

test("matchPlace: 150m 밖이거나 이름이 다르면 매칭 안 함, 여럿이면 가까운 순", () => {
  const s = store({ merNm: "양촌리(길동점)", lat: 37.53483, lng: 127.13449 });
  const near = { place_name: "양촌리 길동점", category_group_code: "FD6", x: "127.13449", y: "37.53483", id: "2" };
  const far = { place_name: "양촌리", category_group_code: "FD6", x: "127.15", y: "37.53483", id: "1" };
  const other = { place_name: "다른집", category_group_code: "FD6", x: "127.13449", y: "37.53483", id: "3" };
  assert.equal(matchPlace(s, [far, other, near]).id, "2");
  assert.equal(matchPlace(s, [far, other]), null);
});

test("normUrl: http/https·m.·PostView 형태를 같은 글로 본다", () => {
  const a = normUrl("http://blog.naver.com/abc/123");
  assert.equal(normUrl("https://m.blog.naver.com/abc/123"), a);
  assert.equal(normUrl("https://blog.naver.com/PostView.naver?blogId=abc&logNo=123"), a);
});

test("rankImages: 결정론 + 필터 규칙 (컬렉션·크기·비율·중복·텍스트 없음)", () => {
  const s = store({ merNm: "형제네고기마을", merAddr: "서울 종로구 새문안로3길 36, 106 (내수동, 용비어천가106호)" });
  const ok = "https://blog.naver.com/a/1";
  const img = (o) => ({ collection: "blog", width: 800, height: 600, doc_url: ok, image_url: `https://img/${Math.random()}`, thumbnail_url: "t", display_sitename: "네이버블로그", ...o });
  const images = [
    img({ image_url: "https://img/1" }),
    img({ image_url: "https://img/1?type=w2" }), // 중복 (쿼리만 다름)
    img({ image_url: "https://img/2", collection: "news" }),
    img({ image_url: "https://img/3", width: 200, height: 200 }),
    img({ image_url: "https://img/4", width: 300, height: 900 }), // 비율
    img({ image_url: "https://img/5", doc_url: "https://blog.naver.com/zz/9" }), // 텍스트 없음
    img({ image_url: "https://img/6", width: 600, height: 900 }), // 세로 → 카드 O, 핀 X
  ];
  const texts = [doc("[종로구 내수동] 형제네고기마을", "서울 종로구 새문안로3길 36", ok)];
  const r1 = rankImages({ store: s, place: null, images, texts });
  const r2 = rankImages({ store: s, place: null, images, texts });
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1.ranked.map((x) => x.image), ["https://img/1", "https://img/6"]);
  assert.equal(r1.pin.image, "https://img/1");
  assert.deepEqual(r1.rejected, { dup: 1, "collection:news": 1, small: 1, aspect: 1, "no-text": 1 });
});
