// 회식 추천 엔진 — 결정론(같은 입력 → 같은 점수·순서), 외부 호출 없는 순수 함수.
// 입력: 정규화된 매장(api.js normalize) + 맥락 { mode, headcount, day, teamAges, amenity, partner }
// 출력: { score, blocked, reasons: [{ t, w }] }  — w>0 이유는 상위 3개, w<0 은 주의 1개를 화면에 보인다.
//
// 근거 데이터 (2,875곳 실측, 서울 6개 구 × 5개 업종):
//   1위 고객이 30~50대 남성 → 회식 적합 15.6% vs 나머지 5.2% (3.0배). 30대 남성 2.7배, 40대 남성 1.7배, 50대 남성 1.1배.
//   "4050 남성 메뉴" 가설은 1위일 때만 약하게(1.3배) 맞음 → '30~50대 남성 단골' 신호로 사용.

export const SLOTS = {
  dinner: { label: "저녁", from: 1800, to: 2100, tizn: "저녁" },
  after: { label: "밤", from: 2030, to: 2300, tizn: "심야" },
  lunch: { label: "점심", from: 1140, to: 1320, tizn: "점심" },
  late: { label: "심야", from: 2200, to: 2400, tizn: "심야" },
};
export const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

// 가중치 (모드별)
const W = {
  group: { dinner: 18, after: 10, lunch: 8, late: 4 },
  office: { dinner: 10, after: 8, lunch: 6, late: 3 },
};

// HHMM → 분. 종료가 시작 이전이면 다음날로. 0000~2359/0600~0559 처럼 거의 하루면 24시간.
const min = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(2));
export function openDuring(s, from, to) {
  if (!/^\d{4}$/.test(s.open || "") || !/^\d{4}$/.test(s.close || "")) return true; // 정보 없음 → 막지 않음
  let o = min(s.open), c = min(s.close);
  if ((c - o + 1440) % 1440 >= 1430) return true;
  if (c <= o) c += 1440;
  const f = min(String(from).padStart(4, "0")), t = min(String(to).padStart(4, "0"));
  // 슬롯의 절반 이상 영업하면 영업 중으로 본다 (최초·최종 '결제' 시각이라 실제 영업보다 짧게 잡힘)
  const overlap = (a0, a1) => Math.max(0, Math.min(c, a1) - Math.max(o, a0));
  const need = (t - f) / 2;
  return overlap(f, t) >= need || overlap(f + 1440, t + 1440) >= need;
}

const rankPts = (r) => {
  const x = Number(r);
  if (!Number.isFinite(x)) return 0;
  return 30 * Math.max(0, 1 - Math.log10(1 + x) / Math.log10(101)); // 0.5%→27, 1%→25, 5%→18, 10%→14, 30%→8
};
const OFFICE = /^(30대|40대|50대)남성$/;

export function recommend(s, ctx) {
  const mode = ctx.mode || "dinner";
  const slot = SLOTS[mode];
  const hc = ctx.headcount || 8;
  const reasons = [];
  const add = (w, t) => {
    if (w) reasons.push({ w: Math.round(w * 10) / 10, t });
  };

  // 제외 조건
  if (ctx.day && s.holidays?.includes(ctx.day)) return { score: -Infinity, blocked: `${ctx.day} 휴무`, reasons: [] };
  if (slot && !openDuring(s, slot.from, slot.to)) return { score: -Infinity, blocked: `${slot.label} 영업 안 함`, reasons: [] };

  // 매출 순위
  let score = rankPts(s.rank);
  // 회식 적합 (인원 적을수록 비중 ↓)
  const scale = hc >= 5 ? 1 : hc >= 3 ? 0.6 : 0.3;
  if (s.group) add(W.group[mode] * scale, "회식 적합");
  // 1위 고객 30~50대 남성
  if (OFFICE.test(s.customers?.[0] || "")) add(W.office[mode] * scale, "30~50대 남성 단골");
  // 팀 연령대 × 팀 구성(성별): 둘 다 맞는 단골층이 있으면 가장 구체적인 이유로
  const top3 = (s.customers || []).slice(0, 3);
  const sexOf = (c) => (c.endsWith("여성") ? "female" : c.endsWith("남성") ? "male" : null);
  const ages = [...(ctx.teamAges || [])];
  const g = ctx.teamGender; // male | female | mixed | null
  const exact = ages.length && (g === "male" || g === "female") ? top3.find((c) => ages.some((a) => c.startsWith(a)) && sexOf(c) === g) : null;
  if (exact) add(8, `${exact.replace(/(남성|여성)$/, " $1")} 단골`);
  else if (ages.length && top3.some((c) => ages.some((a) => c.startsWith(a)))) add(6, "우리 팀 또래 단골");
  if (!exact && g) {
    const sexes = top3.map(sexOf);
    if (g === "female" && (sexOf(top3[0] || "") === "female" || sexes.filter((x) => x === "female").length >= 2)) add(6, "여성 손님 많은 곳");
    else if (g === "male" && sexOf(top3[0] || "") === "male") add(4, "남성 손님 많은 곳");
    else if (g === "mixed" && sexes.includes("male") && sexes.includes("female")) add(3, "남녀 고루 찾는 곳");
  }
  // 붐빔
  if (slot && s.busyTime) {
    if (s.busyTime === slot.tizn && ctx.day && s.busyDay === ctx.day) add(-6, `${ctx.day} ${slot.label} 붐빔 · 예약 권장`);
    else if (s.busyTime === slot.tizn) add(-2, `${slot.label}에 붐비는 편`);
    else add(3, `${slot.label}엔 덜 붐빔`);
  }
  // 거리
  if (s.dist != null) {
    const walk = Math.max(1, Math.round(s.dist / 75));
    if (s.dist <= 300) add(8, `도보 ${walk}분`);
    else if (s.dist <= 700) add(5, `도보 ${walk}분`);
    else if (s.dist <= 1200) add(2, `도보 ${walk}분`);
    else if (s.dist > 2000) add(-4, "조금 멀어요");
  }
  // 룸·주차·콜키지 (amenityStates 결과)
  const a = ctx.amenity || {};
  if (a.room === "yes") add(hc >= 8 ? 10 : 4, "룸 있어요");
  if (a.room === "no" && hc >= 10) add(-4, "룸 없어요");
  if (a.park === "yes") add(3, "주차 가능");
  if (a.cork === "yes") add(mode === "after" ? 4 : 2, "콜키지 가능");
  // 동네 맛집 (점심)
  if (mode === "lunch" && s.local) add(3, "동네 맛집");
  // 사진 (근거로는 안 보임)
  if (ctx.hasPhoto) score += 2;
  // 제휴 데이터 자리 (BC카드 제공 시): 오늘 현황·시간대 분포·연령 분포·방문 후 이동
  for (const f of ctx.partner || []) add(f.w, f.t);

  score += reasons.reduce((x, r) => x + r.w, 0);
  reasons.sort((x, y) => y.w - x.w || x.t.localeCompare(y.t));
  return { score: Math.round(score * 10) / 10, blocked: null, reasons };
}

// 화면용: 좋은 이유 최대 3개 + 주의 1개
export function topReasons(rec, n = 3) {
  if (!rec || rec.blocked) return { good: [], warn: null };
  return { good: rec.reasons.filter((r) => r.w > 0).slice(0, n), warn: rec.reasons.filter((r) => r.w < 0).sort((x, y) => x.w - y.w)[0] || null };
}

export const todayKST = () => DAYS[new Date(Date.now() + 9 * 3600 * 1000).getUTCDay()];
