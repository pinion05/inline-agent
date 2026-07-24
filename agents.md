# agents.md

AI 에이전트(및 사람)가 이 저장소에서 작업할 때 알아둘 운영 지식. 코드 구조보다는 **배포·CI·토큰**처럼 비자명(non-obvious)인 부분을 중심으로 정리한다.

## 프로젝트 한 줄

`inline-agent` — LLM 코딩 에이전트를 위한 **보이지 않는 컨텍스트 정돈 레이어**. 정크 컨텍스트(冗長한 과정 토큰·tool 결과 잔해)를 제거·압축해 모델이 실제로 쓰는 프롬프트를 깨끗하게 유지한다. `npx inline-agent`(또는 `inla`)로 실행.

## 개발

```bash
npm install
npm run dev:agent  # tsx src/index.ts (런타임 직접 실행)
npm run build      # tsc → dist/
npm start          # node dist/index.js (빌드 결과 실행)
npm test           # tsx test-trajectory.ts && tsx --test test/*.test.ts
```

- Node **22.19 이상** (`engines.node`).
- 모든 게시/패키징은 `prepack` 훅이 `npm run build`를 자동 실행한다 → `npm publish`/`npm pack`은 항상 build를 선행.
- `prepack`은 build만 한다. **CI 게이트에서 test를 별도로 강제**한다(아래 참고). `prepack`에 test를 넣지 않은 이유는 `npm pack` 같은 비게시 작업까지 test를 강제하면 느려지기 때문.

## npm 게시

- 패키지: `inline-agent`, public.
- bin: `inline-agent` / `inla` 둘 다 `dist/index.js`를 가리킨다.
- `files: ["dist"]` — npm tarball엔 dist/만 들어간다.
- 같은 버전 재게시 불가 → 버전을 올려야 함.

## 자동 배포 (`.github/workflows/npm-publish.yml`)

**master**에 push하면:
1. checkout → Node 22 → `npm install`
2. `npm test` + `npm run build` **항상 실행**(배포 게이트)
3. `package.json` 버전 vs npm 최신 버전 비교
   - 같으면 → 게시 **건너뜀**
   - 새 버전이면 → `npm publish --access public`(`NPM_TOKEN` 사용)
4. 게시했으면 → **GitHub Release `v<버전>`** 자동 생성(`--generate-notes` 자동 노트, `GITHUB_TOKEN` 사용). 태그는 트리거 커밋을 가리킴.

**새 버전 릴리스:**
```bash
npm version patch      # 0.1.12 → 0.1.13
git push origin master # CI가 자동 게시 + GitHub Release 생성
```

### ⚠️ CI 주의사항 (삽질 기록 — 함부로 "수정" 금지)

- **기본 브랜치는 `master`** (주의: `main`이 아니다). 워크플로우 `on.push.branches`는 `[master]`로 맞춰져 있다. 브랜치명을 바꾸면 트리거가 안 걸린다.
- **`npm ci`가 아니라 `npm install`을 쓴다.** 저장소에 `package-lock.json`을 커밋하지 않으므로 `npm ci`는 실패한다.
- **CI Node 22** (`engines.node`와 정렬).
- **워크플로우 파일을 처음 추가한 커밋의 push 이벤트는 트리거가 누락될 수 있다** (GitHub의 알려진 동작 — 새 워크플로우 인식 타이밍). 이후 master push부터는 정상 트리거된다. 검증이 필요하면 `gh workflow run npm-publish.yml --ref master`로 수동 실행.

## NPM_TOKEN

- `NPM_TOKEN`은 GitHub repo secret. **Granular Access Token**(Read and write, `inline-agent` 패키지 커버) — 만료 시 게시가 `404 Not Found - PUT .../inline-agent` 또는 401/403으로 실패한다.
- ⚠️ **중요**: Granular 토큰은 패키지 범위(package scope)를 지정한다. 다른 패키지용 토큰을 그대로 쓰면 게시 권한이 없어 403/404가 난다 — 이 저장소 패키지를 커버하는 토큰(또는 all-packages 범위 토큰)을 써야 한다.
- 갱신: npmjs.com → Access Tokens에서 Granular 토큰 재생성 후
  ```bash
  gh secret set NPM_TOKEN --repo pinion05/inline-agent   # 값 붙여넣기
  ```

## ⚠️ Dashboard / SSE 무결성 (절대 위반 금지)

대시보드(`http://localhost:7878`)와 SSE snapshot은 **"API에 실제로 전송되는 내용"의 투명한 거울**이어야 한다. 이 무결성은 절대 절대 절대로 깨뜨리면 안 된다.

**규칙:**
- **웹에 보내는 것은 무조건 API에 실제로 전송되는 데이터만.** 그 외的一切(캐노니컬 원본, 압축 전 메시지, 서버 내부 상태)은 snapshot에 넣지 않는다.
- `getSnapshot().apiMessages`는 **API 요청에 들어가는 원본 메시지와 바이트 단위로 동일**해야 한다. 계산 필드(`tokens`, `estimatedXxx` 등)를 메시지 객체 안에 끼워넣지 말 것.
- 토큰 수 등 부가 정보는 **별도 배열/필드**로 분리한다. 현재 구조:
  - `apiMessages: Message[]` — 순수 원본 (`{role, content, tool_calls, ...}`, API 전송본과 동일)
  - `messageTokens: number[]` — 메시지 순서에 대응하는 토큰 수 (별도)
  - `apiTools` / `apiModel` / `apiReasoningEffort` — 모두 API 요청 메타데이터
- dashboard의 "메시지 전체 원문 JSON"은 `apiMessages[i]`를 그대로 직렬화한다. 여기에 `tokens` 같은 비원본 필드가 보이면 **무결성 위반**이다.
- 웹 UI에 "원문"이라고 라벨링한 것은 **무조건 API 실제 내용**이어야 한다. 시각적 편의를 위해 계산값을 끼워넣지 말 것.

**과거 삽질 (2건):**
1. **`tokens` 주입:** 토큰 수 표시를 위해 `apiMessages`의 각 메시지에 `tokens` 필드를 주입했더니, dashboard의 "전체 원문 JSON"에 `tokens: 41`이 섞여 나와 "이게 API로 가는 거 아냐?"라는 혼란을 유발했다. 계산 필드는 `messageTokens` 별도 배열로 분리해서 해결.
2. **canonical `messages` 전송:** snapshot에 `messages`(압축 전 캐노니컬 원본)를 같이 보냈다. 이건 API에 전송되지 않는 내부 데이터인데 웹에 노출돼 무결성을 해쳤다. `apiMessages`(실제 API 전송본)만 남기고 제거.

## 디버깅 (배포 실패 시)

- **404 on PUT**: 토큰 권한 문제. 위 NPM_TOKEN 섹션 참고.
- **게시는 됐는데 Release가 안 올라감**: `Create GitHub Release` 스텝 로그 확인. `permissions: contents: write`가 빠져있으면 `GITHUB_TOKEN`으로 release 생성이 안 된다.
- **워크플로우가 안 돈다**: `gh workflow list`로 활성화 확인 → Actions 탭에서 비활성화 여부 확인 → `workflow_dispatch`로 수동 실행해 본다.
