// 사용: npm start 후 node tools/e2e-mobile.mjs [url]  → 스크린샷 /tmp/hoesikpick-e2e/*.png
// CDP로 모바일 에뮬레이션 + 상호작용 검증
import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync("/tmp/hoesikpick-e2e", { recursive: true });
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 9333;
const proc = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, "--user-data-dir=/tmp/hoesikpick-e2e/prof", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let targets;
for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); break; } catch { await sleep(250); } }
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const logs = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } if (d.method === "Runtime.consoleAPICalled") logs.push(d.params.args.map((a) => a.value ?? a.description).join(" ")); if (d.method === "Runtime.exceptionThrown") logs.push("EXC " + JSON.stringify(d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const shot = async (name) => { const r = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`/tmp/hoesikpick-e2e/${name}.png`, Buffer.from(r.result.data, "base64")); };
const tap = async (x, y) => { for (const type of ["touchStart", "touchEnd"]) await send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x, y }] }); };
const mouseDrag = async (x, y0, y1, steps = 8, dt = 16) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y: y0, button: "left", clickCount: 1 });
  for (let i = 1; i <= steps; i++) { await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y: y0 + ((y1 - y0) * i) / steps, button: "left", buttons: 1 }); await sleep(dt); }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y: y1, button: "left", clickCount: 1 });
};

await send("Runtime.enable"); await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
await send("Page.navigate", { url: process.argv[2] || "http://localhost:8000/" });
for (let i = 0; i < 60; i++) { await sleep(300); if (await ev(`document.querySelectorAll('.card').length > 0`)) break; }
await sleep(1200);
const info = () => ev(`({snap: document.getElementById('sheet').dataset.snap, top: Math.round(document.getElementById('sheet').getBoundingClientRect().top), searchBottom: Math.round(document.getElementById('top').getBoundingClientRect().bottom), count: document.getElementById('resultCount').textContent, open: document.querySelector('.card.open .name')?.textContent || null, cand: document.getElementById('candCount').textContent, listScroll: document.getElementById('results').scrollTop, bodyScroll: document.scrollingElement.scrollTop})`);
const R = {};
R.initial = await info(); await shot("01-initial");

// 1) 시트 헤더 위로 드래그 → full
const t = R.initial.top;
await mouseDrag(195, t + 30, 120, 10, 30); await sleep(500);
R.dragUp = await info(); await shot("02-full");

// 2) 목록 스크롤이 시트 안에서만
await ev(`document.getElementById('results').scrollBy(0, 400)`); await sleep(200);
R.listScrolled = await info();

// 3) 헤더 아래로 드래그 → 아래 스냅
const t2 = R.listScrolled.top;
await mouseDrag(195, t2 + 30, 820, 10, 30); await sleep(500);
R.dragDown = await info(); await shot("03-peek");

// 4) 지도 핀 탭 → half + 카드 열림
const pin = await ev(`(() => { const el = [...document.querySelectorAll('.pin')].find(p => { const r = p.getBoundingClientRect(); return r.top > 180 && r.bottom < ${R.dragDown.top} - 10; }); if (!el) return null; const r = el.getBoundingClientRect(); return {x: r.left + r.width/2, y: r.top + r.height/2, text: el.textContent}; })()`);
R.pin = pin;
if (pin) { await tap(pin.x, pin.y); await sleep(1200); }
R.afterPinTap = await info();
R.activePinVisible = await ev(`(() => { const p = document.querySelector('.pin-active'); if (!p) return null; const r = p.getBoundingClientRect(); return {y: Math.round(r.top), aboveSheet: r.bottom < document.getElementById('sheet').getBoundingClientRect().top, belowSearch: r.top > document.getElementById('top').getBoundingClientRect().bottom}; })()`);
await sleep(1500);
R.kakaoHref = await ev(`document.querySelector('.card.open [data-kakao]')?.href`);
await shot("04-pin");

// 5) 후보 담기 2곳 → 안내문
await ev(`document.querySelectorAll('.add')[0].click()`); await ev(`document.querySelectorAll('.add')[1].click()`); await sleep(200);
await ev(`document.getElementById('candBtn').click()`); await sleep(300);
R.dialog = await ev(`({open: document.getElementById('msgDialog').open, msg: document.getElementById('message').value.slice(0, 160)})`);
await shot("05-dialog");

// 6) 공유 링크 → 새로 열기 → 공유 모드
R.shareLink = await ev(`(document.getElementById('message').value.match(/https?:\\/\\/\\S+share=\\S+/) || [])[0] || null`);
await ev(`document.getElementById('msgDialog').close()`);
// 7) 잇플 상세 모달 (iframe = merUrl 원본)
await ev(`document.querySelector('.card.open [data-eatpl].cta, [data-eatpl]').click()`); await sleep(300);
const wantUrl = await ev(`document.getElementById('epFrame').getAttribute('src')`);
for (let i = 0; i < 30 && !(await ev(`document.getElementById('epLoading').hidden`)); i++) await sleep(300);
R.eatplModal = await ev(`({ open: document.getElementById('eatplDialog').open, src: document.getElementById('epFrame').src, newTab: document.getElementById('epOpen').href, loaded: document.getElementById('epLoading').hidden })`);
R.eatplModal.srcIsMerUrl = /^https:\/\/web\.paybooc\.ai\/mer\/web\/profile\/[A-Za-z0-9_-]+$/.test(wantUrl) && R.eatplModal.src === wantUrl && R.eatplModal.newTab === wantUrl;
await sleep(1500); await shot("06-eatpl-modal");
await ev(`document.getElementById('epClose').click()`); await sleep(200);
R.afterClose = await ev(`({ open: document.getElementById('eatplDialog').open, src: document.getElementById('epFrame').src })`);
if (R.shareLink) {
  await send("Page.navigate", { url: R.shareLink });
  for (let i = 0; i < 30; i++) { await sleep(300); if (await ev(`document.querySelectorAll('.card').length > 0`)) break; }
  await sleep(800);
  R.sharedView = await ev(`({ title: document.getElementById('resultCount').textContent, badge: document.getElementById('statusBadge').textContent, cards: [...document.querySelectorAll('.card .name')].map(n => n.textContent), urls: [...document.querySelectorAll('.sublinks a[target]')].map(a => a.href).filter(h => h.includes('paybooc')) })`);
  await shot("07-shared");
}

// 8) 현위치 (GPS 에뮬레이션: 을지로3가역 부근)
await send("Browser.grantPermissions", { permissions: ["geolocation"], origin: new URL(process.argv[2] || "http://localhost:8000/").origin });
await send("Emulation.setGeolocationOverride", { latitude: 37.5663, longitude: 126.9918, accuracy: 30 });
await send("Page.navigate", { url: process.argv[2] || "http://localhost:8000/" });
for (let i = 0; i < 40; i++) { await sleep(300); if (await ev(`document.querySelectorAll('.card').length > 0`)) break; }
await sleep(800);
await ev(`document.getElementById('locateBtn').click()`);
for (let i = 0; i < 40; i++) { await sleep(300); if (await ev(`document.getElementById('resultCount').textContent.includes('📍')`)) break; }
await sleep(1500);
R.locate = await ev(`({
  title: document.getElementById('resultCount').textContent,
  loc: document.getElementById('loc').value,
  btnOn: document.getElementById('locateBtn').classList.contains('on'),
  meDot: !!document.querySelector('.me-dot'),
  dists: [...document.querySelectorAll('.card .dist')].slice(0, 6).map(d => d.textContent),
  photoPins: document.querySelectorAll('.pin-photo').length,
})`);
await shot("08-locate");

console.log(JSON.stringify(R, null, 2));
console.log("console:", logs.slice(0, 10));
ws.close(); proc.kill();
