# Configurable Tool Output Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recent raw tool retention and single-output safety limits configurable while keeping trajectory memory and provider requests bounded.

**Architecture:** Shell capture enforces only a user hard ceiling. Canonical history retains a fixed 20-action raw recovery ring, while a request-only projection preserves configured recent actions and reduces its effective window under context pressure. Settings and dashboard state expose the configured and effective behavior.

**Tech Stack:** TypeScript, Node.js, OpenAI-compatible Chat Completions, Pi TUI, Astro/Solid dashboard, Node test runner.

## Global Constraints

- Default to 3 recent actions and 65,536 characters per output.
- Allow action values 1–20 and safety limits 4K–1M.
- Remove model-controlled `max_length` completely.
- Preserve output tails when the hard limit is exceeded.
- Keep at most 20 raw action groups in canonical memory.
- Do not silently truncate user or system messages.
- Do not use subagents.

---

### Task 1: Configuration schema and settings parser

**Files:** `src/config.ts`, `src/tui/settings.ts`, `test/config.test.ts`, `test/tui-settings.test.ts`

- [ ] Write failing tests for defaults, ranges, K/M parsing, presets, confirmation output, and persisted values.
- [ ] Run focused tests and confirm the missing behavior.
- [ ] Add constants, validated config fields, parser/formatter helpers, controller steps, and settings selectors.
- [ ] Re-run focused tests and TypeScript compilation.

### Task 2: Configurable shell safety ceiling

**Files:** `src/shell.ts`, `src/loop.ts`, `test/shell.test.ts`, `test/api-context.test.ts`

- [ ] Write failing tests proving an under-limit result is exact, an over-limit result never exceeds the configured limit, the full secure log exists, and `max_length` is absent from the tool schema.
- [ ] Run focused tests and confirm failures.
- [ ] Replace the 500-character default with the configured ceiling, budget the notice inside the limit, and remove `max_length` from request parsing/schema.
- [ ] Re-run focused tests.

### Task 3: Correct projection and bounded recovery ring

**Files:** `src/trajectory.ts`, `src/context-projection.ts`, `src/loop.ts`, `test/trajectory-retention.test.ts`, `test/api-context.test.ts`

- [ ] Write failing tests for exact N boundaries, off-by-one behavior, immutable projection, 20-action canonical compaction, effective-N context reduction, and overflow failure.
- [ ] Run focused tests and confirm failures.
- [ ] Parameterize trajectory projection, add canonical recovery compaction, and add full-request context projection.
- [ ] Connect projection and canonical compaction to the loop.
- [ ] Re-run focused and regression tests.

### Task 4: Runtime and TUI memory behavior

**Files:** `src/tui/app.ts`, `src/tui/chat.ts`, `src/index.ts`, `test/tui-app.test.ts`, `test/tui-chat.test.ts`

- [ ] Write failing tests for run-setting snapshots, live config changes, and 4K tool previews.
- [ ] Run focused tests and confirm failures.
- [ ] Pass retention settings into every run and cap retained tool-card output.
- [ ] Re-run focused tests and build.

### Task 5: Dashboard metrics and release verification

**Files:** `src/server.ts`, `web/src/components/ContextApp.tsx`, `test/server.test.ts`, `web/test/dev-stack.test.mjs`, `README.md`

- [ ] Write failing tests for safety truncation, current projection savings, and configured/effective raw action counts.
- [ ] Run focused tests and confirm failures.
- [ ] Add metrics and update dashboard labels/documentation.
- [ ] Run root tests, TypeScript build, web tests, Astro build, and `git diff --check`.
- [ ] Run a fake-provider integration proving request projection equals the dashboard snapshot.
- [ ] Commit only approved files, push `dev`, and verify `HEAD == origin/dev`.
