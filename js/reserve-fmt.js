// 예약 확인 링크 (브라우저용). 예약 '가능 여부'를 단정하지 않는다 — 사용자가 예약 수단으로 바로 가게 해 줄 뿐.
//  - 전화: 잇플 가맹점 번호, 없으면 카카오 장소 번호
//  - 카카오맵: 매칭된 장소 페이지(카카오 예약을 쓰는 가게는 거기에 예약 버튼), 없으면 검색
//  - 네이버 지도: 이름 + 동 검색 (네이버 예약을 쓰는 가게는 거기서 예약)
//  - 캐치테이블: 이 가게 글(주소·전화까지 맞은 글)에 매장 링크가 있을 때만

// 0으로 시작하는 국내 번호만 (끝자리 0000·1111 같은 가짜 번호 제외)
export function telHref(phone) {
  const p = String(phone || "").trim();
  if (!/^0\d{1,2}-?\d{3,4}-?\d{4}$/.test(p)) return null;
  const digits = p.replace(/-/g, "");
  if (/(0000|1111)$/.test(digits)) return null;
  return `tel:${digits}`;
}

export const naverMapSearchUrl = (name, area) => `https://map.naver.com/p/search/${encodeURIComponent(`${name} ${area || ""}`.trim())}`;

const CT = /^https:\/\/app\.catchtable\.co\.kr\/ct\/shop\/[A-Za-z0-9_-]+$/;
export const safeCatchtable = (u) => (typeof u === "string" && CT.test(u) ? u : null);

// 블로그 언급 요약 한 줄 ("블로그: 네이버 예약 3 · 캐치테이블 1 · 예약 권장 2")
export function reserveHint(r) {
  if (!r) return "";
  const parts = (r.channels || []).map((c) => `${c.label} ${c.count}`);
  if (r.recommend) parts.push(`예약 권장 ${r.recommend}`);
  if (r.walkin) parts.push(`예약 없이 이용 ${r.walkin}`);
  return parts.length ? `블로그 언급: ${parts.join(" · ")}` : "";
}
