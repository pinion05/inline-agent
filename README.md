# inline-agent

> LLM은 이미 충분히 똑똑하다. 프레임워크가 할 일은 방해하지 않는 것과, 깨지지 않게 보호하는 것뿐이다.

도구는 shell 하나. 시스템 프롬프트는 0줄. LLM이 모르는 정보 정돈 레이어가 컨텍스트를 보호한다.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  LLM (메인 모델)                                  │
│  - 시스템 프롬프트: 0줄                           │
│  - 인지하는 도구: shell 1개                        │
├──────────────────────────────────────────────────┤
│  정보 정돈 레이어 (LLM이 모르게 작동)              │
│  - 500글자(공백제외) 하드 컷                       │
│  - "Y for summary?" → 정돈 LLM 호출                │
│  - Compaction: 50% 트리거, 10턴 보존               │
├──────────────────────────────────────────────────┤
│  Shell (실제 실행)                                 │
│  - timeout 300초                                   │
│  - 상태 관리는 LLM의 책임 (cd X && Y)              │
└──────────────────────────────────────────────────┘
```

## Design Principles

1. **LLM은 이미 똑똑하다** — scaffolding을 최소화한다
2. **도구는 shell 하나** — 오버헤드 0
3. **시스템 프롬프트는 0줄** — 컨텍스트를 코드에 쓴다
4. **정보 정돈 레이어** — LLM이 모르게 컨텍스트를 보호한다
5. **Skills는 발견 기반** — 주입이 아니라 LLM이 필요할 때 읽는다

## Shell Sanitization

| 상황 | 동작 |
|------|------|
| 출력 ≤ 500글자 | 그대로 전달 |
| 출력 > 500글자 | 500글자 컷 + "Y for summary?" |
| `max_length=0` 지정 | truncation 없이 전체 리턴 |
| LLM이 "Y" 응답 | 정돈 LLM 호출 → 요약본 전달 |
| timeout (300s) | kill + "[timeout]" 리턴 |

## Compaction

| 항목 | 값 |
|------|-----|
| 트리거 | 컨텍스트 50% 도달 시 |
| 보존 | 최근 10턴 (원본) |
| 압축 | 나머지 전체 → 정돈 LLM |
| 인지 | `[compacted history]` 태그 |

## Skills

```
~/.inline-agent/skills/          # 유저 글로벌
.inline-agent/skills/            # 프로젝트 로컬
```

스킬 파일은 주입되지 않는다. 첫 메시지 시 목록만 tool result에 append되고, LLM이 필요하면 `cat`으로 읽는다.

## Usage

```bash
npm install
npm run dev

# OpenAI
export OPENAI_API_KEY=sk-...

# Any OpenAI-compatible provider
export INLINE_BASE_URL=https://api.z.ai/api/paas/v4
export INLINE_MODEL=glm-5.2
export OPENAI_API_KEY=your-key
```

## Code

```
src/
├── index.ts     # REPL entry point
├── loop.ts      # agent loop — one tool, zero prompt
├── shell.ts     # shell execution + sanitization layer
├── compact.ts   # context compaction
└── skills.ts    # skills discovery (not injection)
```
