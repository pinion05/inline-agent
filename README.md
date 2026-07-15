# inline-agent

> LLM은 이미 충분히 똑똑하다. 프레임워크가 할 일은 방해하지 않는 것과, 깨지지 않게 보호하는 것뿐이다.

도구는 shell 하나. 시스템 프롬프트는 0줄. LLM이 모르는 정보 정돈 레이어가 컨텍스트를 보호한다.

## 왜 이 구조인가 — 연구 근거

### 1. 에이전트 비용의 99%는 입력 토큰이다

Claude 4 Sonnet 기준, OpenRouter 일일 사용량 100B 토큰 중 **99%가 입력(재독) 토큰**, 생성은 1%에 불과하다. 에이전트가 한 번 발생시킨 트레이토리 토큰은 이후 매 스텝마다 재전송되어 누적된다.

> *Source: Xiao et al., "Reducing Cost of LLM Agents with Trajectory Reduction", FSE 2026 ([arxiv.org/abs/2509.23586](https://arxiv.org/abs/2509.23586))*

### 2. 트레이토리의 63%는 결과, 25%는 행동 — 둘 다 쓰레기가 많다

SWE-bench Verified 평균 트레이토리 (48.4K 토큰, 40스텝):

```
tool 결과 (observations):  30.4K tokens (63%)  ← 대부분 expired/redundant
tool_call 인자 (actions):  11.9K tokens (25%)  ← 결과에 반영된 후 오버헤드
assistant 추론:              1.8K tokens  (4%)
system/user:                4.4K tokens  (9%)
```

전형적인 쓰레기 패턴:
- `ls` 결과의 `__pycache__/`, `.git/`, `.venv/` — **useless**
- `str_replace` 도구가 `old_str`을 action과 result에 **3중 복사** — **redundant**
- 29개 통과한 테스트 목록 — 다음 스텝에서 **expired**

### 3. 이 쓰레기를 제거해도 성능이 안 떨어진다 — 오히려 오른다

| 연구 | 방법 | 토큰 절감 | 성능 변화 |
|------|------|----------|-----------|
| **AgentDiet** (FSE 2026) | 2스텝 후 슬라이딩 윈도우 압축 | **40~60%** | ±2%p (통계적 무의미) |
| **CoACT** (2026) | action-preservation 기반 observation 압축 | **33%** | **+3.5%p 상승** (57%→60.5%) |

CoACT의 핵심 통찰: 긴 컨텍스트는 LLM 성능을 **능동적으로 저하**시킨다. 쓰레기를 빼면 agent가 더 잘한다.

> *CoACT: Chen et al., "Action-Preserving Observation Compression for Coding Agents", 2026 ([arxiv.org/abs/2607.02911](https://arxiv.org/abs/2607.02911))*

### 4. LLM은 자기 컨텍스트를 못 줄인다

AgentDiet가 LLM에게 `erase` 도구를 줬다: "17번 스텝이 불필요하면 지워라."

**Claude 4 Sonnet도 안 지웠다.** 그냥 원래 태스크만 계속했다. LLM은 훈련 데이터에 박힌 절차를 따라가느라 맥락 정리를 하지 않는다.

**결론: LLM이 모르게 외부에서 정리해야 한다.** 이것이 inline-agent의 "보이지 않는 정보 정돈 레이어"가 존재하는 이유다.

### 5. 고가치 토큰만 남긴다

트레이토리 토큰의 정보 가치 위계:

```
최고가치  │ 에러 메시지, 실패한 테스트, 파일 변경 사항
          │ → 절대 보존
고가치    │ 결과 핵심 요약, 다음 스텝과 직결되는 정보
          │ → 보존
중가치    │ 전체 결과 원문, action/명령어
          │ → 압축 또는 temp file로 분리
최저가치  │ 통과한 테스트, 디렉토리 리스팅, 빌드 로그
          │ → 삭제
```

## References

- Xiao et al., "Reducing Cost of LLM Agents with Trajectory Reduction", FSE 2026 — 트레이토리 쓰레기 분석, 40~60% 토큰 절감, LLM 자기 정리 불가 증명
- Chen et al., "CoACT: Action-Preserving Observation Compression for Coding Agents", 2026 — observation 압축 시 성능 유지/향상, NAP 기준
- Pi (earendil-works), `packages/coding-agent` — temp file truncation, cut-point compaction, sanitizeBinaryOutput 참고
- OpenCode (sst), `packages/opencode` — Retry-After 헤더 파싱, overflow 계산, truncation 힌트 참고
