// 룸 있음 검증 — 규칙 기반 추출(lib/amenities.mjs)이 "룸 있음"으로 본 가게의 글 발췌를 K-EXAONE 이 다시 읽는다.
// 규칙은 부정어("룸 예약 불가"), 질문("룸 있나요?"), 해시태그, 다른 가게 얘기를 구분하지 못한다.
//
// 이 파일은 순수 함수만: 모델 호출(chat)은 주입받는다 → 테스트에서 가짜 모델을 쓴다.
//  글 발췌 → 프롬프트 → 글별 yes/no/unknown → 집계. 근거가 갈리면(동수) 미확인.
import { decode, ROOM_NOISE, summarizeAmenities } from "./amenities.mjs";

const WINDOW = { before: 130, after: 170 };

// 룸이 언급된 글만, 첫 '룸' 언급 앞뒤 발췌. (토큰·시간 절약: 글당 약 300자, 최대 max 건)
export function roomSnippets(docs, max = 8) {
  const out = [];
  for (const d of docs || []) {
    const text = decode(`${d.title || ""} ${d.contents || ""}`).replace(/\s+/g, " ").replace(ROOM_NOISE, " ");
    const i = text.indexOf("룸");
    if (i < 0) continue;
    out.push({ doc: d, text: text.slice(Math.max(0, i - WINDOW.before), i + WINDOW.after).trim() });
    if (out.length >= max) break;
  }
  return out;
}

export function buildPrompt(target, texts) {
  return `대상 가게: "${target}"
아래는 블로그 글 발췌입니다. 각 발췌가 대상 가게에 칸막이가 있는 별도 방(룸)이 있다고 직접 말하는지 판정하세요.
- yes: 대상 가게에 룸이 있다고 말함
- no: 대상 가게에 룸이 없다고 말함 (룸 이용·예약 불가, 홀만 운영 포함)
- unknown: 근거 없음 (질문, 해시태그, 다른 가게 얘기, 문의하라는 말, 룸이 아닌 좌석 등)
발췌에 다른 가게 얘기가 섞여 있으면 대상 가게에 대한 것만 보세요.
JSON 배열만 출력하세요: [{"id":1,"room":"yes|no|unknown"}, ...]

${texts.map((t, i) => `${i + 1}. ${t}`).join("\n")}`;
}

// 모델 출력 → 글별 라벨. 형식이 깨졌으면 null (호출자는 규칙 결과로 폴백)
export function parseLabels(content, n) {
  const m = String(content ?? "").match(/\[[\s\S]*\]/);
  if (!m) return null;
  let arr;
  try {
    arr = JSON.parse(m[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(arr)) return null;
  const labels = Array(n).fill("unknown");
  let got = 0;
  for (const x of arr) {
    const id = Number(x?.id);
    const r = String(x?.room ?? "").toLowerCase();
    if (Number.isInteger(id) && id >= 1 && id <= n && ["yes", "no", "unknown"].includes(r)) {
      labels[id - 1] = r;
      got++;
    }
  }
  return got ? labels : null;
}

// 글별 라벨 → 가게의 룸 요약 (summarizeAmenities().room 과 같은 모양 + verified)
export function applyVerdicts(docs, labels) {
  const yes = docs.filter((_, i) => labels[i] === "yes");
  const no = docs.filter((_, i) => labels[i] === "no");
  const counts = { yes: yes.length, no: no.length, unknown: docs.length - yes.length - no.length };
  const src = (a) => a.slice(0, 3).map((d) => d.url);
  if (yes.length > no.length) {
    // 비용·최소 주문은 '있다'고 판정된 글에서만 (규칙 추출 재사용)
    const base = summarizeAmenities(yes).room || {};
    return { room: { fee: null, minOrder: null, ...base, state: "yes", count: yes.length, mixed: no.length > 0, sources: src(yes), verified: true }, counts };
  }
  if (no.length > yes.length) {
    return { room: { state: "no", count: no.length, mixed: yes.length > 0, fee: null, minOrder: null, sources: src(no), verified: true }, counts };
  }
  return { room: null, counts }; // 근거 없음·동수 → 미확인 (틀린 안내보다 빈칸)
}

export async function verifyRoom({ target, docs, chat }) {
  const snips = roomSnippets(docs);
  if (!snips.length) return { skipped: "no-snippet" };
  const { content, usage } = await chat({ messages: [{ role: "user", content: buildPrompt(target, snips.map((s) => s.text)) }] });
  const labels = parseLabels(content, snips.length);
  if (!labels) return { skipped: "bad-output" };
  return { ...applyVerdicts(snips.map((s) => s.doc), labels), usage };
}
