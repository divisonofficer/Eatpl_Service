// 법인 형태 표기 제거 — 정규식 기반, 브라우저·서버 공용 (정본은 이 파일: lib/photos.mjs 가 가져다 쓴다)
//  "주식회사 달그리고나무" → "달그리고나무", "송추가마골인어반/동경（주）" → "송추가마골인어반/동경"
// 잇플 가맹점명은 상호가 아니라 사업자(법인)명으로 오는 경우가 있다. 검색·매칭·AI 프롬프트·화면 표시에 상호만 쓴다.
// 지점명 괄호("(길동점)")는 건드리지 않는다.
const FORMS = [
  "주식회사", "유한회사", "유한책임회사", "합자회사", "합명회사", "농업회사법인", "어업회사법인", "영농조합법인", "영어조합법인",
  String.raw`[(（]\s*[주유]\s*[)）]`, // (주) (유) （주） （유） — 반각·전각 괄호
  "㈜", "㈲",
].join("|");

// g 플래그: replace 용. test() 로 쓸 때는 lastIndex 를 0 으로 되돌릴 것 (isLegalName 이 처리)
export const LEGAL_RE = new RegExp(FORMS, "g");

export const isLegalName = (name) => new RegExp(FORMS).test(String(name ?? ""));

export function cleanName(name) {
  const raw = String(name ?? "").trim();
  const out = raw
    .replace(LEGAL_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s/·\-,]+|[\s/·\-,]+$/g, "") // 법인 표기를 떼고 남은 가장자리 구분 기호
    .trim();
  return out || raw; // 전부 지워지면 원본 유지
}
