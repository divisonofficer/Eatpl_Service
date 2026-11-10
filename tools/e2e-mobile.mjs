// 사용: npm run dev 후 npm run e2e [url]  → 스크린샷 /tmp/hoesikpick-e2e/*.png
// 모바일(390×844, 터치) 시나리오: 목록 → 핀 → 미리보기 넘기기 → 잇플 모달 → 상세 → 후보 → 결정·공유 → 공유 링크
//                                → 필터 → 현위치(GPS 에뮬) → 1차→2차 → 검색어 추천
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
const URL0 = process.argv[2] || "http://localhost:8000/";
const OUT = "/tmp/hoesikpick-e2e";
mkdirSync(OUT, { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${OUT}/prof`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
const ws = new WebSocket(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === "Runtime.exceptionThrown") errors.push(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => writeFileSync(`${OUT}/${name}.png`, Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
const until = async (expr, ms = 12000) => { for (let t = 0; t < ms; t += 250) { if (await ev(expr)) return true; await sleep(250); } return false; };
const tap = async (x, y) => { await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] }); await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); };
const drag = async (x, y0, y1) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: y0, button: "left", clickCount: 1 });
  for (let i = 1; i <= 10; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y0 + ((y1 - y0) * i) / 10, button: "left", buttons: 1 }); await sleep(30); }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: y1, button: "left", clickCount: 1 });
};
const load = async (url) => { await send("Page.navigate", { url }); await until(`document.querySelectorAll('.row').length > 0`, 20000); await sleep(1000); };
const R = {};
const check = (name, ok, info) => (R[name] = { ok: !!ok, ...(info !== undefined ? { info } : {}) });

await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Browser.grantPermissions", { permissions: ["geolocation"], origin: new URL(URL0).origin });
await send("Emulation.setGeolocationOverride", { latitude: 37.5663, longitude: 126.9918, accuracy: 30 });

// 1) 목록 + 시트 드래그
await load(URL0); await sleep(2500); await shot("01-list");
const top0 = await ev(`Math.round(document.getElementById('sheet').getBoundingClientRect().top)`);
await drag(195, top0 + 25, 150); await sleep(500);
const topFull = await ev(`Math.round(document.getElementById('sheet').getBoundingClientRect().top)`);
await drag(195, topFull + 25, 820); await sleep(500);
const topPeek = await ev(`Math.round(document.getElementById('sheet').getBoundingClientRect().top)`);
check("sheetSnap", topFull < top0 && topPeek > top0, { half: top0, full: topFull, peek: topPeek });

// 2) 핀 탭 → 미리보기 카드 + 선택 핀 미니 카드
const pin = await ev(`(() => { const e = [...document.querySelectorAll('.mk-pin')].find(p => { const r = p.getBoundingClientRect(); return r.top > 150 && r.bottom < innerHeight - 160; }); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
if (pin) await tap(pin.x, pin.y);
await until(`!document.getElementById('preview').hidden`); await sleep(900); await shot("02-preview");
const pv = await ev(`({ cards: document.querySelectorAll('.pv-card').length, pop: !!document.querySelector('.mk.is-active .mk-pop'), sheetHidden: document.body.classList.contains('previewing') })`);
check("pinToPreview", pin && pv.cards > 0 && pv.pop && pv.sheetHidden, pv);

// 3) 카드 넘기기 → 선택 매장 변경
const before = await ev(`document.querySelector('.mk.is-active .mk-pop b')?.textContent`);
await ev(`(() => { const t = document.getElementById('pvTrack'); const cards = [...t.children]; const cur = cards.findIndex(c => c.querySelector('h3')?.textContent === document.querySelector('.mk.is-active .mk-pop b')?.textContent); const c = cards[(cur + 1) % cards.length]; t.scrollTo({ left: c.offsetLeft - (t.clientWidth - c.offsetWidth) / 2 }); })()`);
await sleep(900);
const after = await ev(`document.querySelector('.mk.is-active .mk-pop b')?.textContent`);
check("swipeSync", before && after && before !== after, { before, after });

// 4) 잇플 모달 = merUrl 원본
await ev(`document.querySelector('.pv-card .btn-primary[data-eatpl]').click()`);
await until(`document.getElementById('epLoading').hidden`, 15000);
const ep = await ev(`({ open: document.getElementById('eatplDialog').open, src: document.getElementById('epFrame').getAttribute('src'), tab: document.getElementById('epOpen').href })`);
check("eatplMerUrl", ep.open && /^https:\/\/web\.paybooc\.ai\/mer\/web\/profile\/[A-Za-z0-9_-]+$/.test(ep.src) && ep.src === ep.tab, ep.src);
await shot("03-eatpl");
await ev(`document.getElementById('epClose').click()`); await sleep(200);
check("eatplClose", (await ev(`document.getElementById('epFrame').src`)) === "about:blank");

// 5) 상세 → 후보 담기
await ev(`document.querySelector('.pv-card [data-detail]').click()`); await sleep(1500); await shot("04-detail");
const dt = await ev(`({ open: document.getElementById('detail').open, map: !!document.querySelector('#dtMap .leaflet-tile-pane img') })`);
check("detail", dt.open && dt.map, dt);
await ev(`document.querySelector('#detail .dt-bar [data-add]').click()`); await sleep(200);
await ev(`document.getElementById('detail').close()`); await sleep(200);
check("candidateAdded", (await ev(`document.getElementById('candCount').textContent`)) === "1");

// 6) 결정·공유 (1차 → 근처 2차 추천)
await ev(`document.getElementById('preview').hidden || document.getElementById('map').click()`);
await ev(`document.getElementById('candBtn').click()`);
await until(`document.querySelectorAll('.nb-card:not(.skel)').length > 0`, 15000); await sleep(600);
await ev(`document.querySelector('.nb-card [data-add-second]')?.click()`); await sleep(300); await shot("05-decide");
const dc = await ev(`({ items: document.querySelectorAll('.dc-item').length, msg: document.getElementById('message').value })`);
const link = (dc.msg.match(/https?:\/\/\S+share=\S+/) || [])[0];
check("decide", dc.items === 2 && /\[1차\][\s\S]*\[2차\]/.test(dc.msg) && link, { items: dc.items });
// 단톡방 공유: navigator.share 를 가로채 데이터 형식 확인 (본문 + url 분리)
const shared = await ev(`(async () => {
  let got = null;
  Object.defineProperty(navigator, 'share', { configurable: true, value: async (d) => { got = d; } });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  document.getElementById('shareBtn').click();
  await new Promise(r => setTimeout(r, 200));
  return got && { title: got.title, url: got.url, textHasUrl: (got.text || '').includes('share='), textEnd: (got.text || '').slice(-12) };
})()`);
check("shareData", shared && /share=/.test(shared.url) && !shared.textHasUrl, shared);
await ev(`document.getElementById('decide').close()`);

// 7) 공유 링크로 진입
await send("Page.navigate", { url: link }); await until(`document.querySelectorAll('.row').length > 0`); await sleep(800);
const sh = await ev(`({ title: document.getElementById('resultCount').textContent, rows: document.querySelectorAll('.row').length })`);
check("sharedLink", sh.rows === 2 && sh.title.includes("공유"), sh);

// 8) 필터: 치킨만 → 적용
await load(URL0);
await ev(`document.getElementById('filterBtn').click()`); await sleep(300);
// 타일을 누를 때마다 다시 그려지므로 매번 새로 찾는다
for (let k = 0; k < 20 && (await ev(`!!document.querySelector('.cat-tile[aria-pressed=true]')`)); k++) await ev(`document.querySelector('.cat-tile[aria-pressed=true]').click()`);
await ev(`[...document.querySelectorAll('.cat-tile')].find(b => b.textContent.trim() === '치킨').click()`);
await shot("06-filter");
await ev(`document.getElementById('filterApply').click()`);
await until(`!document.getElementById('resultCount').textContent.includes('검색 중')`); await sleep(800);
const fl = await ev(`({ count: document.getElementById('filterCount').textContent, cats: [...new Set([...document.querySelectorAll('.row')].map(r => { const m = r.querySelector('.meta').cloneNode(true); m.querySelectorAll('.tier,.dist').forEach(x => x.remove()); return m.textContent.split('·').map(x => x.trim()).filter(Boolean)[0]; }))] })`);
check("filter", fl.count === "1" && fl.cats.length === 1 && fl.cats[0] === "치킨", fl);

// 9) 현위치
await load(URL0);
await ev(`document.getElementById('locateBtn').click()`);
await until(`document.getElementById('resultCount').textContent.includes('을지로3가')`, 15000); await sleep(800);
const lc = await ev(`({ title: document.getElementById('resultCount').textContent, me: !!document.querySelector('.me-dot'), dist: document.querySelector('.row .dist')?.textContent })`);
check("locate", lc.me && lc.dist, lc); await shot("07-locate");

// 10) 1차 → 2차
await load(URL0);
await ev(`document.querySelector('.row').click()`); await sleep(700);
await ev(`document.querySelector('.pv-card [data-next]').click()`);
await until(`document.getElementById('resultCount').textContent.includes('근처')`, 15000); await sleep(800);
const ss = await ev(`({ tab: document.querySelector('#modePicker .pk-cur').textContent.trim(), title: document.getElementById('resultCount').textContent, walk: document.querySelector('.row .dist')?.textContent, origin: !!document.querySelector('.origin-mk') })`);
check("secondStop", ss.tab === "2차" && /도보/.test(ss.walk || "") && ss.origin, ss); await shot("08-second");

// 11) 검색어 추천
await ev(`(() => { const i = document.getElementById('loc'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
await send("Input.insertText", { text: "천호역" });
await until(`[...document.querySelectorAll('#suggest li')].some(l => l.textContent.includes('지하철역'))`);
await shot("09-suggest");
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
await until(`document.getElementById('resultCount').textContent.includes('천호')`, 15000);
check("suggest", await ev(`document.getElementById('resultCount').textContent.includes('천호')`));

// 12) 추천이 뜨기 전에 바로 Enter → 첫 역으로 해석
await load(URL0);
await ev(`(() => { const i = document.getElementById('loc'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
await send("Input.insertText", { text: "강남역" });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
await until(`document.getElementById('resultCount').textContent.includes('강남역')`, 15000);
check("enterBeforeSuggest", await ev(`document.getElementById('resultCount').textContent.includes('강남역')`), await ev(`document.getElementById('resultCount').textContent`));

// 13-0) 결과가 많이 보이는 곳에서 살짝 옮기면 버튼 없음
await load(URL0); await sleep(1500);
await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 200, y: 300, button: "left", clickCount: 1 });
for (let i = 1; i <= 6; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 200 - i * 6, y: 300, button: "left", buttons: 1 }); await sleep(20); }
await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 164, y: 300, button: "left", clickCount: 1 }); await sleep(800);
check("manyVisibleNoButton", await ev(`document.getElementById('areaBtn').hidden`));

// 13) 지도를 끌어 옮기면 '이 지역에서 검색' → 보이는 영역 안의 매장
await load(URL0); await sleep(1500);
const btnBefore = await ev(`document.getElementById('areaBtn').hidden`);
// 결과가 거의 없는 곳까지 (두 번 크게 끌기)
for (let k = 0; k < 2; k++) {
  // 현위치 버튼(오른쪽 아래)·상단 버튼을 피해 지도 빈 곳에서 시작
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: 280, y: 330, button: "left", clickCount: 1 });
  for (let i = 1; i <= 12; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 280 - i * 21, y: 330 - i * 14, button: "left", buttons: 1 }); await sleep(20); }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 28, y: 162, button: "left", clickCount: 1 }); await sleep(500);
}
await until(`!document.getElementById('areaBtn').hidden`, 4000);
const shown = await ev(`!document.getElementById('areaBtn').hidden`);
const btnPos = await ev(`(() => { const r = document.getElementById('areaBtn').getBoundingClientRect(); return { y: Math.round(r.top), sheetTop: Math.round(document.getElementById('sheet').getBoundingClientRect().top) }; })()`);
await shot("10-area-btn");
await ev(`document.getElementById('areaBtn').click()`);
await until(`document.getElementById('resultCount').textContent.includes('일대')`, 20000); await sleep(800);
const area = await ev(`(() => { const m = document.querySelector('#map')._leaflet_id; return { title: document.getElementById('resultCount').textContent, rows: document.querySelectorAll('.row').length, hidden: document.getElementById('areaBtn').hidden }; })()`);
check("searchThisArea", btnBefore && shown && area.title.includes("일대") && area.hidden && btnPos.y > btnPos.sheetTop - 70 && btnPos.y < btnPos.sheetTop, { ...area, btnPos });
// 확대만 하면(검색 영역 안을 보는 것) 버튼 없음
await ev(`document.querySelector('.leaflet-control-zoom-in')?.click() || document.querySelector('#map')`);
await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 195, y: 300, deltaX: 0, deltaY: -600 }); await sleep(1200);
check("zoomInNoButton", await ev(`document.getElementById('areaBtn').hidden`));
await shot("11-area");

// 14) 모드·인원 펼침 버튼: 접힘 → 펼침(4개/5개) → 선택 → 접힘 + 재검색
await load(URL0);
await ev(`document.querySelector('#modePicker .pk-cur').click()`); await sleep(300);
const modeOpen = await ev(`document.querySelectorAll('#modePicker [data-k]').length`);
await shot("12-picker-open");
await ev(`document.querySelector('#modePicker [data-k=lunch]').click()`);
await until(`!document.getElementById('resultCount').textContent.includes('검색')`, 15000); await sleep(500);
const modeAfter = await ev(`({ cur: document.querySelector('#modePicker .pk-cur')?.textContent.trim(), closed: !document.getElementById('modePicker').classList.contains('open'), title: document.getElementById('resultCount').textContent })`);
await ev(`document.querySelector('#sizePicker .pk-cur').click()`); await sleep(300);
const sizeOpen = await ev(`document.querySelectorAll('#sizePicker [data-k]').length`);
await ev(`document.querySelector('#sizePicker [data-k="2"]').click()`); await sleep(400);
const sizeCur = await ev(`document.querySelector('#sizePicker .pk-cur')?.textContent.trim()`);
check("pickers", modeOpen === 4 && modeAfter.cur === "점심 회식" && modeAfter.closed && sizeOpen === 5 && sizeCur === "둘이서", { modeOpen, modeAfter, sizeOpen, sizeCur });

// 15) 룸·주차 동시 필터: 켜면 목록이 '있어요' 매장으로 줄고, 끄면 원래대로
await load(URL0); await until(`!document.querySelector('.tile.skel')`, 15000); await sleep(800);
const n0 = await ev(`document.querySelectorAll('.row').length`);
await ev(`document.querySelector('[data-pref=room]').click()`); await sleep(300);
await ev(`document.querySelector('[data-pref=park]').click()`);
await until(`!document.getElementById('resultCount').textContent.includes('확인 중')`, 30000); await sleep(800);
const f = await ev(`({ title: document.getElementById('resultCount').textContent, rows: document.querySelectorAll('.row').length, allOn: [...document.querySelectorAll('.row')].every(r => r.querySelectorAll('.am-b.on').length >= 2) })`);
await ev(`document.querySelector('[data-pref=room]').click()`); await ev(`document.querySelector('[data-pref=park]').click()`); await sleep(600);
const n1 = await ev(`document.querySelectorAll('.row').length`);
// 필터를 끈 목록에서 (정밀 확인 끝난) 주차 가능 매장 수 == 주차 필터 결과 수
await ev(`document.querySelector('[data-pref=park]').click()`);
await until(`!document.getElementById('resultCount').textContent.includes('확인 중')`, 60000); await sleep(600);
const parkOn = await ev(`document.querySelectorAll('.row').length`);
await ev(`document.querySelector('[data-pref=park]').click()`); await sleep(600);
const parkAll = await ev(`[...document.querySelectorAll('.row')].filter(r => [...r.querySelectorAll('.am-b.on')].some(b => b.textContent.includes('주차'))).length`);
check("parkFilterConsistent", parkOn === parkAll && parkOn > 0, { parkOn, parkAll });
check("prefFilter", f.title.includes("룸·주차") && f.rows <= n0 && f.allOn && n1 === n0, { n0, ...f, n1 });

// 16) 추천 이유 + 요일 선택 (휴무 제외)
await load(URL0); await until(`!document.querySelector('.tile.skel')`, 15000); await sleep(500);
const why = await ev(`[...document.querySelectorAll('.row .why')].slice(0, 3).map(w => w.textContent.trim())`);
await ev(`document.querySelector('#dayPicker .pk-cur').click()`); await sleep(300);
const dayOpts = await ev(`document.querySelectorAll('#dayPicker [data-k]').length`);
await ev(`document.querySelector('#dayPicker [data-k="일"]').click()`);
await until(`!document.getElementById('resultCount').textContent.includes('검색')`, 15000); await sleep(600);
const sun = await ev(`({ cur: document.querySelector('#dayPicker .pk-cur').textContent.trim(), sub: document.getElementById('headSub').textContent })`);
check("recommendWhy", why.length > 0 && why.every((w) => w.length > 0) && dayOpts === 8 && sun.cur === "일요일", { why, sun });

// 17) 결과 0곳이어도 검색한 곳으로 지도 이동 (독도: 주변 반경에 매장 없음)
await load(URL0);
const c0 = await ev(`(() => { const c = window.__hp.map.getCenter(); return [c.lat, c.lng]; })()`);
await ev(`(() => { const i = document.getElementById('loc'); i.focus(); i.value = ''; i.dispatchEvent(new Event('input')); })()`);
await send("Input.insertText", { text: "독도" });
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
await until(`document.getElementById('resultCount').textContent.startsWith('0곳')`, 20000); await sleep(1800);
const c1 = await ev(`(() => { const c = window.__hp.map.getCenter(); return [c.lat, c.lng]; })()`);
check("emptyMoves", (await ev(`document.getElementById('resultCount').textContent`)).startsWith("0곳") && c1[1] > 131 && c1[0] > 37, { title: await ev(`document.getElementById('resultCount').textContent`), from: c0, to: c1 });
await shot("13-empty-move");

check("noErrors", errors.length === 0, errors.slice(0, 3));
const failed = Object.entries(R).filter(([, v]) => !v.ok);
console.log(JSON.stringify(R, null, 2));
console.log(failed.length ? `FAIL ${failed.map(([k]) => k).join(", ")}` : `ALL PASS (${Object.keys(R).length})`);
ws.close(); proc.kill();
process.exitCode = failed.length ? 1 : 0;
