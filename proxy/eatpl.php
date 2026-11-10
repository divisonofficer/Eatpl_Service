<?php
// 닷홈 무료 호스팅용 EatPL 프록시 — API 정의서 v1 (2026.08) 기준
// 브라우저 → (이 파일, 고정 IP) → api.paybooc.ai. CORS 처리 + instNm/trnsTrceNo 부착.
//
// 클라이언트 요청 (POST JSON):
//   { "location": "서울 종로구", "merTpbuzNm": "고기구이" }   → POST /v1/search
//   { "merNm": "부촌" }                                       → POST /v1/search
//   { "keyword": "회식", "location": "서울 종로구" }          → GET  /v1/search?keyword=&location=
//
// TODO 배포 전: INST_NM(제휴 시 발급), TOKEN, ALLOW_ORIG, BASE(개발→운영 전환). 닷홈 서버 IP를 BC카드에 등록.

const BASE = 'https://dev-api.paybooc.ai/api/mer';  // 운영: https://api.paybooc.ai/api/mer
const INST_NM = 'YOUR_INST_NM';
const TOKEN = 'change-me';
const ALLOW_ORIG = ['https://YOUR_GH_ID.github.io', 'http://localhost:8000', 'http://localhost:8765'];

function out($code, $json) { http_response_code($code); echo is_string($json) ? $json : json_encode($json, JSON_UNESCAPED_UNICODE); exit; }

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (in_array($origin, ALLOW_ORIG, true)) header("Access-Control-Allow-Origin: $origin");
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type, X-Demo-Token');
header('Content-Type: application/json; charset=utf-8');
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') exit;

if (!in_array($origin, ALLOW_ORIG, true) || ($_SERVER['HTTP_X_DEMO_TOKEN'] ?? '') !== TOKEN)
  out(403, ['rspCode' => 'P0403', 'rspMessage' => 'proxy: forbidden']);

$in = json_decode(file_get_contents('php://input'), true) ?: [];
$pick = fn($k) => isset($in[$k]) && is_string($in[$k]) && $in[$k] !== '' ? mb_substr($in[$k], 0, 50) : null;

// 거래추적번호: {instNm}{YYYYMMDD}{10자리 seq}  — seq = HHMMSS + 4자리 난수
$trace = INST_NM . date('Ymd') . date('His') . str_pad((string)random_int(0, 9999), 4, '0', STR_PAD_LEFT);

if ($kw = $pick('keyword')) {
  // GET 키워드 검색: 정의서상 파라미터는 keyword/location만 명시. instNm/trnsTrceNo 필요 여부는 연동 시 확인.
  $q = array_filter(['keyword' => $kw, 'location' => $pick('location'), 'instNm' => INST_NM, 'trnsTrceNo' => $trace]);
  $ch = curl_init(BASE . '/v1/search?' . http_build_query($q));
} else {
  $body = array_filter(['merNm' => $pick('merNm'), 'location' => $pick('location'), 'merTpbuzNm' => $pick('merTpbuzNm')]);
  if (!$body) out(400, ['rspCode' => 'P0400', 'rspMessage' => 'proxy: merNm/location/merTpbuzNm 중 하나 필요']);
  $ch = curl_init(BASE . '/v1/search');
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode(['trnsTrceNo' => $trace, 'instNm' => INST_NM] + $body, JSON_UNESCAPED_UNICODE),
  ]);
}
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 10]);
$res = curl_exec($ch);
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($res === false || $status >= 400)
  out(502, ['rspCode' => 'P0502', 'rspMessage' => "proxy: upstream $status " . mb_substr((string)$res, 0, 100)]);
echo $res;
