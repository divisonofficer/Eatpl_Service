// 잇플 가맹점 상세 페이지(merUrl)의 '편의 서비스' 파서 — 결정론, 외부 호출 없는 순수 함수.
//
// 상세 페이지에는 사업장이 직접 등록한 편의 서비스(WI-FI·주차)가 서버 렌더링 HTML 로 들어 있다.
//   <ul class="service-list"> <li><span class="ico"><img src=".../ico-parking-on.svg"></span><span>주차가능</span></li> ...
// 블로그 글에서 추정한 주차 정보(lib/amenities.mjs)보다 신뢰도가 높아 우선한다.
// 항목이 없으면 null — "없음"으로 단정하지 않는다.

export const MER_URL = /^https:\/\/web\.paybooc\.ai\/mer\/web\/profile\/[A-Za-z0-9_-]+$/;

export function parseFacilities(html) {
  const h = String(html || "");
  const block = (h.match(/<ul class="service-list">([\s\S]*?)<\/ul>/) || [])[1] || "";
  const items = [...block.matchAll(/ico-([a-z-]+)\.svg"[^>]*>\s*<\/span>\s*<span>([^<]*)<\/span>/g)].map((m) => ({ ico: m[1], text: m[2].trim() }));
  const flag = (name) => {
    const it = items.find((x) => x.ico === `${name}-on` || x.ico === `${name}-off`);
    return it ? (it.ico.endsWith("-on") ? "yes" : "no") : null;
  };
  let parking = flag("parking");
  // 보조: 검색엔진용 noscript 요약 "주차: 가능|불가"
  if (parking == null) {
    const m = h.match(/주차:\s*(가능|불가)/);
    if (m) parking = m[1] === "가능" ? "yes" : "no";
  }
  return { parking, wifi: flag("wifi") };
}
