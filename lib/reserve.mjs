// 예약 힌트 — 결정론, 외부 호출 없는 순수 함수.
// 잇플 API·상세 페이지·카카오 로컬 API 에는 예약 정보가 없다 (2026-11 확인). 캐치테이블·네이버 예약은 공개 API 가 없다.
// 그래서 '이 가게 글'로 검증된 블로그 글에서 예약 채널 언급만 센다. 언급 없음 ≠ 예약 불가.
// 직접 예약 링크(캐치테이블 매장 주소)는 주소·전화까지 맞은 글(verified)에서만 쓴다 — 다른 가게 링크가 섞이지 않게.
import { decode } from "./amenities.mjs";

export const CATCHTABLE_URL = /https:\/\/app\.catchtable\.co\.kr\/ct\/shop\/[A-Za-z0-9_-]+/;

const CHANNELS = [
  { k: "naver", label: "네이버 예약", re: /네이버\s?(예약|booking)/i },
  { k: "catchtable", label: "캐치테이블", re: /캐치\s?테이블|catch\s?table/i },
  { k: "tabling", label: "테이블링", re: /테이블링|tabling/i },
  { k: "phone", label: "전화 예약", re: /전화\s?(로\s?)?예약|예약\s?전화/ },
];
const RECOMMEND = /예약\s?(필수|하고\s?가|권장|추천|하시는\s?(걸|것을|게))/;
const WALKIN = /예약\s?(없이|불가|안\s?받)/;

// docs: 이 가게 글(검증 통과), linkDocs: 그중 주소·전화까지 맞은 글
export function summarizeReserve(docs, { linkDocs = [] } = {}) {
  const seen = new Set();
  const count = Object.fromEntries(CHANNELS.map((c) => [c.k, 0]));
  let recommend = 0;
  let walkin = 0;
  for (const d of docs || []) {
    if (!d?.url || seen.has(d.url)) continue;
    seen.add(d.url);
    const t = decode(`${d.title || ""} ${d.contents || ""}`);
    for (const c of CHANNELS) if (c.re.test(t)) count[c.k]++;
    if (RECOMMEND.test(t)) recommend++;
    if (WALKIN.test(t)) walkin++;
  }
  let catchtable = null;
  for (const d of linkDocs || []) {
    const m = decode(`${d.title || ""} ${d.contents || ""}`).match(CATCHTABLE_URL);
    if (m) {
      catchtable = m[0];
      break;
    }
  }
  const channels = CHANNELS.filter((c) => count[c.k] > 0)
    .map((c) => ({ k: c.k, label: c.label, count: count[c.k] }))
    .sort((a, b) => b.count - a.count || a.k.localeCompare(b.k));
  return { channels, recommend, walkin, catchtable };
}

