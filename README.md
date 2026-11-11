# 회식픽 (가칭) — 로컬 데모

조건 입력 → 지도에서 고르기 → 단톡방 문구 복사. 빌드 없는 Vanilla JS 정적 앱.

## 실행

```bash
npm install          # onnxruntime-web, jpeg-js (사진 내용 검사)
npm run dev          # = node server.mjs → http://localhost:8000 (Node 22+)
npm test             # 사진 필터 단위 테스트
npm run e2e          # 모바일 e2e (서버 실행 중일 때)
```

- 기본: **실데이터** — 로컬 서버가 `/api/eatpl/search`를 [k-skill-proxy](https://github.com/NomaDamas/k-skill)
  (`bccard-eatpl-search`)로 중계. k-skill-proxy는 CORS 헤더가 없어 브라우저 직접 호출 불가라 로컬 중계가 필요
- 실패 시 자동으로 모의 데이터 폴백 (상단 배지로 표시). 강제 모의: `?source=mock`
- 정적 서버(`python3 -m http.server`)로 열면 중계가 없어 모의 데이터로 폴백됨
- 매장 사진(선택): `.env.example` → `.env` 복사 후 `KAKAO_REST_KEY` 입력 → 서버 재시작
- 모바일 동작 테스트: `node tools/e2e-mobile.mjs` (CDP, 390×844 터치 에뮬레이션, 스크린샷 `/tmp/hoesikpick-e2e/`)

## 구조

```
index.html            한 페이지 앱
css/style.css         모바일(바텀시트) / 데스크톱(좌측 패널)
js/app.js             UI: 지도·핀 겹침 정리·카드·잇플 모달·후보/공유·현위치·1차→2차
js/api.js             데이터 계층 (live | mock | proxy), 사진·행정구역 조회
js/modes.js           모드 4종(1차 회식·2차·점심 회식·야근 야식) 필터·정렬
js/format.js          표기, 안내문 템플릿
js/sheet.js           바텀시트 스냅
js/suggest.js         검색어 추천 (구·역·장소)
js/share.js           후보 공유 링크 (서버 저장 없음)
lib/relay.mjs         API 중계 + CDN 캐시 헤더 (로컬·Vercel 공용)
lib/photos.mjs        사진 텍스트 검증 (이름·주소·전화로 출처 글 검증)
lib/vision.mjs        사진 내용 검사 (얼굴 감지 + ImageNet 분류, onnxruntime-web WASM)
lib/amenities.mjs     룸·룸비·콜키지·주차 추출 (검증된 블로그 글 언급)
models/               ONNX 모델 (UltraFace, MobileNetV2 int8) — models/README.md
lib/vercel.mjs        Vercel 함수 어댑터
api/**.mjs            Vercel 함수 (경로만 지정)
server.mjs            로컬 개발 서버 (배포 제외)
data/mock.json        모의 데이터 (실데이터 실패 시 폴백)
tools/                모의 데이터 생성기, e2e (배포 제외)
docs/                 주최 측 질문서 (배포 제외)
```

## 배포 (Vercel)

1. Vercel → Add New Project → GitHub `divisonofficer/Eatpl_Service` Import
   - Framework Preset: **Other** (vercel.json 에 `framework: null` 로 고정 — Node 서버 앱으로 인식되지 않게)
2. Settings → Environment Variables: `KAKAO_REST_KEY` (사진용, Production/Preview)
3. 배포 후 도메인(예: `xxx.vercel.app`)을 공모전에 등록 — 순 사용자 집계 기준 호스트
4. 카카오 디벨로퍼스 → 앱 → 플랫폼(Web)에 배포 도메인 추가 (REST 키는 서버에서만 쓰지만 등록해 두면 안전)

캐시: `/api/eatpl/search` 6시간, 키워드·사진 1일, 행정구역 7일 (Vercel CDN, URL 단위).
k-skill-proxy 한도(IP당 60회/분)를 서비스 전체가 나눠 쓰므로 캐시가 필수.
다른 사이트 브라우저에서 `/api/*` 호출은 403 (`Sec-Fetch-Site` 검사).

## API 연동 상태

정의서: https://eatpl.dothome.co.kr/api/ (v1, 2026.08)

- **실데이터 동작 중**: k-skill-proxy `GET /v1/bccard-eatpl/search?location=&merTpbuzNm=&merNm=` → `{ items, query, attribution, ... }`
  - 지원: 지역·업종·가맹점명. **키워드 검색(회식·심야 등) 미지원** → 필드 기반 필터로 대체
  - 제한: IP당 60회/분, 프록시 5분 캐시. 업종 칩 1개 = 호출 1회 (모드당 5~7회)
- 직접 호출(api.paybooc.ai): 403 RBAC — 미등록 IP. 자체 기관코드 받으면 `proxy/eatpl.php` 사용
- TM128 변환: 정의서 예시 "부촌"(종로4가) 좌표로 검증, 실데이터 핀 위치도 일치
- `_tpbuzL`, `_keywords`, `_mock` 은 모의 데이터 전용 필드

### 실데이터에서 확인한 특성

- `empyVsitYn=true`는 드묾 (종로구 고기구이 100건 중 6건) → 저녁 회식 결과가 동네당 15~30곳 수준
- `srtTime`/`endTime`은 최초/최종 결제 시각이라 `06:25~05:54`처럼 사실상 24시간으로 찍히는 매장이 많음
- 대분류(중국음식·일식회집 등)로 검색하면 응답 업종은 소분류로 와서 치킨·양꼬치 등이 섞임
- 가맹점명이 법인명(`주식회사 ○○`)으로 오는 경우 있음

### 매장 사진·편의 정보 파이프라인 (`/api/photos`, 매장당 카카오 7회 호출, 1일 캐시)

1. 카카오 로컬(장소·지번·전화) + 이미지 검색 + 블로그 검색 5회(이름+도로명, 이름+동, +룸, +콜키지, +주차)
2. 텍스트 검증: 이미지 출처 글이 이 매장 글인지 (이름 + 도로명/지번/전화, 다른 주소면 탈락, 인물·방송 키워드 탈락)
3. 내용 검사: 320px 썸네일로 얼굴(점수≥0.97·면적≥3%) / 스티커·제품·문서류(확률 합≥0.3) 탈락 — 실데이터 68장 검수로 정한 값
4. 편의 정보: 검증된 글에서 룸(룸비·최소 주문)·콜키지(금액)·주차(발렛·무료 시간·협소·불가) 추출, 다수결 + "블로그마다 다름"
   — 잇플 API에 없는 정보. 언급 없음 ≠ 없음 → 필터가 아니라 "우선 보기" 정렬로만 사용
5. **주차는 잇플 상세의 공식 값이 우선** (`/api/facilities` → `lib/mer.mjs`): 상세 페이지 '편의 서비스'의 주차가능/불가를 서버가
   매장당 1회 조회(1일 캐시)해 블로그 추정과 합친다 (`js/amenities-fmt.js` `mergeParking`). 목록 사진을 불러올 때·상세를 열 때·필터를 켤 때만 조회.
   주최 측 허용 확인 전까지 `MER_DETAIL=off` 로 끌 수 있다 (`docs/organizer-questions.md` 5번)
6. **룸은 규칙이 '있음'으로 본 가게만 AI 가 다시 읽는다** (`/api/amenities?verify=1` → `lib/verify.mjs`, 모델 K-EXAONE 2.5):
   규칙은 "룸 예약 불가"·"룸 있나요?"·해시태그·다른 식당 글을 구분하지 못해 오탐이 난다. 상세를 열 때만, 룸 언급 글 발췌(최대 8건)를
   모델이 글별 yes/no/unknown 으로 판정하고, 근거가 갈리면 미확인으로 둔다. 확인하는 동안 "룸 있어요"를 보이지 않는다.
   - 모델 일일 호출 한도가 낮아(응답 헤더 기준 100회/일, 1회/초) **매장 전체·목록에는 쓰지 않는다** — 목록·필터는 규칙 추정 그대로
   - 성공한 결과만 CDN 캐시(`s-maxage` 1일), 한도·장애·형식 오류는 규칙 결과로 폴백하고 캐시하지 않는다 ("AI 확인 못 함" 표기)
   - 환경변수 `EXAONE_API_KEY`(서버 전용), `ROOM_VERIFY=off` 로 끔. Vercel 에서는 프로젝트 환경변수에 따로 넣어야 한다
   - 사업자(법인)명 표기는 정규식(`js/legal-name.js`)으로 제거해 상호만 모델·검색·화면에 쓴다 (`주식회사`·`(주)`·`（주）` 등)

### 매장 사진

- 잇플 API·상세 페이지·카카오 로컬 API 모두 매장 사진 미제공
- **카카오맵 장소 사진 스크래핑은 하지 않음** (카카오 약관·k-skill 고지·사진 저작권, 공모전 제출물)
- 대신 **다음 이미지 검색 API(카카오 공식)** 로 `가게명 + 동` 검색 썸네일 3장을 카드 상세에 표시
  - "검색 이미지 · 실제 매장과 다를 수 있음" 표기 + 각 썸네일에 출처(doc_url) 링크
  - 키 없으면 영역 숨김. 카드 펼칠 때만 1회 호출 (캐시)
- 정확한 사진·리뷰는 "카카오맵 사진·리뷰" 버튼 (로컬 키워드 검색으로 place_url 매칭, 불확실하면 검색 링크)

### 주의 (k-skill 고지)

k-skill은 BC카드 공식 채널이 아니며, 개인·비조직적 조회 용도로 한정하고 대량 수집·DB 구축을 금지한다.
기획안의 "월 1회 스냅샷 수집"·공모전 운영 배포는 이 프록시가 아니라 BC카드 제휴(자체 기관코드)로 해야 함.

## 후순위

Kakao Map 교체, 인원·룸·콜키지 큐레이션 JSON, 배포(GitHub Pages + 자체 중계).
