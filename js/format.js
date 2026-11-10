import { parkLabel, corkLabel } from "./amenities-fmt.js";
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

// 표시용 업종명 — API 값(정의서 대분류/소분류, 응답의 비정형 값)은 그대로 두고 화면에서만 바꿔 부른다
const DISPLAY = {
  고기구이: "고깃집", 갈비전문점: "갈빗집", "곱창전골/구이": "곱창", "찜/탕/찌개": "찌개·탕", "족발/보쌈": "족발·보쌈",
  일반한식: "한식", 기타한식: "한식", "백반/한정식": "한정식",
  중국음식: "중식당", 기타중식: "중식당", 일식회집: "횟집", 기타일식: "일식", "스시/초밥": "초밥", "해산물구이/찜": "해산물",
  일식돈가스: "돈가스", 일식라멘: "라멘", "국수/면/만두": "면·만두", 기타외국식: "외국 음식", 이탈리아음식: "이탈리안",
  기타주점: "주점", 유흥주점: "주점", "바(bar)": "바", 칵테일바: "칵테일바",
  떡볶이전문점: "떡볶이", 김밥전문점: "김밥", "전/부침개": "전", "도시락/죽": "도시락·죽", "브런치카페/샐러드": "브런치", "빵/도넛": "베이커리",
};
export const catLabel = (c) => DISPLAY[c] || c || "음식점";

// 업종 → 아이콘 키 (js/icons.js)
const ICON_OF = [
  [/고기|갈비|곱창|양꼬치|마라/, "meat"],
  [/회집|횟집|스시|초밥|해산물|일식/, "fish"],
  [/주점|호프|이자카야|주류|클럽|바\(bar\)|^바$/, "beer"],
  [/칵테일/, "cocktail"],
  [/치킨|족발|보쌈/, "drumstick"],
  [/면|라멘|만두|중식|중국|떡볶이|분식/, "noodle"],
  [/한식|한정식|찌개|탕|백반|도시락|죽|전/, "bowl"],
];
export const catIcon = (c) => (ICON_OF.find(([re]) => re.test(c || "")) || [0, "utensils"])[1];

const parkShort = (p) => parkLabel(p);
const corkShort = (c) => corkLabel(c);

export function buildMessage(list, { modeNoun, tone, link }) {
  const extra = (s) => {
    const a = s.photo?.amenities || {};
    return [a.room?.state === "yes" ? "룸" : "", a.parking ? parkShort(a.parking) : "", a.corkage && a.corkage.state !== "no" ? corkShort(a.corkage) : ""].filter(Boolean);
  };
  const line = (s, i) => `${i + 1}) ${s.name} (${[catLabel(s.category), area(s), holiday(s), ...extra(s)].join(" · ")})`;
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
