# Request-local Tool-call Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live-updatable, request-local system policy that asks the model to emit at most 1–100 shell tool calls per assistant response.

**Architecture:** Persist the configured maximum in `AgentConfig`, generate one immutable transient policy message per request, and insert it immediately before the newest user message during context projection. TUI runs provide a synchronous getter so a setting saved during an active tool loop affects the next API request without changing the snapshot semantics of other runtime settings.

**Tech Stack:** TypeScript, Node.js 22+, OpenAI-compatible Chat Completions, `@earendil-works/pi-tui`, Node test runner via `tsx`.

## Global Constraints

- Range is integer `1–100`; default is `1`.
- The policy is a `system` message inserted immediately before the newest real `user` message.
- The policy is request-only and never enters canonical trajectory messages.
- Native API `tools` remain unchanged.
- This release is soft-limit only; all provider-emitted calls still execute.
- A saved TUI setting applies to the next API request, including one inside an active tool loop.
- Existing unrelated local changes in `src/system-prompt.ts` and `test/system-prompt.test.ts` must not be staged.

---

### Task 1: Persist and validate the maximum

**Files:**
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Test: `test/config.test.ts`
- Test: `test/provider.test.ts`
- Test: `test/tui-app.test.ts`
- Test: `test/tui-chat.test.ts`
- Test: `test/tui-settings.test.ts`

**Interfaces:**
- Produces: `DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE = 1`
- Produces: `MIN_MAX_TOOL_CALLS_PER_RESPONSE = 1`
- Produces: `MAX_MAX_TOOL_CALLS_PER_RESPONSE = 100`
- Produces: `AgentConfig.maxToolCallsPerResponse: number`
- Consumed by: request projection, line mode, settings controller, and TUI app in later tasks.

- [ ] **Step 1: Write failing config tests**

Add assertions that old version-1 config receives `1`, valid boundaries `1` and `100` load, and `0`, `101`, fractions, and strings fail. Update the shared valid fixture:

```ts
const validConfig: AgentConfig = {
  // existing fields
  maxToolCallsPerResponse: 1,
};
```

Assert environment seeds contain:

```ts
assert.equal(seed.maxToolCallsPerResponse, 1);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npx tsx --test test/config.test.ts
```

Expected: FAIL because the field and constants do not exist and parsed configs omit the value.

- [ ] **Step 3: Implement config constants, schema parsing, and line-mode propagation**

In `src/config.ts` add:

```ts
export const DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE = 1;
export const MIN_MAX_TOOL_CALLS_PER_RESPONSE = 1;
export const MAX_MAX_TOOL_CALLS_PER_RESPONSE = 100;
```

Add the field to `AgentConfig`, defaults to `environmentConfigSeed()`, and strict integer/range validation in `parseConfig()`.

In `src/index.ts`, fill the environment-only line-mode config with the default and pass the saved value to `RunOptions`:

```ts
maxToolCallsPerResponse: config.maxToolCallsPerResponse,
```

Update every typed `AgentConfig` test fixture with `maxToolCallsPerResponse: 1`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```bash
npx tsx --test test/config.test.ts test/provider.test.ts test/tui-app.test.ts test/tui-chat.test.ts test/tui-settings.test.ts
npm run build
```

Expected: all focused tests pass and TypeScript builds.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/index.ts test/config.test.ts test/provider.test.ts test/tui-app.test.ts test/tui-chat.test.ts test/tui-settings.test.ts
git commit -m "feat: configure maximum tool calls"
```

---

### Task 2: Insert one transient policy in every request projection

**Files:**
- Create: `src/runtime-tool-policy.ts`
- Modify: `src/context-projection.ts`
- Modify: `src/loop.ts`
- Test: `test/trajectory-retention.test.ts`
- Test: `test/api-context.test.ts`
- Test: `test/agent-events.test.ts`

**Interfaces:**
- Produces: `createRuntimeToolPolicy(maxToolCallsPerResponse: number): Message`
- Produces: `insertRuntimeToolPolicy(messages: Message[], maxToolCallsPerResponse: number): Message[]`
- Produces: `MissingUserAnchorError`
- Extends: `ContextProjectionOptions.maxToolCallsPerResponse: number`
- Extends: `RunOptions.maxToolCallsPerResponse: number`
- Extends: `RunOptions.maxToolCallsPerResponseLoader?: () => number`

- [ ] **Step 1: Write failing projection tests**

Cover the exact request-local behavior:

```ts
const canonical: Message[] = [
  { role: "user", content: "old" },
  { role: "assistant", content: "answer" },
  { role: "user", content: "new" },
];
const original = structuredClone(canonical);
const result = buildContextProjection({
  messages: canonical,
  systemPrompt: "home system",
  tools: [],
  configuredRawActions: 3,
  maxToolCallsPerResponse: 5,
  maxInputTokens: 10_000,
});
assert.deepEqual(result.apiMessages.slice(-2), [
  {
    role: "system",
    content: "[runtime tool policy]\nIn this assistant response, emit at most 5 shell tool calls.\nIf more work is needed, wait for the tool results and continue in the next response.",
  },
  { role: "user", content: "new" },
]);
assert.deepEqual(canonical, original);
assert.equal(result.apiMessages.filter((m) => m.content.startsWith("[runtime tool policy]")).length, 1);
```

Also test no-user failure, repeated projection without accumulation, and policy-token inclusion.

- [ ] **Step 2: Run projection tests and verify RED**

Run:

```bash
npx tsx --test test/trajectory-retention.test.ts
```

Expected: FAIL because projection has no runtime policy support.

- [ ] **Step 3: Implement the focused policy helper**

Create `src/runtime-tool-policy.ts` with exact integer validation, stable prompt wording, immutable insertion before the newest user, and `MissingUserAnchorError`. Do not mutate the input array or message objects.

- [ ] **Step 4: Integrate policy before request estimation**

In `src/context-projection.ts`, apply `insertRuntimeToolPolicy()` to every candidate before `prependSystemPrompt()` and before `estimateRequestTokens()`.

In `src/loop.ts`, load the live value immediately before each projection:

```ts
const maxToolCallsPerResponse = opts.maxToolCallsPerResponseLoader?.()
  ?? opts.maxToolCallsPerResponse;
```

Pass it to `buildContextProjection()`. Do not set `parallel_tool_calls`, alter the tool schema, or change the tool execution loop.

- [ ] **Step 5: Write integration tests**

In `test/api-context.test.ts`, assert:

- provider request contains exactly one policy;
- dashboard snapshot equals the request;
- native tools are unchanged;
- canonical messages contain no policy after completion.

Add a two-request tool-loop test whose loader returns `1` for the first request and `7` for the second, proving live reload within one run.

Update context projection fixtures and typed `RunOptions` fixtures with the new required field.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npx tsx --test test/trajectory-retention.test.ts test/api-context.test.ts test/agent-events.test.ts
npm run build
```

Expected: all tests pass and the request captured by the provider equals dashboard `apiMessages`.

- [ ] **Step 7: Commit**

```bash
git add src/runtime-tool-policy.ts src/context-projection.ts src/loop.ts test/trajectory-retention.test.ts test/api-context.test.ts test/agent-events.test.ts
git commit -m "feat: inject request-local tool policy"
```

---

### Task 3: Expose the setting in first-run and chat settings

**Files:**
- Modify: `src/tui/settings.ts`
- Modify: `src/tui/app.ts`
- Test: `test/tui-settings.test.ts`
- Test: `test/tui-app.test.ts`

**Interfaces:**
- Adds settings steps: `"max-tool-calls" | "max-tool-calls-input"`
- Adds controller methods: `editMaxToolCallsPerResponse()`, `selectMaxToolCallsPerResponse(value: number)`, `chooseCustomMaxToolCallsPerResponse()`, and `submitMaxToolCallsPerResponse(value: string)`
- TUI `RunOptions.maxToolCallsPerResponseLoader` reads the app's current config on every invocation.

- [ ] **Step 1: Write failing settings tests**

Test the first-run sequence:

```text
reasoning -> raw-actions -> safety-limit -> max-tool-calls -> confirm
```

Test chat menu rendering of `Max tool calls per response: 1`, preset selection, custom values `1` and `100`, rejection of `0` and `101`, returning to the direct menu after editing, and saved config output.

- [ ] **Step 2: Write failing live-app test**

Capture `RunOptions` from an active fake run, save a replacement config with `maxToolCallsPerResponse: 9`, and assert:

```ts
assert.equal(options.maxToolCallsPerResponseLoader?.(), 9);
```

The initial fixed field remains `1`, proving only the getter is live.

- [ ] **Step 3: Run TUI tests and verify RED**

Run:

```bash
npx tsx --test test/tui-settings.test.ts test/tui-app.test.ts
```

Expected: FAIL because the settings steps, menu row, controller methods, and live getter do not exist.

- [ ] **Step 4: Implement settings controller and view**

Add the draft field, direct-menu row, presets, direct input, header summary, validation, and first-run transition. Valid direct-menu edits return to `menu`; first-run selection proceeds to `confirm`.

Change the confirmation back action to return to `max-tool-calls` because it is now the final first-run selection step.

- [ ] **Step 5: Pass a live getter from the app**

In `src/tui/app.ts`, include:

```ts
maxToolCallsPerResponse: config.maxToolCallsPerResponse,
maxToolCallsPerResponseLoader: () => (
  this.config?.maxToolCallsPerResponse
  ?? config.maxToolCallsPerResponse
),
```

Do not make the other run settings live.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run:

```bash
npx tsx --test test/tui-settings.test.ts test/tui-app.test.ts test/tui-chat.test.ts
npm run build
```

Expected: all tests pass and TypeScript builds.

- [ ] **Step 7: Commit**

```bash
git add src/tui/settings.ts src/tui/app.ts test/tui-settings.test.ts test/tui-app.test.ts
git commit -m "feat: expose live tool-call policy setting"
```

---

### Task 4: Documentation and release verification

**Files:**
- Modify: `README.md`
- Verify: all source and web tests/builds

**Interfaces:**
- Documents the soft-limit nature, default/range, request-local insertion, live update, and cache trade-off.

- [ ] **Step 1: Update README**

Document:

- `/settings` row and presets;
- default 1 and range 1–100;
- latest-user-adjacent transient system policy;
- no canonical accumulation;
- next-API live application;
- soft limit only;
- intentional first-request suffix-cache loss per user turn.

- [ ] **Step 2: Run complete verification**

Run:

```bash
npm test
npm run build
npm --prefix web test
npm --prefix web run build
npm pack --dry-run --json
git diff --check
```

Expected:

- all root tests pass;
- TypeScript build passes;
- all web tests pass;
- Astro build passes;
- package contains `dist/runtime-tool-policy.js`;
- no whitespace errors.

- [ ] **Step 3: Audit staged scope**

Ensure `src/system-prompt.ts`, `test/system-prompt.test.ts`, `.env`, `test.txt`, `web/.astro/`, and `web/bun.lock` are not staged.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: explain request-local tool policy"
```

- [ ] **Step 5: Push synchronized branches**

After confirming `master` is clean except preserved unrelated files:

```bash
git push origin master
git push origin master:dev
```

Expected: `origin/master` and `origin/dev` point to the same implementation commit.
