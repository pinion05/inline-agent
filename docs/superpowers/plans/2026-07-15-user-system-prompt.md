# User System Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load `~/.inlineagent/system.md` verbatim before every LLM request and expose the exact system message in the existing dashboard.

**Architecture:** A focused loader resolves and reads the home-scoped file. The loop creates an ephemeral request message array with the current prompt prepended, leaving the compressible conversation trajectory unchanged. The same request array is recorded for dashboard transparency and sent to the provider.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Node test runner, OpenAI-compatible chat completions.

## Global Constraints

- Use only `~/.inlineagent/system.md`; do not search project directories.
- Reload immediately before every API call.
- Preserve every non-empty UTF-8 file byte represented as a JavaScript string, including trailing newlines.
- Missing or zero-byte files preserve the existing zero-system-prompt behavior.
- Do not use subagents.

---

### Task 1: Home-scoped system prompt loader

**Files:**
- Create: `src/system-prompt.ts`
- Create: `test/system-prompt.test.ts`

**Interfaces:**
- Produces: `SYSTEM_PROMPT_PATH`, `loadSystemPrompt(path?: string)`, and `prependSystemPrompt(messages, prompt)`.
- Consumes: `Message` from `src/compact.ts`.

- [ ] **Step 1: Write failing loader tests**

Add tests that write `규칙\n끝\n` to a temporary file and assert exact preservation; assert missing and zero-byte files return `undefined`; assert reading a directory rejects; assert prefixing returns a new array without mutating its input.

- [ ] **Step 2: Verify the tests fail because the module is absent**

Run: `npx tsx --test test/system-prompt.test.ts`
Expected: FAIL with module resolution error for `src/system-prompt.js`.

- [ ] **Step 3: Implement the focused loader**

Use `join(homedir(), ".inlineagent", "system.md")`, `readFile(path, "utf8")`, an `ENOENT` guard, a zero-length guard, and an immutable array prefix.

- [ ] **Step 4: Verify loader tests pass**

Run: `npx tsx --test test/system-prompt.test.ts`
Expected: all loader tests pass.

### Task 2: API request integration and live reload

**Files:**
- Modify: `src/loop.ts`
- Modify: `test/api-context.test.ts`

**Interfaces:**
- Consumes: `loadSystemPrompt` and `prependSystemPrompt` from Task 1.
- Produces: optional `RunOptions.systemPromptLoader` and exact request/dashboard system-message behavior.

- [ ] **Step 1: Write failing API integration tests**

Change the existing context test so the internal trajectory starts without a system message, inject a loader returning `exact system prompt\n`, and assert the API and dashboard receive it as message zero while the trajectory remains user/assistant only. Add a two-request tool-loop test whose loader returns `first prompt` then `second prompt` and assert each API request receives the corresponding value.

- [ ] **Step 2: Verify the integration tests fail**

Run: `npx tsx --test test/api-context.test.ts`
Expected: FAIL because `systemPromptLoader` does not affect request messages.

- [ ] **Step 3: Integrate request-time loading**

Immediately before constructing each chat completion request, await the configured loader, prepend its value to a new API-only message array, pass that array to `recordApiContext`, and send it as `request.messages`. Default the loader to `loadSystemPrompt`.

- [ ] **Step 4: Verify integration and regression tests pass**

Run: `npm test`
Expected: trajectory tests and every Node test pass.

### Task 3: User documentation and final verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents the production behavior implemented by Tasks 1 and 2.

- [ ] **Step 1: Document setup and runtime semantics**

Add a `시스템 프롬프트 설정` section containing the exact directory/file commands and state that the optional file is re-read before every API call and rendered verbatim on port 7878.

- [ ] **Step 2: Run full verification**

Run: `npm test && npm run build && npm --prefix web test && npm --prefix web run build && git diff --check`
Expected: every command exits zero with no test failures or TypeScript/Astro build errors.

- [ ] **Step 3: Audit the diff**

Run: `git status --short && git diff -- src/system-prompt.ts src/loop.ts test/system-prompt.test.ts test/api-context.test.ts README.md`
Expected: only the approved feature, tests, and documentation are present; pre-existing untracked local files remain unstaged.

- [ ] **Step 4: Commit and push**

```bash
git add README.md src/loop.ts src/system-prompt.ts test/api-context.test.ts test/system-prompt.test.ts docs/superpowers/specs/2026-07-15-user-system-prompt-design.md docs/superpowers/plans/2026-07-15-user-system-prompt.md
git commit -m "feat: load user system prompt"
git push origin dev
```

Expected: local `HEAD` and `origin/dev` resolve to the same new commit.
