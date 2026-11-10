// 모의 데이터 생성기: node tools/gen-mock.mjs
// API 정의서 v1(2026.08) 응답 스키마를 그대로 따른다. 매장명은 전부 가상.
// 좌표는 WGS84 → TM128 정변환해 저장 → 앱은 실제와 동일하게 역변환 경로를 탄다.
// "_" 접두 필드는 모의 전용(서버 측 필터 시뮬레이션): _tpbuzL = 대분류, _keywords = 키워드 검색
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { TM128 } from "../js/geo-def.js";

const require = createRequire(import.meta.url);
const proj4 = require("../vendor/proj4.js");

let seed = 20261029;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const jitter = (d) => (rnd() - 0.5) * 2 * d;

const AREAS = [
  { gu: "서울 종로구", roads: ["종로", "삼일대로", "인사동길", "돈화문로"], dongs: ["종로3가", "종로4가", "관철동", "인사동"], lat: 37.5703, lng: 126.9905 },
  { gu: "서울 중구", roads: ["을지로", "충무로", "명동길", "다동길"], dongs: ["을지로3가", "을지로4가", "명동2가", "다동"], lat: 37.5660, lng: 126.9895 },
  { gu: "서울 강남구", roads: ["테헤란로", "논현로", "역삼로"], dongs: ["역삼동", "논현동"], lat: 37.5005, lng: 127.0360 },
  { gu: "서울 영등포구", roads: ["여의대로", "국제금융로", "여의나루로"], dongs: ["여의도동"], lat: 37.5215, lng: 126.9250 },
  { gu: "서울 마포구", roads: ["양화로", "와우산로", "독막로"], dongs: ["서교동", "합정동", "상수동"], lat: 37.5530, lng: 126.9215 },
];

// [소분류(응답값, null이면 대분류 반환), 대분류, 매장명들, 영업시간 후보, 회식 적합 확률, 키워드]
const CATS = [
  ["고기구이", "갈비전문점", ["숯불명가 화로정", "참숯한우 은행나무", "돼지굽는마을", "소금구이 삼대", "갈비명장 청기와", "한우곳간", "양갈비 초원", "목살연구소"], [["1104", "2251"], ["1552", "2348"]], 0.85, ["회식"]],
  ["곱창전골/구이", "일반한식", ["막창골목 대구집", "곱창이야기", "황소곱창"], [["1612", "0042"]], 0.7, ["회식", "퇴근후한잔", "심야"]],
  ["찜/탕/찌개", "일반한식", ["김치찌개 장인", "갈비찜 온담", "부대찌개 미군부대", "감자탕 원조집"], [["1047", "2132"], ["1112", "2205"]], 0.4, ["동네"]],
  [null, "한정식", ["한옥밥상 다온", "종가집 수라", "보리굴비 서촌댁", "궁중한상 가온"], [["1121", "2140"]], 0.75, ["회식", "가족외식"]],
  [null, "중국음식", ["홍매반점", "만리향 코스요리", "취영루 신관", "금룡각"], [["1058", "2147"], ["1126", "2128"]], 0.65, ["회식"]],
  ["양꼬치", "중국음식", ["양꼬치 하얼빈"], [["1638", "0115"]], 0.5, ["퇴근후한잔", "심야"]],
  ["스시/초밥", "일식회집", ["스시 하루", "참치명가 오도로", "오마카세 류"], [["1134", "2152"]], 0.5, ["회식"]],
  ["해산물구이/찜", "일식회집", ["대게나라 포구", "조개구이 섬마을", "민어전문 목포댁"], [["1458", "2341"], ["1137", "2256"]], 0.65, ["회식", "심야"]],
  [null, "주점", ["노가리골목집", "막걸리 주막 달빛", "포차 반딧불", "전집 비오는날", "이자카야 유메", "수제맥주 브루하우스"], [["1655", "0148"], ["1748", "0057"]], 0.35, ["퇴근후한잔", "심야"]],
  [null, "칵테일바", ["바 블루아워", "스피크이지 문", "하이볼 라운지 휘슬"], [["1903", "0152"], ["1812", "0108"]], 0.1, ["퇴근후한잔", "심야"]],
  ["치킨", "스넥", ["바삭치킨 본점", "옛날통닭 장터", "치맥하우스", "순살공방"], [["1546", "0124"], ["1501", "0048"]], 0.25, ["퇴근후한잔", "심야"]],
  ["분식", "스넥", ["김밥천하", "라면공방 심야점"], [["0000", "2359"], ["0712", "2213"]], 0.05, ["심야", "24시간운영"]],
  ["떡볶이전문점", "스넥", ["떡볶이연구소"], [["1031", "2302"]], 0.05, ["심야"]],
  ["족발/보쌈", "일반한식", ["장충왕족발", "원조보쌈 할매집", "불족발 야시장", "보쌈정식 한상"], [["1128", "2354"], ["1557", "0106"]], 0.55, ["회식", "심야"]],
];

const CSTMR = ["20대남성", "20대여성", "30대남성", "30대여성", "40대남성", "40대여성", "50대남성", "50대여성", "60대이상남성"];
const TIZN_BY_CLOSE = (close) => (close < 600 ? ["저녁", "심야", "심야"] : ["점심", "저녁", "저녁", "오후"]);
const randRank = () => {
  const r = rnd();
  const v = r < 0.12 ? rnd() * 0.1 : r < 0.5 ? rnd() * 5 : rnd() * 40;
  return Math.max(0.01, Number(v.toFixed(2)));
};

const rows = [];
let i = 0;
for (const [small, large, names, hours, empyP, kws] of CATS) {
  for (const name of names) {
    const area = AREAS[(i * 7 + 3) % AREAS.length];
    const lat = area.lat + jitter(0.006);
    const lng = area.lng + jitter(0.008);
    const [x, y] = proj4("WGS84", TM128, [lng, lat]);
    const [srtTime, endTime] = pick(hours);
    const empy = rnd() < empyP;
    const ccg = randRank();
    const cstmr = [...CSTMR].sort(() => rnd() - 0.5);
    rows.push({
      merNm: name,
      merAddr: `${area.gu} ${pick(area.roads)} ${Math.floor(rnd() * 200) + 1} ,1층 (${pick(area.dongs)})`,
      merTpno: "02-0000-0000",
      merTpbuzNm: small ?? large,
      allSaleRnk: Math.min(99, Number((ccg * (2 + rnd() * 6)).toFixed(2))),
      ccgSaleRnk: ccg,
      loclPrsnPpltYn: rnd() < 0.4,
      merUrl: "https://web.paybooc.ai/",
      srtTime,
      endTime,
      frnrVsitYn: rnd() < 0.3,
      empyVsitYn: empy,
      hldyDwk: rnd() < 0.55 ? [] : pick([["일"], ["월"], ["토", "일"]]),
      congestionDwk: pick(["목", "금", "금", "수", "토"]),
      congestionTizn: pick(TIZN_BY_CLOSE(Number(endTime))),
      vistCstmrRnkList: { rk01: cstmr[0], rk02: cstmr[1], rk03: cstmr[2] },
      xaxsVal: String(Math.round(x)),
      yaxsVal: String(Math.round(y)),
      _tpbuzL: large,
      _keywords: empy ? [...new Set([...kws, "회식"])] : kws.filter((k) => k !== "회식"),
    });
    i++;
  }
}

const out = {
  rspCode: "00000",
  rspMessage: "Success",
  _mock: { note: "모의 데이터 — API 정의서 v1 스키마, 매장명 가상", baseDt: "2026-10-01" },
  data: rows,
};
writeFileSync(new URL("../data/mock.json", import.meta.url), JSON.stringify(out, null, 2));
console.log(`wrote ${rows.length} rows`);
