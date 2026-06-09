# 쇼핑 트렌드 레이더

YouTube Shorts, Instagram Reels, Threads 공개 데이터를 모아 쇼핑/생활 제품 콘텐츠의 조회수 흐름을 빠르게 보는 리서치 대시보드입니다.

현재 데이터는 `data/gallery-data.json`에 저장됩니다. 기본 자동 갱신은 YouTube 공개 검색/채널 RSS/공개 메타데이터와 Instagram/Threads 선택형 공급자 API를 사용하며, 사용자 브라우저 쿠키나 로그인 세션을 쓰지 않습니다.

## 실행

```bash
npm start
```

브라우저에서 `http://127.0.0.1:8765/`를 엽니다.

## 무료 상시 운영

로컬 주소 `http://127.0.0.1:8765/`는 개발용입니다. 컴퓨터를 끄면 멈춥니다. 상시 운영은 GitHub Pages 무료 호스팅과 GitHub Actions 일일 수집으로 처리합니다.

```bash
npm run build:static
```

상시 공개 주소:

- `https://silen-calm.github.io/shopping-trend-radar/`
- 배포 대상 파일: `dist/index.html`, `dist/app.js`, `dist/data/gallery-data.json`, `dist/data/status.json`, `dist/data/public-candidates.json`

GitHub Actions 설정:

- 워크플로우: `.github/workflows/daily-collect.yml`
- 실행 시간: 매일 UTC 18:10, 한국 시간 03:10
- 수동 실행: GitHub Actions 화면의 `Daily trend collection`에서 `Run workflow`
- 수집 후 `data/*.json`과 `dist/`를 자동 커밋/푸시

YouTube 수집에는 워크플로우 안에서 `yt-dlp`를 설치해서 검색어별 관련 채널을 찾고, YouTube 공식 채널 RSS로 최근 업로드일/조회수/Shorts 링크를 확인한 뒤, 가능한 경우 공개 메타데이터로 길이와 조회수를 보강합니다. Instagram/Threads 고품질 수집은 공개 공급자 API가 있을 때만 자동 병합합니다. API가 없거나 공개 페이지에서 지표를 확인할 수 없는 항목은 랭킹 데이터에 넣지 않고 `data/public-candidates.json` 후보로만 남깁니다.

## 구조

- `server.mjs`: 로컬 웹 서버, API, 썸네일 캐시, 일일 직접 수집 담당
- `collect.mjs`: YouTube/Instagram/Threads 무로그인 직접 수집 실행
- `collector/config.json`: 직접 수집할 YouTube 쿼리와 Instagram/Threads 공개 계정 목록
- `src/direct-collector.mjs`: 플랫폼 직접 수집, 병합, 상태 저장 로직
- `src/source.mjs`: 데이터 파일 생성/저장 공통 로직
- `src/cache.mjs`: 썸네일 다운로드와 로컬 캐시 관리
- `src/thumb-jobs.mjs`: 캐시할 썸네일 후보 URL 생성
- `warm-cache.mjs`: 현재 데이터의 YouTube/Instagram 썸네일을 미리 로컬 저장
- `data/gallery-data.json`: 현재 로컬 서비스가 쓰는 구조화 데이터
- `data/refresh-status.json`: 마지막 갱신 성공/실패 상태
- `data/deleted_ids.json`: 사용자가 숨긴 항목 저장
- `cache/thumbs/`: 처음 보거나 미리 저장한 썸네일 캐시
- `tests/regression.mjs`: 기간, 검색, 정렬, 데이터 형식 회귀 테스트

## 직접 수집

서버를 켜면 마지막 수집 시간이 오래됐는지 먼저 확인하고, 기본 24시간 이상 지났으면 무로그인 직접 수집을 자동으로 한 번 실행합니다. 서버가 계속 켜져 있으면 이후에도 기본 24시간마다 다시 수집합니다. 즉시 수집하려면 아래 명령을 실행합니다.

```bash
npm run collect
```

일일 자동 수집 주기를 바꾸려면 서버 실행 전 `COLLECT_EVERY_SECONDS` 값을 지정합니다.

```bash
COLLECT_EVERY_SECONDS=3600 npm start
```

서버 시작 시 “오래된 데이터”로 판단하는 기준은 `COLLECT_STALE_SECONDS`로 조정할 수 있습니다. 시작 시 자동 확인을 끄려면 `COLLECT_ON_STARTUP=0`을 지정합니다.

```bash
COLLECT_STALE_SECONDS=3600 npm start
COLLECT_ON_STARTUP=0 npm start
```

맥 로그인 후에도 서버가 자동으로 켜지고 계속 살아 있게 하려면 아래 명령으로 macOS 자동 실행을 등록합니다. 등록 후에는 `http://127.0.0.1:8765/`가 로컬 백그라운드 서버로 열리고, 서버가 24시간마다 무로그인 직접 수집을 시도합니다.

```bash
npm run install:autoupdate
```

자동 실행 로그는 `logs/server.out.log`, `logs/server.err.log`에 저장됩니다.

레거시 원본 동기화 API는 기본적으로 꺼져 있습니다. `/api/refresh`는 410으로 거절됩니다.

무로그인 원칙: 직접 수집기는 사용자의 Chrome 세션, Instagram/Threads/YouTube 계정 쿠키, 로그인 정보를 쓰지 않습니다. YouTube는 `yt-dlp` 공개 검색으로 관련 채널을 찾고, YouTube 공식 채널 RSS와 공개 메타데이터로 최근성/조회수/Shorts 여부를 검증합니다. Instagram/Threads는 공개 페이지에서 보이는 링크와 메타 정보만 수집합니다. 공개 페이지가 조회수나 검색 결과를 숨기면 해당 플랫폼 항목은 자동 랭킹에 넣지 않고 `data/public-candidates.json`에 후보로만 저장합니다.

품질 기준: YouTube 직접 수집은 단순 검색 결과를 모두 넣지 않습니다. 기본값은 최근 45일 안의 Shorts/RSS 검증 영상 중 조회수 3만 이상이거나 일평균 조회수 1만 이상인 항목만 통과시킵니다. 공개 메타데이터로 길이가 확인되는 경우에는 180초 이하 조건도 함께 확인합니다. 통과한 항목에는 `dailyViews`, `trendScore`, `qualityReason`, `sourceQuery`, `collectedAt`, `evidence`가 저장됩니다. Instagram/Threads 공개 페이지에서 조회수나 업로드일을 확인할 수 없는 항목은 기본적으로 자동 추가하지 않고 수집 상태의 `skipped`에 기록합니다.

최근 확인 결과: 2026-06-10 07:53 KST 수동 실행에서 YouTube는 22개 검색어, 관련 채널 80개, 최근 후보 198개를 검사했고 RSS/공개 메타 검증을 통과한 23개 중 아직 없던 1개를 새로 추가했습니다. 이번 수정 작업 전체로 YouTube 데이터는 2,099개에서 2,122개로 23개 늘었습니다. Instagram은 공급자 API 비밀값이 없어 0개, Threads는 무조회수 공개 후보 72개를 후보 파일에만 저장했습니다.

## Instagram/Threads 공급자 API

Instagram/Threads를 계정 쿠키 없이 고품질로 갱신하려면 공개 데이터 공급자 API 키를 연결합니다. 공급자 API는 로컬 서버가 서버 대 서버로 호출하며, 사용자의 Instagram/Threads 로그인 세션을 쓰지 않습니다.

`collector/config.json`의 `instagram.provider`, `threads.provider`에서 엔드포인트 템플릿을 지정하거나 환경변수로 지정합니다.

```bash
INSTAGRAM_DATA_API_KEY=... \
INSTAGRAM_ACCOUNT_ENDPOINT='https://provider.example/instagram/reels?username={account}&limit={limit}' \
INSTAGRAM_SEARCH_ENDPOINT='https://provider.example/instagram/search?q={query}&limit={limit}' \
THREADS_DATA_API_KEY=... \
THREADS_ACCOUNT_ENDPOINT='https://provider.example/threads/user/posts?username={account}&limit={limit}' \
THREADS_SEARCH_ENDPOINT='https://provider.example/threads/search?q={query}&limit={limit}' \
npm start
```

응답 배열은 기본적으로 `data`, `items`, `results`, `posts`, `reels`, `media`에서 자동 탐색합니다. 공급자 응답 구조가 다르면 `arrayPath`를 지정합니다. API 키 헤더가 `Authorization: Bearer`가 아니면 `apiKeyHeader`, `apiKeyPrefix`를 바꿉니다. 예를 들어 `X-API-Key` 방식이면 `apiKeyHeader`를 `X-API-Key`, `apiKeyPrefix`를 빈 문자열로 설정합니다.

공급자에서 내려온 Instagram/Threads 항목은 조회수/좋아요/댓글/답글/공유 등 검증 가능한 지표가 있을 때만 `provider-instagram`, `provider-threads`로 자동 병합됩니다. 기준 미달 항목은 버려지고 상태 파일의 `provider.rejected`에 남습니다.

## 조회수 스냅샷과 급상승 점수

매 수집마다 `data/metric-snapshots.json`에 플랫폼별 조회수/참여 지표 스냅샷을 저장합니다. 같은 항목이 다음 수집에서 다시 관측되면 `viewsDelta`, `viewsPerHour`, `views24h`를 계산하고 `trendScore`, `dailyViews`, `mult`, `bucket`을 갱신합니다. 첫 관측만 있는 항목은 업로드일 대비 일평균 조회수로 임시 점수를 만들고, 다음 관측부터 실제 증가속도 기반 점수로 전환합니다.

## 썸네일 독립 캐시

기본 화면은 처음 보는 썸네일을 자동 캐시합니다. 모든 기존 YouTube/Instagram 썸네일을 미리 로컬에 저장하려면 아래 명령을 실행합니다.

```bash
npm run cache:warm
```

캐시 워밍은 YouTube 기본 썸네일과 Instagram CDN 주소를 후보로 순서대로 시도합니다. 캐시된 이미지는 이후 외부 썸네일 서버가 느리거나 막혀도 `cache/thumbs/`에서 바로 나옵니다. 캐시가 아직 없고 모든 후보 URL이 실패한 경우에는 로컬 대체 이미지가 표시됩니다.

## 테스트

```bash
npm test
```

테스트는 생성된 `data/gallery-data.json`을 기준으로 YouTube, Threads, Instagram의 기간 필터, 최신순/배수순 정렬, 대표 검색어 결과를 검사합니다.

서버가 켜진 상태에서 API, 삭제 저장, 썸네일 캐시, 수동 갱신까지 확인하려면 아래 명령을 실행합니다.

```bash
npm run test:full
```

## 로컬 API

- `GET /api/data`: 화면이 쓰는 전체 데이터
- `GET /api/status`: 데이터 버전, 직접 수집 상태, 캐시 개수
- `POST /api/collect`: 즉시 무로그인 직접 수집
- `POST /api/refresh`: 복제 대상 원본 동기화 비활성화 안내
- `GET /api/deleted`: 숨긴 항목 목록
- `POST /api/deleted`: 숨긴 항목 저장
- `GET /thumb?url=...&fallback=...`: 썸네일 캐시 프록시와 후보 URL 백업

저장 시점: 2026-06-10
