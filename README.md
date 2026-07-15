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

## 컨텍스트 투명성 대시보드

```bash
npm run dev
```

브라우저에서 [http://localhost:7878/](http://localhost:7878/)을 열면 마지막 LLM API 호출 직전의 시스템 프롬프트, tool 정의, 컨텍스트 원문 전체와 현재 토큰 사용량, 소거한 불필요 토큰, 캐시 히트 비율을 실시간으로 확인할 수 있다.

## 시스템 프롬프트 설정

기본값은 시스템 프롬프트 없음이다. 필요한 경우 홈 디렉터리에 다음 파일을 만든다.

```bash
mkdir -p ~/.inlineagent
$EDITOR ~/.inlineagent/system.md
```

`~/.inlineagent/system.md`는 매 LLM API 호출 직전에 다시 읽으므로 에이전트를 재시작하지 않아도 다음 호출부터 변경 내용이 반영된다. 비어 있거나 존재하지 않으면 시스템 메시지를 보내지 않는다. 전송된 UTF-8 원문은 [http://localhost:7878/](http://localhost:7878/)의 **실제 SYSTEM PROMPT**와 **실제 LLM 컨텍스트**에서 그대로 확인할 수 있다.

## References

- Xiao et al., *"Reducing Cost of LLM Agents with Trajectory Reduction"*, FSE 2026 — 트레이토리 쓰레기 분석, 40~60% 토큰 절감, LLM 자기 정리 불가 증명 · [arxiv.org/abs/2509.23586](https://arxiv.org/abs/2509.23586)
- Chen et al., *"CoACT: Action-Preserving Observation Compression for Coding Agents"*, 2026 — observation 압축 시 성능 유지/향상, NAP 기준 · [arxiv.org/abs/2607.02911](https://arxiv.org/abs/2607.02911)
- Pi (earendil-works) — temp file truncation, cut-point compaction, binary sanitization 참고
- OpenCode (sst) — Retry-After 헤더 파싱, overflow 계산, truncation 힌트 참고

<div align="center">

— LLM은 이미 충분히 똑똑하다. 프레임워크가 할 일은 정크를 치우는 것뿐이다. —

</div>
