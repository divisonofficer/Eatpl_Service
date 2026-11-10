// 후보 공유 링크: 회식픽 URL에 후보 매장 요약을 담는다 (서버 저장 없음).
// 받은 사람은 회식픽에서 지도·카드를 보고, 각 매장의 잇플 상세(merUrl 원본)로 이동한다.
// merUrl은 API 응답 문자열 그대로 담고 그대로 링크한다 (변형 금지).

const b64url = {
  enc: (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (b) => new TextDecoder().decode(Uint8Array.from(atob(b.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))),
};

const pack = (s) => ({
  n: s.name, c: s.category, a: s.address, u: s.url,
  t: s.tel || undefined, la: +s.lat.toFixed(6), lo: +s.lng.toFixed(6),
  r: s.rank, ra: s.rankAll, g: s.group ? 1 : 0, l: s.local ? 1 : 0,
  o: s.open, cl: s.close, h: s.holidays, bd: s.busyDay, bt: s.busyTime,
});
const unpack = (p) => ({
  id: p.u, name: p.n, category: p.c, address: p.a, url: p.u, tel: p.t || "", lat: p.la, lng: p.lo,
  rank: p.r, rankAll: p.ra, group: !!p.g, local: !!p.l, open: p.o || "", close: p.cl || "",
  holidays: p.h || [], busyDay: p.bd || "", busyTime: p.bt || "", customers: [], kw: false,
});

const isMerUrl = (u) => typeof u === "string" && /^https:\/\/web\.paybooc\.ai\/mer\/web\/profile\/[A-Za-z0-9_-]+$/.test(u);

export function shareLink(stores, mode) {
  const payload = { v: 1, m: mode, s: stores.map(pack) };
  const url = new URL(location.href);
  url.search = "";
  url.hash = "";
  url.searchParams.set("share", b64url.enc(JSON.stringify(payload)));
  return url.toString();
}

export function readShare() {
  const raw = new URLSearchParams(location.search).get("share");
  if (!raw) return null;
  try {
    const p = JSON.parse(b64url.dec(raw));
    const stores = (p.s || []).map(unpack).filter((s) => isMerUrl(s.url) && Number.isFinite(s.lat) && Number.isFinite(s.lng));
    return stores.length ? { mode: p.m, stores: stores.slice(0, 3) } : null;
  } catch {
    return null;
  }
}

// 카카오톡 인앱 브라우저 → 기본 브라우저로 열기 (카카오톡 공식 스킴)
export const isKakaoInApp = () => /KAKAOTALK/i.test(navigator.userAgent);
export const kakaoExternalUrl = (u) => `kakaotalk://web/openExternal?url=${encodeURIComponent(u)}`;
