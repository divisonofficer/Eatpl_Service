// 룸·콜키지 추출 — 결정론. 잇플 API·상세 페이지에 없는 정보라 블로그(다음 검색, 공식 API) 언급으로 추정한다.
// 입력은 lib/photos.mjs verifyText 로 "이 매장 글"임이 검증된 글만. 글 1개당 항목별 1회만 센다.
// 출력은 단정이 아니라 "블로그 n건 언급" + 출처 — 언급이 없다고 해서 없는 것은 아니다.

const decode = (t) =>
  String(t ?? "")
    .replace(/<\/?b>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// ---------- 금액 ----------
// "1만원" "1.5만원" "5천원" "10,000원" "2만" → 원
export function parseWon(num, unit) {
  const n = Number(String(num).replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const u = String(unit || "").replace(/\s/g, "");
  if (u.startsWith("만")) return Math.round(n * 10000);
  if (u.startsWith("천")) return Math.round(n * 1000);
  return Math.round(n);
}
export function fmtWon(w) {
  if (w == null) return "";
  if (w >= 10000) return `${+(w / 10000).toFixed(1)}만원`;
  if (w >= 1000 && w % 1000 === 0) return `${w / 1000}천원`;
  return `${w.toLocaleString("ko-KR")}원`;
}
const AMT = String.raw`(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s?(만\s?원|천\s?원|원|만)`;
const sane = (w, lo, hi) => w != null && w >= lo && w <= hi;

// ---------- 룸 ----------
const ROOM_NOISE = /레스트룸|쇼룸|볼룸|룸살롱|룸메|룸\s?서비스|파우더룸|드레스룸|룸카페|룸\s?스프레이|쿨룸|베드룸|리빙룸|룸\s?미러|머쉬룸|마쉬룸|버섯/g;
const ROOM_NO = /룸\s?(은|이|도)?\s?(없|X|따로\s?없|없어)/;
const ROOM_YES =
  /(단체|개별|프라이빗|독립|별도|단독|대형|소형|룸식|방식|VIP|vip|미팅|회의|좌식|입식)\s?룸|룸\s?(이|도|은|만)?\s?(있|완비|구비|가능|예약|좌석|형태|으로|에서|잡|마련|구성|이용)|룸\s?\d+\s?(개|실|곳)|\d+\s?인\s?룸|룸\s?\(?\d+\s?(인|명)/;
const ROOM_FEE_FREE = /룸\s?(차지|비|이용료|사용료|대여료)\s?(는|은)?\s?(없|무료|프리|free|X|0\s?원)/i;
const ROOM_FEE = new RegExp(String.raw`룸\s?(차지|비|이용료|사용료|대여료|요금)\s?(은|는|:)?\s?(1인당|인당|시간당)?\s?` + AMT);
const ROOM_MIN = new RegExp(String.raw`룸[^.。!?\n]{0,20}?(최소\s?주문|최소\s?금액|미니멈|최소\s?결제)\s?(금액)?\s?(은|는|:|이)?\s?` + AMT);

export function extractRoom(text) {
  const t = decode(text).replace(ROOM_NOISE, "");
  if (!/룸/.test(t)) return null;
  const out = { state: null, fee: null, feeFree: false, minOrder: null };
  if (ROOM_NO.test(t)) out.state = "no";
  else if (ROOM_YES.test(t)) out.state = "yes";
  if (ROOM_FEE_FREE.test(t)) out.feeFree = true;
  else {
    const m = t.match(ROOM_FEE);
    const w = m && parseWon(m[4], m[5]);
    if (sane(w, 1000, 1_000_000)) out.fee = { won: w, per: m[3] ? m[3].replace(/\s/g, "") : "" };
  }
  const mm = t.match(ROOM_MIN);
  const mw = mm && parseWon(mm[4], mm[5]);
  if (sane(mw, 10000, 10_000_000)) out.minOrder = mw;
  if ((out.fee || out.feeFree || out.minOrder) && !out.state) out.state = "yes"; // 비용이 적혀 있으면 룸이 있는 것
  return out.state ? out : null;
}

// ---------- 콜키지 ----------
const CORK_FREE = /콜키지\s?(비|차지|요금)?\s?(는|가)?\s?(프리|free|무료|0\s?원|없)/i;
const CORK_NO = /콜키지\s?(는|가)?\s?(불가|안\s?됨|안\s?돼|금지|안\s?받)/;
const CORK_FEE = new RegExp(String.raw`콜키지\s?(비|차지|요금|가격|비용)?\s?(는|은|:)?\s?(병당|1병당|한\s?병당|1병에|한\s?병에)?\s?` + AMT);
const CORK_PAID = /콜키지\s?(비|차지)?\s?(는|가|도)?\s?(유료|있(음|어요|습니다|고)|받(아요|습니다|음|고))/;
const CORK_YES = /콜키지\s?(가능|됨|돼|ok|OK|오케이|있)/;

export function extractCorkage(text) {
  const t = decode(text);
  if (!/콜키지/.test(t)) return null;
  if (CORK_NO.test(t)) return { state: "no" };
  // "콜키지 유료(병당 1만원)" → "콜키지 병당 1만원" 으로 정리 후 금액 판정
  const m = t.replace(/(콜키지)\s?(유료|있음)\s?[(:]?\s?/g, "$1 ").match(CORK_FEE);
  const w = m && parseWon(m[4], m[5]);
  if (sane(w, 1000, 300_000)) return { state: "paid", won: w };
  if (CORK_FREE.test(t)) return { state: "free" };
  if (CORK_PAID.test(t)) return { state: "paid", won: null };
  if (CORK_YES.test(t)) return { state: "yes" };
  return null;
}

// ---------- 주차 ----------
// 정보량 순: valet > free(시간) > paid > yes > nearby > limited > no
const PARK_VALET = /발렛|발레\s?파킹|대리\s?주차/;
const PARK_FREE = /(\d+(?:\.\d+)?)\s?시간\s?(무료|주차\s?지원|지원)|주차\s?(\d+(?:\.\d+)?)\s?시간\s?(무료|지원)|무료\s?주차|주차\s?(는|가|비)?\s?무료/;
const PARK_PAID = /주차\s?(는|가|장은|장도)?\s?유료|유료\s?주차(?!장)|주차비|주차\s?요금|시간당\s?[\d,]+\s?원|발렛\s?(비|비용|요금)\s?:?\s?[\d,]+|발렛\s?[\d,]+\s?(천\s?원|원)/;
const PARK_NO = /주차\s?(는|가|장은|장이|장도|공간은|공간이|공간도)?\s?(불가|안\s?됨|안\s?돼|없|X|어렵|힘들|못\s?해)/;
const PARK_LIMITED = /주차\s?(장|공간)?\s?(이|은|가|는)?\s?(협소|좁|적|부족|\d\s?대\s?(정도|뿐|만))/;
const PARK_NEAR = /공영\s?주차장|근처\s?주차장|인근\s?주차장|주변\s?주차장|유료\s?주차장/;
const PARK_OWN = /(전용|건물|자체|매장)\s?(내\s?)?주차장/;
const PARK_YES = /주차\s?(장|공간)?\s?(이|은|도)?\s?(가능|있|완비|넉넉|편리|여유|지원|됨|돼|넓)|전용\s?주차장|건물\s?(내\s?)?주차장|자체\s?주차장|주차장\s?(이용|완비|구비)|주차\s?:\s?(가능|O|○)/;

export function extractParking(text) {
  const t = decode(text);
  if (!/주차|발렛|발레/.test(t)) return null;
  if (PARK_VALET.test(t) && !PARK_PAID.test(t)) return { state: "valet" };
  if (PARK_VALET.test(t)) return { state: "valet", paid: true };
  const f = t.match(PARK_FREE);
  if (f) {
    const h = Number(f[1] || f[3]);
    return { state: "free", hours: Number.isFinite(h) && h > 0 && h <= 24 ? h : null };
  }
  if (PARK_PAID.test(t) && !PARK_NO.test(t)) return { state: "paid" };
  if (PARK_NO.test(t)) return { state: "no" };
  if (PARK_LIMITED.test(t)) return { state: "limited" };
  if (PARK_NEAR.test(t) && !PARK_OWN.test(t)) return { state: "nearby" }; // 공영·인근 주차장 '이용'은 자체 주차가 아님
  if (PARK_YES.test(t)) return { state: "yes" };
  return null;
}

// ---------- 집계 ----------
// docs: [{ url, title, contents }] — 이미 검증된 글. 같은 글(url)은 한 번만.
// 가장 많이 언급된 값을 대표로, 다른 값이 있으면 mixed=true. 동률이면 정보량 많은 쪽(금액 > 상태) → 작은 금액 순.
export function summarizeAmenities(docs) {
  const room = [], cork = [], park = [];
  const seen = new Set();
  for (const d of docs || []) {
    if (seen.has(d.url)) continue;
    seen.add(d.url);
    const text = `${d.title || ""} ${d.contents || ""}`;
    const r = extractRoom(text);
    if (r) room.push({ ...r, url: d.url });
    const c = extractCorkage(text);
    if (c) cork.push({ ...c, url: d.url });
    const p = extractParking(text);
    if (p) park.push({ ...p, url: d.url });
  }
  return { room: summarizeRoom(room), corkage: summarizeCork(cork), parking: summarizePark(park) };
}

function pickMode(items, keyOf, rankOf) {
  const groups = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const ranked = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || rankOf(a[1][0]) - rankOf(b[1][0]) || String(a[0]).localeCompare(String(b[0])));
  return { top: ranked[0], kinds: ranked.length };
}

function summarizeRoom(list) {
  if (!list.length) return null;
  const yes = list.filter((x) => x.state === "yes");
  const no = list.filter((x) => x.state === "no");
  const state = yes.length >= no.length ? "yes" : "no";
  const fees = list.filter((x) => x.fee);
  const free = list.filter((x) => x.feeFree);
  let fee = null;
  if (fees.length || free.length) {
    const all = [...fees.map((x) => ({ k: `${x.fee.per}|${x.fee.won}`, x })), ...free.map((x) => ({ k: "free", x }))];
    const { top, kinds } = pickMode(all, (a) => a.k, (a) => (a.k === "free" ? 1 : 0) * 1e9 + (a.x.fee?.won || 0));
    const sample = top[1][0].x;
    fee = top[0] === "free" ? { free: true, count: top[1].length, mixed: kinds > 1 } : { won: sample.fee.won, per: sample.fee.per, count: top[1].length, mixed: kinds > 1 };
  }
  const mins = list.filter((x) => x.minOrder).map((x) => x.minOrder);
  const minOrder = mins.length ? { won: pickMode(mins.map((w) => ({ w })), (a) => a.w, (a) => a.w).top[0], count: mins.length } : null;
  const support = state === "yes" ? yes.length : no.length;
  return { state, count: support, mixed: !!(yes.length && no.length), fee, minOrder, sources: (state === "yes" ? yes : no).slice(0, 3).map((x) => x.url) };
}

const CORK_RANK = { paid: 0, free: 1, yes: 2, no: 3 };
function summarizeCork(list) {
  if (!list.length) return null;
  const { top, kinds } = pickMode(list, (x) => (x.state === "paid" ? `paid:${x.won}` : x.state), (x) => CORK_RANK[x.state] * 1e9 + (x.won || 0));
  const s = top[1][0];
  return { state: s.state, won: s.won ?? null, count: top[1].length, mixed: kinds > 1, total: list.length, sources: top[1].slice(0, 3).map((x) => x.url) };
}

const PARK_RANK = { valet: 0, free: 1, paid: 2, yes: 3, nearby: 4, limited: 5, no: 6 };
function summarizePark(list) {
  if (!list.length) return null;
  const { top, kinds } = pickMode(list, (x) => (x.state === "free" && x.hours ? `free:${x.hours}` : x.state), (x) => PARK_RANK[x.state] * 100 + (x.hours ? -x.hours : 0));
  const s = top[1][0];
  return { state: s.state, hours: s.hours ?? null, count: top[1].length, mixed: kinds > 1, total: list.length, sources: top[1].slice(0, 3).map((x) => x.url) };
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
