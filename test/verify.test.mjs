// 룸 검증(K-EXAONE) — 모델은 가짜로 주입. 발췌 선택·프롬프트·출력 파싱·집계 규칙
import { test } from "node:test";
import assert from "node:assert/strict";
import { roomSnippets, buildPrompt, parseLabels, applyVerdicts, verifyRoom } from "../lib/verify.mjs";

const doc = (n, contents, title = "") => ({ url: `https://blog.example/${n}`, title, contents });

test("룸 언급이 없는 글·잡음 단어(쇼룸 등)만 있는 글은 발췌하지 않는다", () => {
  const docs = [doc(1, "분위기 좋은 식당이에요"), doc(2, "쇼룸 같은 인테리어와 레스트룸"), doc(3, "단체룸이 있어요")];
  const s = roomSnippets(docs);
  assert.equal(s.length, 1);
  assert.equal(s[0].doc.url, "https://blog.example/3");
});

test("발췌는 '룸' 앞뒤로 잘라 길이를 줄이고, 최대 건수를 지킨다", () => {
  const long = "가".repeat(500) + " 룸이 있어요 " + "나".repeat(500);
  const [one] = roomSnippets([doc(1, long)]);
  assert.ok(one.text.length <= 320 && one.text.includes("룸이 있어요"));
  const many = Array.from({ length: 20 }, (_, i) => doc(i, "룸 예약 가능"));
  assert.equal(roomSnippets(many, 8).length, 8);
});

test("프롬프트에 대상 가게(상호)와 번호 붙은 발췌가 들어간다", () => {
  const p = buildPrompt("달그리고나무 (서울 종로구)", ["첫째", "둘째"]);
  assert.match(p, /대상 가게: "달그리고나무 \(서울 종로구\)"/);
  assert.match(p, /1\. 첫째\n2\. 둘째/);
});

test("모델 출력 파싱: 앞뒤 설명·코드펜스가 있어도 JSON 배열을 읽는다", () => {
  const out = '결과입니다:\n```json\n[{"id":1,"room":"yes"},{"id":2,"room":"NO"},{"id":3,"room":"unknown"}]\n```';
  assert.deepEqual(parseLabels(out, 3), ["yes", "no", "unknown"]);
});

test("모델 출력 파싱: 빠진 번호는 unknown, 범위 밖·잘못된 값은 무시, 전부 깨지면 null", () => {
  assert.deepEqual(parseLabels('[{"id":2,"room":"yes"},{"id":9,"room":"yes"},{"id":1,"room":"maybe"}]', 3), ["unknown", "yes", "unknown"]);
  assert.equal(parseLabels("모르겠습니다", 3), null);
  assert.equal(parseLabels("[깨진 json", 3), null);
  assert.equal(parseLabels('[{"id":9,"room":"yes"}]', 3), null);
  assert.equal(parseLabels(undefined, 3), null);
});

test("집계: yes 가 많으면 있음(+글 근거), no 가 많으면 없음", () => {
  const docs = [doc(1, "룸이 있어요"), doc(2, "룸 이용 불가"), doc(3, "룸 3개 있어요")];
  const a = applyVerdicts(docs, ["yes", "no", "yes"]);
  assert.equal(a.room.state, "yes");
  assert.equal(a.room.verified, true);
  assert.equal(a.room.mixed, true);
  assert.deepEqual(a.counts, { yes: 2, no: 1, unknown: 0 });
  const b = applyVerdicts(docs, ["no", "no", "yes"]);
  assert.equal(b.room.state, "no");
});

test("집계: 동수·근거 없음은 미확인(null) — 틀린 안내보다 빈칸", () => {
  const docs = [doc(1, "룸이 있어요"), doc(2, "룸은 없어요")];
  assert.equal(applyVerdicts(docs, ["yes", "no"]).room, null);
  assert.equal(applyVerdicts(docs, ["unknown", "unknown"]).room, null);
});

test("집계: 룸비·최소 주문은 yes 로 판정된 글에서만 가져온다", () => {
  const docs = [doc(1, "룸 이용료 1만원 룸이 있어요"), doc(2, "룸비 5만원이라는 옆집 얘기")];
  const a = applyVerdicts(docs, ["yes", "unknown"]);
  assert.equal(a.room.state, "yes");
  assert.equal(a.room.fee?.won, 10000);
});

test("verifyRoom: 가짜 모델 — 규칙이 틀리던 문장을 모델 판정으로 바로잡는다", async () => {
  const docs = [doc(1, "고기굽는집 룸 예약은 불가능하고 홀만 운영해요"), doc(2, "고기굽는집 룸 이용 불가, 테이블석만")];
  let seen;
  const chat = async ({ messages }) => {
    seen = messages[0].content;
    return { content: '[{"id":1,"room":"no"},{"id":2,"room":"no"}]', usage: { total_tokens: 10 } };
  };
  const r = await verifyRoom({ target: "고기굽는집 (서울)", docs, chat });
  assert.equal(r.room.state, "no");
  assert.match(seen, /고기굽는집 \(서울\)/);
});

test("verifyRoom: 룸 언급 글이 없으면 모델을 부르지 않는다", async () => {
  let called = false;
  const r = await verifyRoom({ target: "x", docs: [doc(1, "맛있어요")], chat: async () => ((called = true), { content: "[]" }) });
  assert.equal(r.skipped, "no-snippet");
  assert.equal(called, false);
});

test("verifyRoom: 모델 출력이 깨지면 skipped(폴백), 모델 오류는 그대로 던진다", async () => {
  const docs = [doc(1, "룸이 있어요")];
  assert.equal((await verifyRoom({ target: "x", docs, chat: async () => ({ content: "음..." }) })).skipped, "bad-output");
  await assert.rejects(verifyRoom({ target: "x", docs, chat: async () => { throw new Error("boom"); } }), /boom/);
});
