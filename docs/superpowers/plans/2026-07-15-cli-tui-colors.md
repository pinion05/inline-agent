# CLI TUI Role Colors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Distinguish user input, tool commands, and agent replies with separate dark text-area backgrounds in interactive terminals.

**Architecture:** Add a dependency-free `src/tui.ts` module containing pure ANSI formatters and TTY/`NO_COLOR` detection. Integrate those functions at the three existing output boundaries in `src/index.ts` and `src/loop.ts`, resetting the prompt style after input and shutdown.

**Tech Stack:** TypeScript ES2022, Node.js readline, ANSI 256-color escape sequences, Node test runner through `tsx`.

## Global Constraints

- Background styling covers only rendered text, not full terminal width.
- USER uses dark navy, TOOL dark brown, and AGENT dark green.
- Non-TTY output and environments containing `NO_COLOR` remain ANSI-free.
- Do not add runtime dependencies or style unrelated setup/error/status output.

---

### Task 1: Pure TUI formatters

**Files:**
- Create: `src/tui.ts`
- Create: `test/tui.test.ts`

**Interfaces:**
- Produces: `supportsColor(stream, env)`, `formatUserPrompt(enabled)`, `formatToolLine(command, enabled)`, `formatAgentReply(reply, enabled)`, and `resetStyle(enabled)`.

- [ ] **Step 1: Write failing formatter tests**

Test distinct background codes (`24`, `58`, `22`), ANSI resets, multiline agent prefixes, `NO_COLOR`, non-TTY behavior, and exact plain-text fallbacks.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npm exec -- tsx --test test/tui.test.ts`
Expected: FAIL because `src/tui.ts` does not exist.

- [ ] **Step 3: Implement the formatter module**

Use ANSI 256-color sequences and these exact plain forms:

```ts
formatUserPrompt(false) === "USER │ "
formatToolLine("npm test", false) === "TOOL │ $ npm test"
formatAgentReply("one\ntwo", false) === "AGENT │ one\nAGENT │ two"
```

The colored user prompt intentionally remains active so typed input inherits its background; `resetStyle(true)` terminates it after submission.

- [ ] **Step 4: Run focused tests and confirm GREEN**

Run: `npm exec -- tsx --test test/tui.test.ts`
Expected: all TUI formatter tests pass.

### Task 2: CLI integration and regression verification

**Files:**
- Modify: `src/index.ts:172-218`
- Modify: `src/loop.ts:13-15,132`
- Test: `test/tui.test.ts`

**Interfaces:**
- Consumes: all formatter exports from Task 1.
- Produces: colored interactive prompt/reply/tool output with plain redirected output.

- [ ] **Step 1: Integrate USER and AGENT output**

In `src/index.ts`, compute color support for stderr/stdout, replace `>>> ` with `formatUserPrompt`, write `resetStyle` at the beginning of every `line` handler and on close, and pass final replies through `formatAgentReply`.

- [ ] **Step 2: Integrate TOOL output**

In `src/loop.ts`, replace the raw `  $ command` output with `formatToolLine(command, supportsColor(process.stderr))` followed by one newline.

- [ ] **Step 3: Run complete verification**

Run:

```bash
npm test
npm run build
npm --prefix web test
npm --prefix web run build
git diff --check
```

Expected: all tests pass, both builds complete, and diff check emits no errors.

- [ ] **Step 4: Commit and push**

```bash
git add src/tui.ts src/index.ts src/loop.ts test/tui.test.ts \
  docs/superpowers/plans/2026-07-15-cli-tui-colors.md
git commit -m "feat(cli): color conversation roles"
git push origin dev
```
