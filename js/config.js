// 데이터 소스 (?source= 로 전환)
//  "live"  → 로컬 서버 /api/eatpl/search → k-skill-proxy → eat.pl API (기본값, 실패 시 mock 폴백)
//  "mock"  → data/mock.json
//  "proxy" → 자체 닷홈 PHP 프록시 (자체 기관코드 발급 시)
export const CONFIG = {
  source: new URLSearchParams(location.search).get("source") || "live",
  liveUrl: "/api/eatpl/search",
  mockUrl: "data/mock.json",
  proxyUrl: "https://YOUR_ID.dothome.co.kr/eatpl.php",
  proxyToken: "",
  maxCandidates: 3,
  maxPins: 60, // 업종별 100건 × 여러 업종 → 지도에는 상위 N개만
  groupThreshold: 10, // 인원 ≥ 이 값이면 회식 적합 매장만
  defaultLocation: "서울 종로구",
};
