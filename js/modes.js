// 회식 모드별 검색/필터/정렬 규칙 (기획안 "회식 모드별 호출 매핑", 정의서 v1 필드 기준)

// srtTime/endTime은 최근 1개월 최초/최종 결제 시각(HHMM). 종료가 시작보다 이르면 자정 넘김으로 본다.
export const closeAbs = (s) => {
  const open = Number(s.open), close = Number(s.close);
  return close <= open ? close + 2400 : close;
};

const kwBonus = (s) => (s.kw ? -3 : 0);

export const MODES = {
  dinner: {
    label: "1차 회식",
    noun: "회식",
    keyword: "회식",
    categories: ["고기구이", "갈비전문점", "한정식", "중국음식", "일식회집", "곱창전골/구이", "족발/보쌈"],
    filter: () => true, // 시간대 영업 여부·회식 적합은 추천 엔진(js/recommend.js)에서
    score: (s) => s.rank + kwBonus(s) - (s.busyTime === "저녁" ? 2 : 0),
  },
  after: {
    label: "2차",
    noun: "2차",
    keyword: "퇴근후한잔",
    categories: ["주점", "칵테일바", "치킨", "양꼬치", "곱창전골/구이"],
    filter: () => true, // 시간대 영업 여부·회식 적합은 추천 엔진(js/recommend.js)에서
    score: (s) => s.rank + kwBonus(s),
  },
  lunch: {
    label: "점심 회식",
    noun: "점심 회식",
    keyword: null,
    categories: ["일반한식", "찜/탕/찌개", "한정식", "중국음식", "일식회집"],
    filter: () => true, // 시간대 영업 여부·회식 적합은 추천 엔진(js/recommend.js)에서
    score: (s) => s.rank + (s.busyTime === "점심" ? 1000 : 0), // 점심에 붐비는 집은 뒤로
  },
  late: {
    label: "야근 야식",
    noun: "야식",
    keyword: "심야",
    categories: ["치킨", "분식", "떡볶이전문점", "족발/보쌈", "양꼬치"],
    filter: () => true, // 시간대 영업 여부·회식 적합은 추천 엔진(js/recommend.js)에서
    score: (s) => s.rank + kwBonus(s),
  },
};

// API merTpbuzNm 에 그대로 보낼 값 (정의서 부록: 대분류 9종 / 소분류 34종 중 회식 관련만)
export const ALL_CATEGORIES = [
  "고기구이", "갈비전문점", "일반한식", "한정식", "찜/탕/찌개", "곱창전골/구이", "족발/보쌈",
  "중국음식", "양꼬치", "일식회집", "스시/초밥", "해산물구이/찜",
  "주점", "칵테일바", "치킨", "분식", "떡볶이전문점",
];

export function applyMode(mode, stores, { headcount, groupThreshold }) {
  const m = MODES[mode];
  return stores
    .filter(m.filter)
    .filter((s) => !(headcount >= groupThreshold) || s.group)
    .sort((a, b) => m.score(a) - m.score(b));
}
