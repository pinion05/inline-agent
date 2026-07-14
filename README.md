# inline-agent

> LLM은 이미 충분히 똑똑하다. 에이전트 프레임워크가 해야 할 일은 방해하지 않는 것뿐이다.

도구는 shell 하나. 시스템 프롬프트는 한 줄. 나머지는 전부 LLM의 지능에 맡긴다.

## Philosophy

대부분의 코딩 에이전트는 도구를 많이 만들고 프롬프트를 길게 쓴다 — `read`, `write`, `edit`, `search`, `find`, `lsp`, `browser`... 이 도구 정의와 시스템 프롬프트가 수천~수만 토큰을 잡아먹는다. 그 토큰이 실제 작업 컨텍스트에서 빠진다.

근데 shell 하나면 저 도구 전부를 대체할 수 있다. 그리고 2026년의 LLM은 shell을 어떻게 쓰는지 이미 안다.

**덜 주면 더 잘한다.**

## Design

```
LLM ←→ shell
```

| 원칙 | 구현 |
|------|------|
| 도구 1개 | `shell(command)` — 오버헤드 0 |
| 시스템 프롬프트 1줄 | `"You are a coding agent with one tool: shell."` |
| Persistent shell | cwd, 환경변수, 백그라운드 프로세스 유지 |
| OpenAI-compatible | 어떤 모델이든 연결 (GPT, Claude proxy, GLM, local) |
| 출력 보호 | 30K chars 초과 시 잘림 + 신호 |
| 최소 컨텍스트 | 절약한 토큰을 코드베이스에 쓴다 |

## Usage

```bash
pip install -e .

# OpenAI
export OPENAI_API_KEY=sk-...
inline-agent

# Any OpenAI-compatible provider
export INLINE_BASE_URL=https://api.z.ai/api/paas/v4
export INLINE_MODEL=glm-5.2
export OPENAI_API_KEY=your-key
inline-agent
```

## Code

```
src/inline_agent/
├── main.py    # entry point — REPL
├── loop.py    # agent loop (~60 lines)
└── shell.py   # shell session (~50 lines)
```

전체 코드 약 120줄. 그 이상 필요 없다.
