// 로컬 개발 서버 (의존성 없음): npm start → http://localhost:8000
//  - 정적 파일 + /api/* (lib/relay.mjs — Vercel 함수와 같은 코드)
//  - .env 의 KAKAO_REST_KEY 등을 읽는다 (Vercel 에서는 프로젝트 환경변수)
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

try { process.loadEnvFile(fileURLToPath(new URL(".env", import.meta.url))); } catch {}
const { handleApi, API_PATHS } = await import("./lib/relay.mjs");

const PORT = Number(process.env.PORT || 8000);
const ROOT = fileURLToPath(new URL(".", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml",
};
// 배포에서도 빠지는 경로 (.vercelignore 와 맞춤)
const HIDDEN = /\/(\.git|\.env|tools|test|proxy|docs|lib|api)(\/|$)|\/server\.mjs$/;

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (API_PATHS.includes(url.pathname)) {
    const r = await handleApi(url.pathname, url.searchParams, req.headers);
    res.writeHead(r.status, r.headers);
    return res.end(r.body);
  }
  const path = normalize(join(ROOT, decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname)));
  if (!path.startsWith(ROOT) || HIDDEN.test(path.slice(ROOT.length - 1))) {
    res.writeHead(404);
    return res.end("not found");
  }
  try {
    const data = await readFile(path);
    res.writeHead(200, { "content-type": MIME[extname(path)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => console.log(`회식픽 → http://localhost:${PORT}`));
