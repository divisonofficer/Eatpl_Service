// 검색어 추천 (typeahead)
//  - 구: 서울 25개 구 로컬 매칭 (즉시)
//  - 역·장소: 카카오 로컬 키워드 검색 (k-skill-proxy 경유, 300ms 디바운스, 2글자 이상)
//  - 빈 입력 포커스: 최근 선택 5개 (localStorage)
const SEOUL_GU = [
  "종로구", "중구", "용산구", "성동구", "광진구", "동대문구", "중랑구", "성북구", "강북구", "도봉구", "노원구", "은평구", "서대문구",
  "마포구", "양천구", "강서구", "구로구", "금천구", "영등포구", "동작구", "관악구", "서초구", "강남구", "송파구", "강동구",
].map((g) => `서울 ${g}`);

const RECENT_KEY = "hoesikpick.recent";
const recent = {
  get: () => {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; }
  },
  add(item) {
    const list = [item, ...this.get().filter((x) => x.label !== item.label)].slice(0, 5);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
  },
};

const norm = (t) => t.replace(/\s+/g, "").toLowerCase();
const cache = new Map();

async function kakaoPlaces(q) {
  if (cache.has(q)) return cache.get(q);
  const p = fetch(`/api/kakao/keyword?${new URLSearchParams({ query: q, size: "8" })}`)
    .then((r) => (r.ok ? r.json() : { documents: [] }))
    .then((j) =>
      (j.documents || []).map((d) => ({
        kind: d.category_group_code === "SW8" ? "station" : "place",
        label: d.place_name,
        sub: d.category_group_code === "SW8" ? "지하철역" : d.address_name.split(" ").slice(0, 3).join(" "),
        lat: Number(d.y),
        lng: Number(d.x),
        address: d.address_name,
      }))
    )
    .catch(() => []);
  cache.set(q, p);
  return p;
}

const ICON = { gu: "📍", station: "🚇", place: "🏢", recent: "🕘" };

export function attachSuggest({ input, box, onPick }) {
  let items = [];
  let active = -1;
  let timer = 0;
  let seq = 0;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const close = () => {
    box.hidden = true;
    active = -1;
    input.setAttribute("aria-expanded", "false");
  };
  const render = () => {
    if (!items.length) return close();
    box.innerHTML = items
      .map(
        (it, i) => `<li role="option" id="sg-${i}" data-i="${i}" aria-selected="${i === active}">
          <span class="sg-ic">${ICON[it.recent ? "recent" : it.kind]}</span>
          <span class="sg-main">${esc(it.label)}</span>
          ${it.sub ? `<span class="sg-sub">${esc(it.sub)}</span>` : ""}
        </li>`
      )
      .join("");
    box.hidden = false;
    input.setAttribute("aria-expanded", "true");
    input.setAttribute("aria-activedescendant", active >= 0 ? `sg-${active}` : "");
  };

  async function update() {
    const q = input.value.trim();
    const my = ++seq;
    if (!q) {
      items = recent.get().map((x) => ({ ...x, recent: true }));
      active = -1;
      return render();
    }
    const nq = norm(q);
    const gus = SEOUL_GU.filter((g) => norm(g).includes(nq) || norm(g.replace("서울 ", "")).startsWith(nq)).map((g) => ({ kind: "gu", label: g }));
    items = gus.slice(0, 3);
    active = items.length ? 0 : -1;
    render();
    if (q.length < 2) return;
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const places = await kakaoPlaces(q);
      if (my !== seq) return; // 더 최근 입력이 있음
      // 역 먼저, 장소는 상위 몇 개만
      const st = places.filter((p) => p.kind === "station").slice(0, 3);
      const pl = places.filter((p) => p.kind === "place").slice(0, 4);
      items = [...gus.slice(0, 2), ...st, ...pl].slice(0, 7);
      active = items.length ? 0 : -1;
      render();
    }, 300);
  }

  function pick(i) {
    const it = items[i];
    if (!it) return;
    const { recent: _r, ...clean } = it;
    recent.add(clean);
    input.value = it.label;
    close();
    onPick(clean);
  }

  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", box.id);
  input.addEventListener("input", update);
  input.addEventListener("focus", update);
  input.addEventListener("keydown", (e) => {
    if (box.hidden) return;
    if (e.key === "ArrowDown") (active = Math.min(items.length - 1, active + 1)), render(), e.preventDefault();
    else if (e.key === "ArrowUp") (active = Math.max(0, active - 1)), render(), e.preventDefault();
    else if (e.key === "Escape") close();
    else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      pick(active);
    }
  });
  // mousedown: input blur 전에 선택 처리
  box.addEventListener("mousedown", (e) => {
    const li = e.target.closest("[data-i]");
    if (li) {
      e.preventDefault();
      pick(Number(li.dataset.i));
    }
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  return { close };
}
