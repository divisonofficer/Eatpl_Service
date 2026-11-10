export const hhmm = (t) => (t && t.length === 4 ? `${t.slice(0, 2)}:${t.slice(2)}` : "-");

// 최초~최종 결제 시각이 하루를 거의 다 덮으면(예: 0600~0559) 24시간으로 표기
const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
export const hours = (s) => {
  if (s.open.length === 4 && s.close.length === 4) {
    const span = (mins(s.close) - mins(s.open) + 1440) % 1440;
    if (span >= 1430) return "24시간";
  }
  return `${hhmm(s.open)}~${hhmm(s.close)}`;
};
export const holiday = (s) => (s.holidays.length ? `${s.holidays.join("·")} 휴무` : "연중무휴");
export const rankLabel = (s) => `상위 ${String(s.rank)}%`; // API 값 그대로 (0.04 → "0.04")

// "서울 종로구 종로 200-12 ,1층 (종로4가)" → "종로4가", 괄호 동명이 없으면 구 이름
export function area(s) {
  const m = s.address.match(/\(([^)]+)\)/);
  if (m) return m[1].split(",")[0].trim();
  return s.address.split(" ")[1] || s.address;
}

// 업종 → 썸네일 약칭 (사진이 없을 때)
const SHORT = {
  고기구이: "고기", 갈비전문점: "갈비", 일반한식: "한식", 한정식: "한정식", "찜/탕/찌개": "찌개", "곱창전골/구이": "곱창",
  "족발/보쌈": "족발", 중국음식: "중식", 양꼬치: "양꼬치", 일식회집: "회", "스시/초밥": "스시", "해산물구이/찜": "해산물",
  주점: "주점", 칵테일바: "바", 치킨: "치킨", 분식: "분식", 떡볶이전문점: "떡볶이", 기타주점: "주점", 호프: "호프", "바(bar)": "바",
};
// 표시용 업종명 (API 값은 그대로 두고 화면에서만 바꿔 부른다)
const DISPLAY = { 고기구이: "고깃집" };
export const catLabel = (c) => DISPLAY[c] || c;

export const icon = (s) => SHORT[s.category] || String(s.category || "").split("/")[0].replace(/전문점$/, "").slice(0, 3) || "식당";

export function buildMessage(list, { modeNoun, tone, link }) {
  const line = (s, i) => `${i + 1}) ${s.name} (${catLabel(s.category)} · ${area(s)} · ${holiday(s)})`;
  // 1차·2차가 섞여 있으면 단계별로 묶는다
  const staged = list.some((s) => s.stage) && new Set(list.map((s) => s.stage || "")).size > 1;
  let body;
  if (staged) {
    body = [];
    let n = 0;
    for (const st of ["1차", "2차", ""]) {
      const group = list.filter((s) => (s.stage || "") === st);
      if (!group.length) continue;
      body.push(`[${st || "기타"}]`, ...group.map((s) => line(s, n++)));
    }
  } else body = list.map(line);
  const noun = staged ? "회식" : modeNoun;
  const tail = link ? ["", `위치·상세 보기: ${link}`] : [];
  if (tone === "casual") {
    return [`다들 ${noun} 장소 후보 골라봤어요!`, "", ...body, ...tail, "", "편한 곳 알려주시면 바로 예약할게요"].join("\n");
  }
  return [`안녕하세요, 이번 ${noun} 장소 후보 공유드립니다.`, "", ...body, ...tail, "", "편하신 곳 말씀 주시면 예약하겠습니다. 감사합니다."].join("\n");
}
