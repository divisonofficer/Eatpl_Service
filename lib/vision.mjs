// 사진 내용 검사 (서버) — onnxruntime-web(WASM) + jpeg-js, Node 에서 실행. 순수 JS 라 Vercel 함수에 그대로 들어간다.
//  1) 얼굴 감지 (UltraFace RFB-320): 인물 사진 제외 (초상권·방송 캡처)
//  2) ImageNet 분류 (MobileNetV2 int8): 스티커·캐릭터·제품·문서류로 쏠린 사진 제외
// 기준값은 실데이터 68장 사람 검수로 정함: 얼굴 2/2 검출·오탐 0, 엉뚱한 사진 9/14 검출·오탐 1.
// 실패(다운로드·디코드·모델 오류)는 판정 보류(null) — 호출부에서 텍스트 검증 결과만으로 진행.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import jpeg from "jpeg-js";

export const FACE_SCORE = 0.97; // 이 점수 이상 얼굴이
export const FACE_AREA = 0.03; //   화면의 3% 이상이면 인물 사진
export const NEG_SUM = 0.3; // 스티커·제품·문서류 클래스 확률 합이 이 이상이면 엉뚱한 사진
const NEG_NAMES = [
  "envelope", "rubber eraser", "wall clock", "coffee mug", "packet", "carton", "hamper", "web site", "comic book", "book jacket",
  "crossword puzzle", "jersey", "sweatshirt", "groom", "mask", "wig", "bow tie", "suit", "lab coat", "T-shirt", "piggy bank", "teddy",
  "balloon", "pillow", "handkerchief", "doormat", "jigsaw puzzle", "binder", "notebook", "toilet tissue", "paper towel", "pencil box",
  "lipstick", "lotion", "sunscreen", "face powder", "perfume", "pill bottle", "Band Aid", "digital clock", "analog clock", "pinwheel",
  "candle", "hair slide", "ping-pong ball", "soap dispenser", "torch",
];

const file = (p) => fileURLToPath(new URL(p, import.meta.url));
let LABELS = null;
let NEG = null;
function labels() {
  if (!LABELS) {
    LABELS = readFileSync(file("../models/imagenet-labels.txt"), "utf8").trim().split("\n").map((l) => l.slice(10).split(",")[0].trim());
    NEG = NEG_NAMES.map((n) => LABELS.indexOf(n)).filter((i) => i >= 0);
  }
  return LABELS;
}

// ---------- 판정 (순수 함수) ----------
// faces: [{ s: 점수, a: 면적비 }], prob: ImageNet 1000 확률
export function judge({ faces, prob }) {
  labels();
  const face = faces.find((f) => f.s >= FACE_SCORE && f.a >= FACE_AREA);
  if (face) return { ok: false, reason: "face", faceArea: +face.a.toFixed(3) };
  const neg = NEG.reduce((s, i) => s + prob[i], 0);
  if (neg >= NEG_SUM) return { ok: false, reason: "offtopic", neg: +neg.toFixed(2) };
  let top = 0;
  for (let i = 1; i < prob.length; i++) if (prob[i] > prob[top]) top = i;
  return { ok: true, top: LABELS[top], p: +prob[top].toFixed(2), neg: +neg.toFixed(2) };
}

// ---------- 모델 ----------
let sessions = null;
async function load() {
  if (!sessions) {
    sessions = (async () => {
      const ort = await import("onnxruntime-web");
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = "error";
      const opt = { logSeverityLevel: 3 };
      const [face, mnet] = await Promise.all([
        ort.InferenceSession.create(readFileSync(file("../models/face.onnx")), opt),
        ort.InferenceSession.create(readFileSync(file("../models/mobilenet.onnx")), opt),
      ]);
      return { ort, face, mnet };
    })().catch((e) => {
      sessions = null;
      throw e;
    });
  }
  return sessions;
}

// RGBA → 크기 변환(bilinear) RGB float
function resize(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) * sh) / dh - 0.5, y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), ay = Math.min(1, Math.max(0, fy - y0));
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5, x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), ax = Math.min(1, Math.max(0, fx - x0));
      for (let c = 0; c < 3; c++) {
        const a = src[(y0 * sw + x0) * 4 + c], b = src[(y0 * sw + x1) * 4 + c], d = src[(y1 * sw + x0) * 4 + c], e = src[(y1 * sw + x1) * 4 + c];
        out[(y * dw + x) * 3 + c] = (a * (1 - ax) + b * ax) * (1 - ay) + (d * (1 - ax) + e * ax) * ay;
      }
    }
  }
  return out;
}
function chw(rgb, w, h, f) {
  const t = new Float32Array(3 * w * h);
  for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) t[c * w * h + i] = f(rgb[i * 3 + c], c);
  return t;
}
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

export async function analyzeJpeg(buf) {
  const { ort, face, mnet } = await load();
  const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 64 });
  const f = chw(resize(img.data, img.width, img.height, 320, 240), 320, 240, (v) => (v - 127) / 128);
  const fo = await face.run({ input: new ort.Tensor("float32", f, [1, 3, 240, 320]) });
  const sc = fo.scores.data, bx = fo.boxes.data, faces = [];
  for (let i = 0; i < sc.length / 2; i++) {
    const s = sc[i * 2 + 1];
    if (s < 0.7) continue;
    const a = Math.max(0, bx[i * 4 + 2] - bx[i * 4]) * Math.max(0, bx[i * 4 + 3] - bx[i * 4 + 1]);
    faces.push({ s, a });
  }
  const m = chw(resize(img.data, img.width, img.height, 224, 224), 224, 224, (v, c) => (v / 255 - MEAN[c]) / STD[c]);
  const mo = await mnet.run({ [mnet.inputNames[0]]: new ort.Tensor("float32", m, [1, 3, 224, 224]) });
  const lg = mo[mnet.outputNames[0]].data;
  let mx = -Infinity;
  for (const v of lg) mx = Math.max(mx, v);
  const ex = Array.from(lg, (v) => Math.exp(v - mx));
  const sum = ex.reduce((a, b) => a + b, 0);
  return { faces, prob: ex.map((v) => v / sum) };
}

// 카카오 검색 썸네일만 허용 (130px → 320px 로 받아 분석). 분석 결과({faces, prob})를 캐시해 사진 판정·메뉴판 판정이 함께 쓴다
const cache = new Map();
function analyzeThumb(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return Promise.resolve(null);
  }
  if (!/^search\d\.kakaocdn\.net$/.test(u.hostname)) return Promise.resolve(null);
  const big = url.replace("/130x130_85_c/", "/320x320_85_c/");
  if (cache.has(big)) return cache.get(big);
  const p = (async () => {
    const r = await fetch(big, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    return analyzeJpeg(Buffer.from(await r.arrayBuffer()));
  })().catch(() => null);
  cache.set(big, p);
  if (cache.size > 3000) cache.delete(cache.keys().next().value);
  return p;
}

export async function checkThumb(url) {
  const a = await analyzeThumb(url);
  return a ? judge(a) : null;
}

// 메뉴판 여부: ImageNet 'menu' 클래스 확률. 기준값은 종로구 고깃집 30곳 썸네일 131장 실측
// (OCR 가격 줄 2개 이상을 메뉴판으로 본 기준: ≥ 0.3 이면 메뉴판 93% 잡음, 통과분의 64% 가 메뉴판)
export const MENU_MIN = 0.3;
export function menuScore(prob) {
  const i = labels().indexOf("menu");
  return i >= 0 && prob ? prob[i] : null;
}
export async function menuProb(url) {
  const a = await analyzeThumb(url);
  return a ? menuScore(a.prob) : null;
}
