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
  return c.state === "paid" ? `콜키지 ${fmtWon(c.won)}` : c.state === "free" ? "콜키지 프리" : c.state === "yes" ? "콜키지 가능" : "콜키지 불가";
}
export function parkLabel(p) {
  if (!p) return "";
  return {
    valet: "발렛 주차",
    free: p.hours ? `주차 ${p.hours}시간 무료` : "무료 주차",
    yes: "주차 가능",
    nearby: "인근 주차장",
    limited: "주차 협소",
    no: "주차 불가",
  }[p.state];
}
