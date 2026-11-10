// Vercel Node 함수 어댑터: api/*.mjs 가 경로만 넘긴다. 로직은 lib/relay.mjs
import { handleApi } from "./relay.mjs";

export const serve = (path) => async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const r = await handleApi(path, url.searchParams, req.headers);
  res.statusCode = r.status;
  for (const [k, v] of Object.entries(r.headers)) res.setHeader(k, v);
  res.end(r.body);
};
