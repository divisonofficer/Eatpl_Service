// 구글맵 앱 스타일 바텀시트: peek / half / full 3단 스냅.
// - 헤더를 끌어서 높이 조절, 탭하면 한 단계씩 토글
// - 목록 스크롤은 시트 내부에서만 (overscroll-behavior: contain)
// - full 에서도 상단 검색 바 아래로 지도가 일부 남도록 상한을 둔다
const DESKTOP = window.matchMedia("(min-width: 900px)");
const PEEK_H = 132; // 헤더 + 첫 카드 일부
const MIN_MAP = 0.22; // full 에서도 화면 높이의 이 비율만큼은 지도 노출

export function createSheet({ sheet, head, top, onChange }) {
  let snap = "half";
  let y = 0;

  const H = () => window.innerHeight;
  const snaps = () => {
    const topBottom = top.getBoundingClientRect().bottom + 8;
    const full = Math.max(topBottom, H() * MIN_MAP + topBottom * 0.5);
    return { full, half: Math.max(full, H() * 0.52), peek: H() - PEEK_H };
  };
  const apply = (px, animate) => {
    y = px;
    sheet.classList.toggle("animating", !!animate);
    document.documentElement.style.setProperty("--sheet-top", `${px}px`);
  };
  const set = (name, animate = true) => {
    if (DESKTOP.matches) return;
    snap = name;
    sheet.dataset.snap = name;
    apply(snaps()[name], animate);
    onChange?.(name);
  };

  // 드래그
  let drag = null;
  head.addEventListener("pointerdown", (e) => {
    if (DESKTOP.matches || e.target.closest("button")) return;
    drag = { startY: e.clientY, startTop: y, lastY: e.clientY, lastT: performance.now(), v: 0, moved: false };
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dy) > 5) drag.moved = true;
    const now = performance.now();
    drag.v = (e.clientY - drag.lastY) / Math.max(1, now - drag.lastT);
    drag.lastY = e.clientY;
    drag.lastT = now;
    const s = snaps();
    apply(Math.min(s.peek + 30, Math.max(s.full - 20, drag.startTop + dy)), false);
  });
  const end = () => {
    if (!drag) return;
    const { moved, v } = drag;
    drag = null;
    const s = snaps();
    if (!moved) return set(snap === "peek" ? "half" : snap === "half" ? "full" : "half");
    // 빠르게 튕기면 진행 방향의 다음 스냅, 아니면 가장 가까운 스냅
    const byPos = Object.keys(s).sort((a, b) => s[a] - s[b]); // full, half, peek
    if (v > 0.5) return set(byPos.find((k) => s[k] > y + 4) || "peek");
    if (v < -0.5) return set([...byPos].reverse().find((k) => s[k] < y - 4) || "full");
    set(nearest(s, y));
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);

  const nearest = (s, px) => Object.keys(s).reduce((a, b) => (Math.abs(s[b] - px) < Math.abs(s[a] - px) ? b : a));

  const layout = () => {
    if (DESKTOP.matches) {
      document.documentElement.style.setProperty("--desk-top", `${top.getBoundingClientRect().bottom + 10}px`);
      onChange?.("desktop");
    } else set(snap, false);
  };
  window.addEventListener("resize", layout);
  DESKTOP.addEventListener("change", layout);
  new ResizeObserver(layout).observe(top);
  layout();

  return {
    set,
    get snap() { return DESKTOP.matches ? "desktop" : snap; },
    // 지도에서 시트·패널에 가리지 않는 영역 (fitBounds/panTo 보정용)
    coverage() {
      if (DESKTOP.matches) return { left: sheet.getBoundingClientRect().right + 12, top: 0, bottom: 0 };
      return { left: 0, top: top.getBoundingClientRect().bottom, bottom: H() - y };
    },
  };
}
