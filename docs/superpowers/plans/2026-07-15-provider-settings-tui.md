# Provider Settings Retained TUI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Pi-style inline retained TUI with secure provider authentication, dynamic model selection, and explicit reasoning effort settings.

**Architecture:** Secure configuration and provider concerns remain pure modules. The engine emits structured events and receives an immutable runtime request configuration. Pi TUI components consume controller state, while a settings state machine supports both first-run setup and a runtime overlay.

**Tech Stack:** TypeScript, Node.js 22.19+, OpenAI SDK, `@earendil-works/pi-tui`, Node test runner, Astro/Solid dashboard.

## Global Constraints

- Use `~/.inlineagent/config.json` only; do not migrate the old config path.
- Store the directory with mode `0700` and the config file with mode `0600`.
- Never display or broadcast API keys.
- Support Z.AI, OpenAI, and custom OpenAI-compatible providers only.
- Do not offer Auto reasoning; default every provider to explicit `high`.
- Preserve conversation state when settings change.
- Preserve terminal-native scrollback by avoiding the alternate screen.
- Do not use subagents.

---

### Task 1: Secure configuration store

**Files:**
- Create: `src/config.ts`
- Create: `test/config.test.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Produce `AgentConfig`, `ProviderId`, `ReasoningEffort`, `CONFIG_FILE`, `loadConfig`, `saveConfig`, `maskApiKey`, and `environmentConfigSeed`.

- [ ] Write failing tests for schema validation, missing/corrupt files, mode `0700`/`0600`, atomic replacement, key masking, and absence of old-path lookup.
- [ ] Run `npx tsx --test test/config.test.ts` and confirm failure because `src/config.ts` is absent.
- [ ] Implement the smallest secure store and environment seed helpers.
- [ ] Re-run the config test and confirm all cases pass.

### Task 2: Provider runtime and model discovery

**Files:**
- Create: `src/provider.ts`
- Create: `test/provider.test.ts`

**Interfaces:**
- Consume `AgentConfig` and provider types from Task 1.
- Produce `providerDefinition`, `createProviderClient`, `listProviderModels`, and typed discovery success/fallback/auth-error results.

- [ ] Write failing tests for provider base URLs, exact reasoning lists, explicit `high` defaults, sorted unique model IDs, `401/403` blocking, and fallback-eligible errors.
- [ ] Run `npx tsx --test test/provider.test.ts` and confirm the missing module failure.
- [ ] Implement provider descriptors, client creation, and model discovery using `client.models.list()`.
- [ ] Re-run provider tests and confirm all cases pass.

### Task 3: Structured engine events and request settings

**Files:**
- Create: `src/agent-events.ts`
- Modify: `src/loop.ts`
- Modify: `src/server.ts`
- Modify: `test/api-context.test.ts`
- Create: `test/agent-events.test.ts`
- Modify: `web/src/components/ContextApp.tsx`
- Modify: `web/test/dev-stack.test.mjs`

**Interfaces:**
- Produce `AgentEvent` and `AgentEventHandler`.
- Extend `run` options with `reasoningEffort` and `onEvent`.
- Extend dashboard snapshot with request `model` and `reasoningEffort` only; credentials remain excluded.

- [ ] Write failing tests asserting event order, no direct tool output, exact `reasoning_effort`, and dashboard metadata.
- [ ] Run focused tests and confirm failures for the missing behavior.
- [ ] Emit structured events, move line output into the line adapter, and record sanitized request metadata.
- [ ] Add dashboard model/reasoning fields and re-run focused root/web tests.

### Task 4: Retained chat and settings components

**Files:**
- Create: `src/tui/theme.ts`
- Create: `src/tui/chat.ts`
- Create: `src/tui/settings.ts`
- Create: `test/tui-chat.test.ts`
- Create: `test/tui-settings.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produce width-safe transcript components, `ChatView`, `SettingsController`, and `SettingsView`.
- Consume Pi TUI `Editor`, `Input`, `SelectList`, and retained component contracts.

- [ ] Install `@earendil-works/pi-tui@^0.80.7`.
- [ ] Write failing tests for role rendering, narrow widths, multiline editor submission, settings transitions, masked keys, model fallback, and reasoning choices.
- [ ] Run focused TUI tests and confirm failures for missing modules.
- [ ] Implement themes, retained chat components, and the asynchronous settings state machine/view.
- [ ] Re-run focused tests and TypeScript compilation.

### Task 5: Application orchestration and entry point

**Files:**
- Create: `src/tui/app.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Create: `test/tui-app.test.ts`

**Interfaces:**
- Consume the configuration, provider, engine event, chat, and settings interfaces from Tasks 1–4.
- Produce `InlineAgentApp`, TTY startup, FIFO processing, commands, live runtime replacement, and terminal cleanup.

- [ ] Write failing controller tests for first-run settings, `/settings`, `/clear`, FIFO prompts, config changes preserving messages, errors, and stop cleanup.
- [ ] Run the focused app test and confirm missing behavior.
- [ ] Implement TTY orchestration and retain a non-TTY line adapter.
- [ ] Document settings path, provider/model/reasoning controls, and keybindings.
- [ ] Run `npm test && npm run build && npm --prefix web test && npm --prefix web run build && git diff --check`.
- [ ] Run a PTY smoke test against a local fake OpenAI-compatible `/models` and `/chat/completions` server.
- [ ] Commit only approved files, push `dev`, and verify local `HEAD` equals `origin/dev`.
