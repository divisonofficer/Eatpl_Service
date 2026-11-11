// K-EXAONE 2.5 호출 (OpenAI 호환 /v1/chat/completions) — 서버 전용. 키는 환경변수 EXAONE_API_KEY (브라우저에 노출 금지).
//
// 한도 보호 (응답 헤더 기준: 초당 1회 · 분당 60회 · 일일 한도가 낮을 수 있음 — 공식 문서 rate-limits 참고)
//  - 호출은 인스턴스 안에서 직렬화하고 1.1초 간격을 둔다
//  - 남은 일일 호출이 RESERVE 이하이면 호출하지 않는다 (다른 용도 몫을 남김)
//  - 429 를 받으면 retry-after 동안(기본 60초) 쿨다운
//  - 실패해도 호출자는 규칙 기반 결과로 폴백한다 (SkipError.reason 으로 이유 전달)
const ENDPOINT = "https://api.exaone.ai/v1/chat/completions";
const RESERVE = 5;
const STALE_MS = 60 * 60 * 1000;

const st = { dayRemaining: null, dayAt: 0, cooldownUntil: 0, last: 0, chain: Promise.resolve() };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SkipError extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// null = 호출 가능, 문자열 = 호출하지 않는 이유
export function unavailableReason() {
  if (process.env.ROOM_VERIFY === "off") return "off";
  if (!process.env.EXAONE_API_KEY) return "no-key";
  if (Date.now() < st.cooldownUntil) return "cooldown";
  if (st.dayRemaining != null && Date.now() - st.dayAt < STALE_MS && st.dayRemaining <= RESERVE) return "quota";
  return null;
}

export const status = () => ({ dayRemaining: st.dayRemaining, cooldownUntil: st.cooldownUntil });

export function chat({ messages, maxTokens = 2500, effort = "low", temperature = 0.2, timeoutMs = 40000 }) {
  const run = async () => {
    const why = unavailableReason();
    if (why) throw new SkipError(why);
    const wait = st.last + 1100 - Date.now();
    if (wait > 0) await sleep(wait);
    // 5xx(서비스 일시 장애)는 1.5초 뒤 한 번만 다시 시도
    let res;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(1500);
      st.last = Date.now();
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${process.env.EXAONE_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "k-exaone_v2.5", messages, max_tokens: maxTokens, reasoning_effort: effort, temperature, stream: false }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status < 500) break;
    }
    const rem = res.headers.get("x-day-rate-limit-remaining");
    if (rem != null && Number.isFinite(Number(rem))) {
      st.dayRemaining = Number(rem);
      st.dayAt = Date.now();
    }
    if (res.status === 429) {
      const sec = Math.min(3600, Number(res.headers.get("retry-after")) || 60);
      st.cooldownUntil = Date.now() + sec * 1000;
      throw new SkipError("rate-limited");
    }
    if (!res.ok) throw new Error(`exaone ${res.status}`);
    const j = await res.json();
    return { content: String(j.choices?.[0]?.message?.content ?? "").trim(), usage: j.usage || null };
  };
  const p = st.chain.then(run, run);
  st.chain = p.catch(() => {});
  return p;
}
