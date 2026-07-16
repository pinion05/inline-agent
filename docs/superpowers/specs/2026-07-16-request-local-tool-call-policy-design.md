# Request-local tool-call policy design

Date: 2026-07-16
Status: Proposed for implementation

## 1. Goal

Allow users to configure the maximum number of shell tool calls the model should emit in one assistant response.

- Range: `1–100`
- Default: `1`
- Configuration surface: first-run settings and the chat `/settings` menu
- Enforcement in this change: prompt-based soft limit
- Live update: a saved setting applies to the next API request, including the next request inside an already-running tool loop

The policy must remain highly visible to the model without accumulating in the canonical conversation trajectory or moving the native tool schema into messages.

## 2. Non-goals

This change does not:

- hard-reject or defer tool calls beyond the configured limit;
- set `parallel_tool_calls: false`;
- split an assistant response containing multiple tool calls;
- execute shell commands concurrently;
- move or rewrite the native `tools` API field;
- change raw tool-output retention accounting.

Hard execution limits and actual-tool-call retention accounting remain follow-up work in issue #32.

## 3. Configuration

Add the following required runtime configuration field:

```ts
maxToolCallsPerResponse: number;
```

Validation:

```text
minimum: 1
maximum: 100
integer only
default for existing config files: 1
```

Version-1 config files that do not contain the field receive the default in memory. Secure persistence continues to use `~/.inlineagent/config.json` with the existing atomic-write and permission behavior.

## 4. Settings UX

### Chat `/settings` menu

Add a directly accessible row:

```text
Max tool calls per response: 1
```

Selecting it opens these presets:

```text
1, 2, 3, 5, 10, 20, 50, 100, 직접 입력
```

Direct input accepts integers from 1 through 100. A valid selection returns to the settings menu, where the user must choose `저장 및 적용` as with the other direct settings.

### First-run wizard

Insert the same selection step after the output safety-limit step and before final confirmation:

```text
reasoning -> raw actions -> output safety limit -> max tool calls -> confirm
```

The default selected value is 1.

### Runtime chrome

The settings summary/header displays the active value. The chat footer is unchanged.

## 5. Request-local policy message

For every API request, generate exactly one transient message:

```text
[runtime tool policy]
In this assistant response, emit at most N shell tool calls.
If more work is needed, wait for the tool results and continue in the next response.
```

Properties:

- role: `system`;
- N is loaded immediately before building each API request;
- the message exists only in the immutable request projection;
- it is never appended to canonical `messages`;
- the native shell schema remains in the API `tools` field unchanged;
- it is visible in the dashboard because the dashboard snapshots the exact final API messages.

The wording is stable except for N to minimize avoidable cache variation.

## 6. LRU-style moving insertion

The request projection uses the newest real user message as a moving anchor.

For each API request:

1. Build a candidate projected trajectory according to raw-action retention and context pressure.
2. Scan the candidate from the end to locate the newest message whose role is `user`.
3. Insert the transient runtime policy immediately before that user message.
4. Prepend the user-controlled home-scoped system prompt, if present.
5. Estimate the complete request, including policy and tools.
6. Send exactly this array to the provider and dashboard snapshot.

Production runs always add a user message before entering the API loop. If no user anchor exists, projection fails before the provider call with a clear internal-context error rather than silently omitting the policy.

The operation is described as LRU-style because the policy follows the most recently used user-turn anchor. No mutable LRU cache or stored policy-message list is needed: rebuilding an immutable request projection naturally removes the previous turn's policy and inserts the current one exactly once.

## 7. Turn lifecycle and cache behavior

### Within one user turn

The same policy is reconstructed at the same anchor for the initial model request and every subsequent request after tool results. The prefix through the policy and user message can therefore be reused by provider prompt caching during that turn.

### On the next user turn

The previous request-local policy was never canonical, so it is absent when the next projection starts. A new policy is inserted before the new user message. Compared with the preceding turn's API sequence, the prefix diverges at the old insertion point, so tokens after that point are expected to miss prefix caching on the first request. Exact cache accounting remains provider-specific.

This one-turn suffix-cache loss is intentional. It prevents policy accumulation and keeps live runtime instructions near the current task.

## 8. Live settings updates

The loop must not capture this one field as an immutable run-start value.

- Line mode uses a fixed getter backed by its static config.
- TUI mode supplies a runtime getter that reads the app's current saved config.
- The getter is invoked immediately before every API request projection.
- If `/settings` is saved while an API request is already in flight, that request is unchanged.
- The following API request, including one in the same tool loop, uses the new N.
- Provider, model, reasoning, raw retention, and safety-limit snapshot semantics remain unchanged.

A runtime value outside `1–100` fails before the provider call. It is not silently clamped.

## 9. Context projection and overflow

The transient policy must participate in request token estimation for every candidate effective raw-action count.

Context fallback remains:

1. try the configured raw-action count;
2. lower effective raw actions until the full request fits;
3. include the home system prompt, transient policy, and tools in every estimate;
4. fail before provider invocation if zero raw actions still do not fit.

The canonical trajectory remains unchanged by all attempts.

## 10. Soft-limit semantics

The policy is advisory in this release. If a provider emits more than N tool calls:

- retain the full assistant message;
- execute and return every tool call using current behavior;
- preserve valid assistant/tool pairing;
- do not retry or synthesize rejection results.

This avoids hidden correctness changes. Hard enforcement will be designed and benchmarked separately.

## 11. Dashboard transparency

The dashboard continues to display the exact provider request.

Expected effects:

- the transient policy appears as one `system` message immediately before the latest user message;
- no previous-turn policy appears;
- the displayed token estimate includes the policy;
- changing N updates the policy text on the next API request;
- API messages and provider-captured messages remain byte-for-byte structurally equal.

## 12. Testing

### Config

- default is 1 for old version-1 configs;
- accepts integer values 1 and 100;
- rejects 0, 101, fractions, strings, and non-finite numbers;
- environment-generated seeds include 1.

### Settings

- chat `/settings` exposes the direct row;
- presets and direct input work;
- invalid values remain on the input step with a range error;
- first-run flow includes the new selection;
- save preserves all unrelated config fields.

### Projection

- inserts one system policy immediately before the latest user;
- uses the newest of multiple user messages;
- never mutates canonical messages;
- repeated tool-loop projections do not accumulate policies;
- token estimation includes the policy;
- no-user input fails before provider invocation.

### Live update

- first request contains N=1;
- update the TUI config while the run remains active;
- next request in the same run contains the new N;
- the already-sent request remains unchanged.

### Integration

- dashboard `apiMessages` equal provider request messages;
- native `tools` remain unchanged;
- policy is absent from canonical trajectory after completion and interruption;
- full root and web test/build suites pass.

## 13. Rollout

No config-version migration is required. Existing config files receive default 1 when loaded and persist the field on the next settings save. The feature is provider-neutral because it uses ordinary Chat Completions system messages and does not rely on provider-specific parallel-tool parameters.
