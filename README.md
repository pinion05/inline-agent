<div align="center">

# inline-agent

**LLM 에이전트의 성능을 깎는 건 모자라는 지능이 아니다. 쓰레기 컨텍스트다.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/pinion05/inline-agent/pulls)

</div>

---

## 문제

LLM 에이전트는 매 스텝마다 전체 대화 기록을 재전송한다. 한 번 생성된 토큰은 영원히 컨텍스트에 남아 매 API 호출마다 비용을 발생시킨다.

이것의 결과:

```
Claude 4 Sonnet 일일 사용량: 100B 토큰
├── 입력 (재독): 99B 토큰 (99%)
└── 생성:         1B 토큰 (1%)
```

> *Xiao et al., "Reducing Cost of LLM Agents with Trajectory Reduction", FSE 2026*
> *[arxiv.org/abs/2509.23586](https://arxiv.org/abs/2509.23586)*

**비용의 99%는 같은 텍스트를 반복해서 읽는 데 쓰인다.**

## 그 토큰 안에 뭐가 있나

SWE-bench Verified 평균 트레이토리를 분해하면 (48.4K 토큰, 40스텝):

| 구성 | 토큰 | 비율 | 상태 |
|------|------|------|------|
| tool 결과 (observations) | 30.4K | 63% | 대부분 **expired** — 다음 스텝에서 무의미 |
| tool_call 인자 (actions) | 11.9K | 25% | 결과에 반영된 후 **오버헤드** |
| assistant 추론 | 1.8K | 4% | — |
| system/user | 4.4K | 9% | — |

쓰레기의 세 가지 패턴:

| 패턴 | 예 | 비고 |
|------|-----|------|
| **Useless** | `ls` 결과의 `__pycache__/`, `.git/`, `.venv/` | 처음부터 불필요 |
| **Redundant** | edit 도구가 `old_str`을 action·result·이전 파일에 **3중 복사** | 중복 |
| **Expired** | 29개 통과한 테스트 — 에이전트가 원인 파악 후엔 무의미 | 맥락 상실 |

## 핵심 발견: 정크를 빼면 더 잘한다

| 연구 | 방법 | 토큰 절감 | 성능 변화 |
|------|------|:--------:|:---------:|
| **AgentDiet** · FSE 2026 | 2스텝 지연 후 슬라이딩 윈도우 압축 | **40~60%** | ±2%p (무의미) |
| **CoACT** · 2026 | next-action 보존 기반 observation 압축 | **33%** | **+3.5%p 상승** |

긴 컨텍스트는 LLM 성능을 **능동적으로 저하**시킨다 ([Liu et al. 2023](https://arxiv.org/abs/2307.03172); [Li et al. 2025]). 
정크를 빼면 agent가 더 잘 한다.

> *CoACT: Chen et al., "Action-Preserving Observation Compression for Coding Agents", 2026*
> *[arxiv.org/abs/2607.02911](https://arxiv.org/abs/2607.02911)*

## LLM은 스스로 컨텍스트를 못 줄인다

AgentDiet가 LLM에게 `erase` 도구를 줬다.

> *"17번 스텝이 불필요하면 지워라."*

**Claude 4 Sonnet도 지우지 않았다.** 그냥 원래 태스크를 계속했다. LLM은 훈련 데이터에 박힌 절차를 따라가느라 자기 컨텍스트를 정리하지 않는다.

**결론: LLM이 모르게 외부에서 정리해야 한다.**

이것이 inline-agent가 존재하는 이유다.

## 정보 가치 위계

모든 토큰이 같은 가치를 갖지 않는다.

```
┌─────────────────────────────────────────────────────────┐
│  최고가치  │ 에러 메시지 · 실패한 테스트 · 파일 변경 사항    │
│            │ → 절대 보존                                    │
├────────────┼───────────────────────────────────────────────┤
│  고가치    │ 결과 핵심 · 다음 스텝과 직결되는 정보            │
│            │ → 보존                                        │
├────────────┼───────────────────────────────────────────────┤
│  중가치    │ 전체 결과 원문 · action / 명령어                │
│            │ → 압축 또는 temp file로 분리                    │
├────────────┼───────────────────────────────────────────────┤
│  최저가치  │ 통과한 테스트 · 디렉토리 리스팅 · 빌드 로그       │
│            │ → 삭제                                        │
└────────────┴───────────────────────────────────────────────┘
```

## 철학

1. **정크 컨텍스트가 LLM을 죽인다** — 토큰이 많을수록 좋은 게 아니다. 정크를 빼면 더 똑똑해진다.
2. **LLM은 정리를 못 한다** — 외부 레이어가 보이지 않게 처리한다. LLM은 깨끗한 컨텍스트만 본다.
3. **고가치 토큰만 남긴다** — 에러, 실패, 변경사항은 보존. 나머지는 압축·삭제.
4. **방해하지 않는다** — 기본 시스템 프롬프트 0줄. 사용자가 명시적으로 설정한 프롬프트와 최소한의 도구만 전달한다.
5. **Tool description은 쓰레기다** — "이 도구를 사용하기 전에 반드시 ~해야 합니다" 같은 hard rule은 GPT-4 시대의 유물이다. 현대 LLM은 도구 이름과 시그니처만 봐도 충분하다. tool description에 박아넣은 행동 강령은 토큰만 낭비하고 LLM의 판단을 방해한다.
6. **Tool 단위 approve는 하지 않는다** — "이 도구는 안전하고 저 도구는 위험하다"로 분류해서 허가받는 구시대적 설계를 버렸다. LLM이 알아서 판단한다.

## 컨텍스트 투명성 대시보드

```bash
npm run dev
```

브라우저에서 [http://localhost:7878/](http://localhost:7878/)을 열면 마지막 LLM API 호출 직전의 시스템 프롬프트, tool 정의, 컨텍스트 원문 전체, 활성 model과 `reasoning_effort`, 현재 토큰 사용량, 안전 상한으로 잘린 토큰, 현재 요청 projection으로 압축한 토큰, 설정/실제 raw action 수, 캐시 히트 비율을 실시간으로 확인할 수 있다.

## Retained-mode TUI와 provider 설정

CLI의 짧은 공식 명령은 `inla`이며 기존 `inline-agent`도 동일하게 동작한다.

```bash
inla
# 또는
inline-agent
```

TTY에서는 터미널 스크롤백을 보존하는 inline retained-mode UI가 실행된다. 최초 실행 시 설정 화면에서 Z.AI Coding Plan, OpenAI 또는 Custom OpenAI-compatible provider를 선택하고 API Key를 입력한다. 인증 후 `/models`에서 가져온 모델을 검색해 선택하거나 모델 ID를 직접 입력할 수 있다.

설정은 `~/.inlineagent/config.json`에 저장된다. 디렉터리 권한은 `0700`, 설정 파일은 `0600`이며 API Key는 TUI에서 마스킹된다. 실행 중 `/settings`를 열어 provider, 모델, reasoning, 최근 raw tool action 수, 단일 출력 안전 상한을 변경해도 기존 대화는 유지되고 다음 API 호출부터 새 설정이 적용된다.

기본값은 최근 tool action `3`개 원문 보존과 단일 출력 `64K` 문자 상한이다. action 수는 `1–20`, 상한은 `4K–1M` 범위에서 preset 또는 직접 입력으로 설정한다. 최근 최대 20개 action만 raw recovery ring에 유지하고 더 오래된 action은 영구 압축하므로 메모리가 무제한 증가하지 않는다. 상한을 넘은 전체 출력은 `~/.inlineagent/log/`에 저장된다.

reasoning은 Auto 없이 provider 원본 값을 명시적으로 전송한다.

- Z.AI: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
- OpenAI/Custom: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`
- 모든 provider의 최초 선택값: `high`

주요 조작:

- `Enter`: 전송
- `Ctrl+J` 또는 `Shift+Enter`: 개행
- `Esc`: 실행 중인 LLM 요청·shell 명령과 FIFO 대기열 전체 중단
- `Ctrl+C`: 즉시 종료
- `Ctrl+D`: 입력창이 비어 있을 때 종료
- `/settings`: provider/model/reasoning 설정
- `/clear`: 대화 초기화
- `/exit`, `/quit`: 종료

실행 중 추가로 전송한 입력은 FIFO 대기열에서 순서대로 처리된다.

## Tool Description과 Approval — 과거의 유물

### verbose한 tool description은 GPT-4 시대의 하드룰이다

과거의 agent 프레임워크들은 tool description에 행동 강령을 잔뜩 박아넣었다:

> *"이 도구를 사용하기 전에 반드시 사용자의 의도를 확인하십시오. 출력이 1000자를 넘으면 요약하십시오. 에러가 발생하면 재시도하지 마십시오..."*

이건 GPT-4가 제대로 판단하지 못했기 때문에 필요한 **하드룰**이었다. 

현대 LLM(Claude 4, GPT-5 등)은 도구 이름과 시그니처만 봐도 적절히 사용한다. verbose한 description에 박아넣은 규칙들은 그냥 **정크 토큰**이다. 매 API 호출마다 비용을 발생시키고, LLM의 자체 판단 능력을 오히려 저해한다.

inline-agent는 tool description을 **이름과 타입 시그니처 수준으로 최소화**한다.

### Tool 단위 approve는 더 이상 하지 않는다

구시대적 agent 프레임워크는 도구를 "안전/위험"으로 분류하고, 위험한 도구는 실행 전 사용자 승인을 요구했다:

```
❌ 도구 분류표:
   read_file  → 자동 실행
   write_file → 승인 필요
   shell_exec → 승인 필요
```

이런 분류는 **LLM을 바보로 취급**하는 것이다. 현대 LLM은 파일을 읽어야 할 때와 쓸 때를 스스로 판단한다. 무엇이 "위험"한지는 컨텍스트에 따라 다르다 — 같은 `write_file`이어도 README 수정은 안전하고, `rm -rf /`는 위험하다.

inline-agent는:
- **도구 단위의 approve/deny 분류를 하지 않는다**
- LLM이 필요한 도구를 스스로 판단해서 사용한다
- 사용자는 시스템 프롬프트로 자신의 의도를 전달하면 된다

### 현대 LLM은 특수 도구 없이도 알아서 한다

과거 프레임워크는 LLM이 못 할까봐 전용 도구를 하나씩 만들어줬다: `edit_file`, `search_web`, `run_python`...

현대 LLM은 **쉘 하나만 있으면 된다.**

| 과거 프레임워크의 도구 | 현대 LLM의 실제 행동 |
|---|---|
| `edit_file` 도구 | 없어도 됨. `sed`나 `cat > file`로 처리하고, 작업 후 `git diff`를 **스스로** 확인함 |
| `search_web` / `browse` 도구 | 없어도 됨. `curl`이나 `gh api`를 **자발적으로** 호출하고 크롤링함 |
| `run_python` 도구 | 없어도 됨. 대부분의 계산·변환 작업을 **인라인 Python 스크립트**로 처리함 |
| 사전 플로우 설명 ("먼저 읽고, 수정하고, diff를 확인하라") | 없어도 됨. LLM이 알아서 그 순서를 밟음 |

에이전트에게 필요한 것은 행동 강령이 아니라 **실행 권한이 있는 셸** 하나뿐이다. 나머지는 LLM이 알아서 한다.

### 컨텍스트 골든 에어리어를 낭비하지 마라

현대 에이전트의 핵심 트렌드는 **컨텍스트 누적을 통한 재귀적 개선**이다. 이전 스텝의 결과가 다음 스텝의 판단 재료가 되고, 실패에서 얻은 인사이트가 성공으로 이어지는 선순환. 이게 작동하려면 컨텍스트 윈도우 안에 **실질적으로 도움이 되는 컨텍스트**가 쌓여야 한다.

문제는 컨텍스트 윈도우가 유한하다는 것. 정해진 툴의 verbose한 description, approve 대기, 불필요한 중간 산출물이 공간을 차지하면, 정작 재귀적 개선에 필요한 **고밀도 컨텍스트**가 들어갈 자리가 없다.

```
❌ 구시대적 방식:
   정해진 도구 → 느린 작업 → approve 대기 → 정크 토큰 누적
   → 컨텍스트 찬 공간에 쓸모없는 데이터만 가득
   → 재귀적 개선 불가, 정체

✅ inline-agent 방식:
   자유로운 셸 → 빠른 실행 → 빠른 실패 → 고밀도 컨텍스트 축적
   → 컨텍스트 골든 에어리어에 인사이트와 결과만 남음
   → 재귀적 개선 가속
```

**빠르게 실패하고 빠르게 좋은 컨텍스트를 쌓는 것이, 느리게 안전하게 가는 것보다 훨씬 낫다.**

컨텍스트 윈도우는 전쟁터다. 한 토큰의 정크도 허용하지 않는다.

## 시스템 프롬프트 설정

기본값은 시스템 프롬프트 없음이다. 필요한 경우 홈 디렉터리에 다음 파일을 만든다.

```bash
mkdir -p ~/.inlineagent
$EDITOR ~/.inlineagent/system.md
```

`~/.inlineagent/system.md`는 매 LLM API 호출 직전에 다시 읽으므로 에이전트를 재시작하지 않아도 다음 호출부터 변경 내용이 반영된다. 비어 있거나 존재하지 않으면 시스템 메시지를 보내지 않는다. 전송된 UTF-8 원문은 [http://localhost:7878/](http://localhost:7878/)의 **실제 SYSTEM PROMPT**와 **실제 LLM 컨텍스트**에서 그대로 확인할 수 있다.

### 시스템 프롬프트를 비워두는 이유

이미 대중적으로 유명한 워크플로우 프로젝트가 많다 — Superpowers, g-stack, Skills 등. 이런 것들을 에이전트에게 적용하려고 시스템 프롬프트에 워크플로 규칙을 적는 것은 **중복이자 모순**을 낳는다.

LLM은 이미 이 워크플로우들을 학습하고 있다. "이슈부터 등록하라", "계획서를 먼저 작성하라" 같은 지시는 LLM이 아는 절차를 굳이 다시 말해주는 셈이다. 더 나쁜 건, 프레임워크가 강제하는 절차와 시스템 프롬프트의 규칙이 **서로 충돌**할 수 있다는 것이다.

시스템 프롬프트는 비워두는 것이 기본값이다. 필요한 것만, 최소한으로 넣어라. LLM이 이미 아는 것을 반복하지 마라.

## References

- Xiao et al., *"Reducing Cost of LLM Agents with Trajectory Reduction"*, FSE 2026 — 트레이토리 쓰레기 분석, 40~60% 토큰 절감, LLM 자기 정리 불가 증명 · [arxiv.org/abs/2509.23586](https://arxiv.org/abs/2509.23586)
- Chen et al., *"CoACT: Action-Preserving Observation Compression for Coding Agents"*, 2026 — observation 압축 시 성능 유지/향상, NAP 기준 · [arxiv.org/abs/2607.02911](https://arxiv.org/abs/2607.02911)
- Pi (earendil-works) — temp file truncation, cut-point compaction, binary sanitization 참고
- OpenCode (sst) — Retry-After 헤더 파싱, overflow 계산, truncation 힌트 참고

<div align="center">

— LLM은 이미 충분히 똑똑하다. 프레임워크가 할 일은 정크를 치우는 것뿐이다. —

</div>
