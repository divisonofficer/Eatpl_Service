# 회식픽 (가칭) — 로컬 데모

조건 입력 → 지도에서 고르기 → 단톡방 문구 복사. 빌드 없는 Vanilla JS 정적 앱.

## 실행

```bash
npm start            # = node server.mjs → http://localhost:8000 (의존성 없음, Node 18+)
```

- 기본: **실데이터** — 로컬 서버가 `/api/eatpl/search`를 [k-skill-proxy](https://github.com/NomaDamas/k-skill)
  (`bccard-eatpl-search`)로 중계. k-skill-proxy는 CORS 헤더가 없어 브라우저 직접 호출 불가라 로컬 중계가 필요
- 실패 시 자동으로 모의 데이터 폴백 (상단 배지로 표시). 강제 모의: `?source=mock`
- 정적 서버(`python3 -m http.server`)로 열면 중계가 없어 모의 데이터로 폴백됨
- 매장 사진(선택): `.env.example` → `.env` 복사 후 `KAKAO_REST_KEY` 입력 → 서버 재시작
- 모바일 동작 테스트: `node tools/e2e-mobile.mjs` (CDP, 390×844 터치 에뮬레이션, 스크린샷 `/tmp/hoesikpick-e2e/`)

## 구조

```
server.mjs          로컬 서버: 정적 파일 + k-skill-proxy·다음 이미지 검색 중계(10분 캐시)
index.html          한 페이지 앱
css/style.css       데스크톱(지도+우측 패널) / 모바일(지도 위, 리스트 아래)
js/config.js        데이터 소스 (live | mock | proxy), ?source= 로 전환
js/api.js           API 호출 + normalize (응답 포맷 바뀌면 여기만 수정)
js/geo-def.js       TM128 proj4 정의
js/modes.js         회식 모드 4종: 키워드·기본 업종·필터·정렬 규칙
js/format.js        영업시간/랭킹 표기, 안내문 템플릿(격식/캐주얼)
js/app.js           UI (Leaflet 지도, 카드, 후보·안내문 다이얼로그)
js/sheet.js         모바일 바텀시트 (peek/half/full 스냅, 데스크톱은 좌측 패널)
data/mock.json      모의 응답 50건 (정의서 v1 스키마, TM128 좌표, 매장명 가상)
tools/gen-mock.mjs  모의 데이터 생성기: node tools/gen-mock.mjs
proxy/eatpl.php     닷홈 PHP 프록시 (자체 기관코드 발급 시용, 미검증)
vendor/             leaflet 1.9.4, proj4 2.12.1 (오프라인용 로컬 사본)
```

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
