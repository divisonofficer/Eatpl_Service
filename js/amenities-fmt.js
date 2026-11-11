// lib/amenities.mjs 의 화면 표기 함수 (브라우저용 사본 — lib/ 는 정적 서빙하지 않음)
export function fmtWon(w) {
  if (w == null) return "";
  if (w >= 10000) return `${+(w / 10000).toFixed(1)}만원`;
  if (w >= 1000 && w % 1000 === 0) return `${w / 1000}천원`;
  return `${w.toLocaleString("ko-KR")}원`;
}

// 화면 표기
export function roomLabel(r) {
  if (!r) return "";
  if (r.state === "no") return "룸 없음";
  const parts = ["룸"];
  if (r.fee?.free) parts.push("룸비 없음");
  else if (r.fee) parts.push(`룸비 ${r.fee.per ? r.fee.per + " " : ""}${fmtWon(r.fee.won)}`);
  if (r.minOrder) parts.push(`최소 ${fmtWon(r.minOrder.won)}`);
  return parts.join(" · ");
}
export function corkLabel(c) {
  if (!c) return "";
  return c.state === "paid" ? (c.won ? `콜키지 ${fmtWon(c.won)}` : "콜키지 유료") : c.state === "free" ? "콜키지 프리" : c.state === "yes" ? "콜키지 가능" : "콜키지 불가";
}
export function parkLabel(p) {
  if (!p) return "";
  return {
    valet: "발렛 주차",
    free: p.hours ? `주차 ${p.hours}시간 무료` : "무료 주차",
    paid: "유료 주차",
    yes: "주차 가능",
    nearby: "인근 주차장",
    limited: "주차 협소",
    no: "주차 불가",
  }[p.state];
}

// 잇플 상세의 공식 주차 여부(yes|no|null)와 블로그 추정을 합친다.
//  - 공식 '가능': 블로그가 이미 주차 가능 계열(발렛·무료·유료·협소…)이면 그 상세를 쓰고, 아니면(없음·인근 주차장·언급 없음) 공식 값으로 '가능'
//  - 공식 '불가': 블로그가 발렛이면 발렛(전용 주차장 없이도 가능)을 쓰고, 아니면 '불가'
//  - 공식 값이 없으면 블로그 추정 그대로
export function mergeParking(blog, official) {
  if (official === "yes") return blog && PARK_OK.includes(blog.state) ? blog : { state: "yes", official: true };
  if (official === "no") return blog?.state === "valet" ? blog : { state: "no", official: true };
  return blog;
}

// ---------- 단순 표기 (있음 / 없음 / 미확인) ----------
// 상세 화면·필터·추천이 모두 이 함수 하나로 판정한다 (어긋남 방지)
export const PARK_OK = ["valet", "free", "paid", "yes", "limited"];
// 미확인 = 블로그 언급 없음. "없음"으로 확정하지 않는다 (상세에서만 구분, 목록은 회색으로 동일 처리)
export function amenityStates(a = {}) {
  const room = a.room ? (a.room.state === "yes" ? "yes" : "no") : "unknown";
  const park = a.parking ? (PARK_OK.includes(a.parking.state) ? "yes" : "no") : "unknown";
  const cork = a.corkage ? (a.corkage.state === "no" ? "no" : "yes") : "unknown";
  const roomNote = a.room?.state === "yes" ? [a.room.fee?.free ? "룸비 없음" : a.room.fee ? `룸비 ${a.room.fee.per ? a.room.fee.per + " " : ""}${fmtWon(a.room.fee.won)}` : "", a.room.minOrder ? `최소 ${fmtWon(a.room.minOrder.won)}` : ""].filter(Boolean).join(" · ") : "";
  const corkNote = a.corkage?.state === "paid" ? (a.corkage.won ? `유료 · ${fmtWon(a.corkage.won)}` : "유료") : a.corkage?.state === "free" ? "무료" : "";
  const p = a.parking?.state;
  const parkNote = p === "valet" ? (a.parking.paid ? "발렛 · 유료" : "발렛") : p === "free" ? (a.parking.hours ? `${a.parking.hours}시간 무료` : "무료") : p === "paid" ? "유료" : p === "limited" ? "협소" : "";
  return { room, park, cork, roomNote, corkNote, parkNote };
}
export const AMENITY_TEXT = {
  room: { yes: "룸 있어요", no: "룸 없어요", unknown: "룸 미확인" },
  park: { yes: "주차 가능", no: "주차 불가", unknown: "주차 미확인" },
  cork: { yes: "콜키지 가능", no: "콜키지 불가", unknown: "콜키지 미확인" },
};
