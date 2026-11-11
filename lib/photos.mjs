// 매장 사진 후보 필터 — 결정론적(같은 입력 → 같은 출력), 외부 호출 없는 순수 함수만.
//
// 입력
//   store : 잇플 응답 1건 (merNm, merAddr, merTpno, lat/lng(WGS84))
//   place : 카카오 로컬 키워드 검색 documents (장소 매칭용)
//   images: 다음 이미지 검색 documents  (doc_url, image_url, thumbnail_url, width, height, collection, datetime)
//   texts : 다음 블로그/카페 검색 documents (url, title, contents)  — 이미지의 출처 글 본문 발췌
//
// 핵심 아이디어: 이미지 검색 결과엔 텍스트가 없다 → 출처 글(doc_url)을 블로그/카페 검색 결과와 이어 붙여
// "그 글이 이 매장(이름 + 주소/전화)에 관한 글인가"를 텍스트로 검증한다.

// ---------- 문자열 유틸 ----------
import { LEGAL_RE as LEGAL } from "../js/legal-name.js"; // 법인 표기 정규식 정본 (전각 （주） 등 포함)
const decode = (t) =>
  String(t ?? "")
    .replace(/<\/?b>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const squash = (t) => decode(t).replace(/[^0-9A-Za-z가-힣]/g, "").toLowerCase();
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---------- 매장 키 ----------
// "양촌리(길동점)" → core 양촌리, branch 길동점 / "깐부치킨 충정로역점" → 깐부치킨 + 충정로역점
// "텀블러비어역삼직영점" → 텀블러비어역삼 + 직영점 은 과분할 위험 → 공백·괄호로 구분된 지점명만 인정
export function storeKeys(store, place = null) {
  const raw = decode(store.merNm);
  const legal = LEGAL.test(raw);
  LEGAL.lastIndex = 0;
  let name = raw.replace(LEGAL, " ").replace(/\s+/g, " ").trim();
  let branch = (name.match(/\(([^)]*점)\)/) || [])[1] || "";
  name = name.replace(/\([^)]*\)/g, " ").trim();
  const parts = name.split(" ");
  if (!branch && parts.length > 1 && /..점$/.test(parts.at(-1))) branch = parts.pop();
  const core = parts.join(" ").trim();

  const addr = decode(store.merAddr);
  const [, gu = "", road = "", num = ""] = addr.match(/^\S+\s+(\S+)\s+(\S+(?:로|길))\s*(\d+(?:-\d+)?)/) || [];
  const dong = ((addr.match(/\(([^),]+)/) || [])[1] || "").trim();

  const addrKeys = [];
  if (road && num) addrKeys.push({ kind: "road", key: squash(road + num) });
  if (place?.road_address_name) {
    const m = place.road_address_name.match(/(\S+(?:로|길))\s*(\d+(?:-\d+)?)/);
    if (m) addrKeys.push({ kind: "road", key: squash(m[1] + m[2]) });
  }
  if (place?.address_name) {
    const m = place.address_name.match(/(\S+(?:동|가|리))\s*(?:산\s*)?(\d+(?:-\d+)?)$/);
    if (m) addrKeys.push({ kind: "jibun", key: squash(m[1] + m[2]) });
  }
  const phones = [place?.phone, store.merTpno]
    .filter((p) => p && /\d{2,4}-\d{3,4}-\d{4}/.test(p) && !/0000|1111|-0{3,}/.test(p))
    .map((p) => p.split("-"));

  const coreSq = squash(core);
  return {
    core,
    coreSq,
    branchSq: squash(branch),
    dongSq: squash(dong),
    gu,
    // 이름만으로는 특정이 안 되는 경우: 법인명, 2글자 이하, 영문/숫자만
    weakName: legal || coreSq.length <= 2 || !/[가-힣]/.test(coreSq),
    addrKeys: dedupeBy(addrKeys, (a) => a.key),
    phones: dedupeBy(phones, (p) => p.join("")),
  };
}

const dedupeBy = (arr, f) => arr.filter((x, i) => arr.findIndex((y) => f(y) === f(x)) === i);

// ---------- 브랜드명 후보 (카카오 장소 매칭이 실패했을 때만 쓴다) ----------
// 잇플 가맹점명은 사업자명이라 검색어로 나쁜 경우가 있다:
//   "(주)보돌에프엔비 보돌미역 종로타워점"(회사명 섭임), "송추가마골인어반/동경（주）광화문지점"(복합명), "부촌"(짧아 동명 많음)
// 후보는 짧고 보수적으로 — 실제 상호는 카카오 장소(좌표 150m + 이름 유사) 확인을 통과한 것만 쓴다.
const CORP_WORD = /(에프엔비|F&B|f&b|푸드|컴퍼니|코리아|홀딩스|산업|유통)$/;
export function nameVariants(merNm, max = 3) {
  const base = decode(merNm).replace(LEGAL, " ").replace(/\([^)]*\)|（[^）]*）/g, " ").replace(/\s+/g, " ").trim();
  LEGAL.lastIndex = 0;
  const out = [];
  const add = (v) => {
    v = String(v || "").replace(/\s+/g, " ").trim();
    if (v.length >= 2 && !out.includes(v)) out.push(v);
  };
  const words = base.split(" ").filter(Boolean);
  const brand = words.filter((w) => !CORP_WORD.test(w));
  const kept = (brand.length ? brand : words).filter((w, i) => !(i > 0 && /..점$/.test(w))); // 끝의 지점명 제외
  add(kept.join(" "));
  for (const seg of base.split("/")) add(seg.replace(/\s*\S*점$/, "")); // "A/B" 복합명은 조각별로
  if (kept.length > 1) add(kept[0]); // 긴 이름은 첫 단어(브랜드)
  return out.slice(0, max);
}

// ---------- 카카오 장소 매칭 ----------
// 좌표 거리 + 이름 유사로만 판정. 후보가 여럿이면 거리 → id 순 (결정론)
export function matchPlace(store, docs, { maxMeters = 150 } = {}) {
  const want = squash(decode(store.merNm).replace(LEGAL, "").replace(/\([^)]*\)/g, ""));
  const scored = (docs || [])
    .filter((d) => ["FD6", "CE7"].includes(d.category_group_code))
    .map((d) => ({ d, m: meters(store.lat, store.lng, Number(d.y), Number(d.x)), n: squash(d.place_name) }))
    .filter(({ m, n }) => m <= maxMeters && n && want && (n.includes(want) || want.includes(n) || sharedPrefix(n, want) >= 3))
    .sort((a, b) => a.m - b.m || String(a.d.id).localeCompare(String(b.d.id)));
  return scored[0] ? { ...scored[0].d, meters: Math.round(scored[0].m) } : null;
}
const sharedPrefix = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
function meters(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLng = (lng2 - lng1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---------- 출처 글 검증 ----------
// 인물·방송·행사 사진이 섞일 가능성이 높은 글 (핀/카드 모두 제외)
export const PEOPLE_RISK = [
  "방송", "출연", "연예인", "유튜버", "인생샷", "셀카", "셀피", "인증샷", "가족사진", "단체사진", "프로필",
  "돌잔치", "회갑", "칠순", "상견례", "웨딩", "결혼식", "생활의달인", "맛있는녀석들", "백종원", "팬미팅", "촬영지",
  "또간집", "유튜브", "먹방", "아이돌", "배우", "개그맨", "셰프", "사장님과", "직원분들",
];
const ROAD_RE = /([가-힣0-9]+(?:로|길))\s?(\d+(?:-\d+)?)(?![0-9])/g;
const JIBUN_RE = /([가-힣]+[0-9]*(?:동|가))\s?(\d+(?:-\d+)?)(?![0-9])/g;

export function verifyText(doc, keys) {
  const text = decode(`${doc.title} ${doc.contents}`);
  const sq = squash(text);
  const ev = [];
  const nameHit = keys.coreSq && sq.includes(keys.coreSq);
  if (nameHit) ev.push("name");
  if (nameHit && keys.branchSq && sq.includes(keys.branchSq)) ev.push("branch");
  if (keys.dongSq && sq.includes(keys.dongSq)) ev.push("dong");
  for (const a of keys.addrKeys) if (new RegExp(esc(a.key) + "(?![0-9-])").test(sq)) ev.push(a.kind);
  for (const [a, b, c] of keys.phones) if (new RegExp(`${a}\\D{0,2}${b}\\D{0,2}${c}(?!\\d)`).test(text)) ev.push("phone");

  // 글에 주소가 적혀 있는데 우리 주소는 하나도 없다 → 다른 매장(동명이점) 글
  const addrInText = [...text.matchAll(ROAD_RE), ...text.matchAll(JIBUN_RE)].length > 0;
  const ourAddr = ev.includes("road") || ev.includes("jibun");
  const conflict = addrInText && !ourAddr && !ev.includes("phone");
  const risk = PEOPLE_RISK.filter((w) => sq.includes(squash(w)));

  let level = "none";
  if (nameHit && (ourAddr || ev.includes("phone"))) level = "verified";
  else if (nameHit && ev.includes("dong") && !conflict && !keys.weakName) level = "likely";
  if (risk.length) level = "risky";
  if (conflict && level !== "verified") level = "conflict";
  const score = { name: 1, branch: 1, dong: 1, road: 3, jibun: 2, phone: 3 };
  return { level, evidence: [...new Set(ev)], score: [...new Set(ev)].reduce((s, e) => s + score[e], 0), conflict, risk };
}

// doc_url 정규화: http/https, m. 접두사, 네이버 PostView 형태 통일
export function normUrl(u) {
  try {
    const x = new URL(String(u).replace(/^http:/, "https:"));
    const host = x.hostname.replace(/^(m|www)\./, "");
    if (host === "blog.naver.com") {
      const id = x.searchParams.get("blogId"), no = x.searchParams.get("logNo");
      if (id && no) return `blog.naver.com/${id}/${no}`;
    }
    return (host + x.pathname).replace(/\/$/, "");
  } catch {
    return String(u);
  }
}

// ---------- 이미지 선별 ----------
const LEVEL_RANK = { verified: 0, likely: 1 };
export function rankImages({ store, place, images, texts }, { minSide = 300 } = {}) {
  const keys = storeKeys(store, place);
  const byUrl = new Map();
  for (const t of texts || []) {
    const k = normUrl(t.url);
    const v = verifyText(t, keys);
    const prev = byUrl.get(k);
    // 같은 글이 여러 검색에서 나오면 근거가 더 많은 쪽을 채택
    if (!prev || v.score > prev.score || (v.level === "risky" && prev.level !== "risky")) byUrl.set(k, { ...v, title: decode(t.title) });
  }

  const seenImg = new Set();
  const out = [];
  const rejected = {};
  const reject = (why) => (rejected[why] = (rejected[why] || 0) + 1);
  (images || []).forEach((im, apiIndex) => {
    if (!["blog", "cafe"].includes(im.collection)) return reject(`collection:${im.collection}`);
    const w = Number(im.width), h = Number(im.height);
    if (Math.min(w, h) < minSide) return reject("small");
    if (w / h > 2.2 || h / w > 2.2) return reject("aspect");
    const imgKey = im.image_url.split("?")[0];
    if (seenImg.has(imgKey)) return reject("dup");
    seenImg.add(imgKey);
    const v = byUrl.get(normUrl(im.doc_url));
    if (!v) return reject("no-text");
    if (!(v.level in LEVEL_RANK)) return reject(v.level);
    out.push({
      thumb: im.thumbnail_url, image: im.image_url, source: im.doc_url, site: im.display_sitename,
      w, h, level: v.level, evidence: v.evidence, score: v.score, title: v.title, apiIndex,
      date: im.datetime ? String(im.datetime).slice(0, 10) : "", // 원문 글 날짜 (메뉴판 가격의 시점 표기용)
    });
  });

  // 같은 글에서 나온 이미지 수 = 그 글이 이 매장 중심 글일 가능성
  const support = out.reduce((m, x) => ((m[normUrl(x.source)] = (m[normUrl(x.source)] || 0) + 1), m), {});
  out.sort(
    (a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
      b.score - a.score ||
      support[normUrl(b.source)] - support[normUrl(a.source)] ||
      a.apiIndex - b.apiIndex ||
      a.image.localeCompare(b.image)
  );
  // 카드용: 글 하나당 1장 먼저(다양성), 이후 나머지
  const firstPerDoc = [];
  const rest = [];
  const docSeen = new Set();
  for (const x of out) (docSeen.has(normUrl(x.source)) ? rest : (docSeen.add(normUrl(x.source)), firstPerDoc)).push(x);
  const ranked = [...firstPerDoc, ...rest];

  // 핀용: verified 만, 세로로 긴 사진(셀카·인물 비율 높음)은 피하고 가로/정사각 우선
  const pinPool = ranked.filter((x) => x.level === "verified");
  const pin = pinPool.find((x) => x.w / x.h >= 0.9) || null;

  return { keys, ranked, pin, rejected };
}
