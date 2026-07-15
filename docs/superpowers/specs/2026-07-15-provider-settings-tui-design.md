# Provider Settings Retained TUI Design

## Goal

Replace the TTY readline interface with a Pi-style inline retained-mode TUI and add a shared first-run/`/settings` flow for provider authentication, model selection, and explicit reasoning effort configuration.

## Scope

This phase provides the retained TUI foundation, configuration workflow, multiline editor, transcript, structured agent/tool events, FIFO prompt queue, and live runtime configuration changes. Assistant token streaming and run cancellation remain outside this phase.

Non-TTY execution retains a line-oriented fallback. The alternate screen buffer is not used, preserving terminal scrollback, selection, search, and tmux copy mode.

## Configuration

The only configuration file is `~/.inlineagent/config.json`. No migration or lookup of the old `~/.inline-agent/config.json` path is performed.

Schema:

```json
{
  "version": 1,
  "provider": "zai",
  "apiKey": "secret",
  "model": "glm-5.2",
  "reasoningEffort": "high"
}
```

Custom providers also require `baseURL`. The configuration directory is mode `0700`; the file is atomically replaced and mode `0600`. Invalid JSON or schema is reported without overwriting the source. API keys are masked in UI output and never sent to the dashboard or transcript.

TTY mode uses saved configuration first. Environment credentials seed the first-run form only. Non-TTY mode preserves explicit `INLINE_*`, `ZAI_API_KEY`, and `OPENAI_API_KEY` behavior.

## Provider Runtime

Supported providers are Z.AI Coding Plan, OpenAI, and custom OpenAI-compatible endpoints.

The settings flow is:

1. select provider;
2. enter or retain a masked API key;
3. enter custom base URL when applicable;
4. verify authentication and call `/models`;
5. fuzzy-search a returned model or enter an exact ID;
6. select an explicit `reasoning_effort` value;
7. save and apply.

A `401` or `403` blocks saving as an authentication failure. Unsupported model-list endpoints and transient network/server failures permit direct model entry with a warning. Every provider defaults to the explicit value `high`; there is no Auto value.

Reasoning choices:

- Z.AI: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
- OpenAI and custom: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`

The exact selected string is sent in every Chat Completions request as `reasoning_effort`. Provider/model changes replace the client for the next request but retain the conversation trajectory and compression state.

## TUI Architecture

The implementation uses `@earendil-works/pi-tui` on Node.js 22.19 or later.

- `src/config.ts`: schema validation, secure atomic persistence, environment seed resolution.
- `src/provider.ts`: provider descriptors, client creation, model discovery, reasoning choices.
- `src/agent-events.ts`: structured assistant, tool, compression, and error event contract.
- `src/loop.ts`: emits events instead of writing directly to the terminal and includes reasoning effort in requests.
- `src/tui/theme.ts`: ANSI palette and Pi TUI component themes.
- `src/tui/chat.ts`: header, transcript cards, footer, and multiline editor.
- `src/tui/settings.ts`: reusable first-run/runtime settings state machine and component.
- `src/tui/app.ts`: runtime orchestration, overlay lifecycle, prompt queue, and command handling.
- `src/index.ts`: TTY/non-TTY selection and process lifecycle.

The base TUI hierarchy is header, transcript, editor, and footer. User, tool, and assistant blocks keep their existing calm dark backgrounds. The footer shows provider, model, reasoning effort, run state, queue length, and context usage. Narrow terminals drop secondary labels before truncating primary state.

`Enter` submits and `Ctrl+J` or `Shift+Enter` inserts a newline. `/settings`, `/clear`, `/exit`, and `/quit` are handled locally. Prompts submitted while the engine is running enter a FIFO queue and execute in order.

## Agent Events and Dashboard

The loop emits structured events for run start, assistant completion, tool start, tool completion, trajectory compression, and failure. The non-TTY adapter formats these events as lines; the TUI updates retained components and requests a differential render. No engine code writes directly to stdout or stderr during a TUI run.

The context dashboard additionally shows the active model and explicit reasoning effort from the actual request snapshot. Authentication data is excluded.

## Error Handling

- Invalid config: preserve the file and open recovery settings.
- Save failure: keep the active runtime unchanged and show the error in settings.
- Model discovery failure: distinguish authentication failure from fallback-eligible endpoint/network errors.
- API/tool error: append an error block while retaining transcript and editor.
- TUI termination: always stop the renderer, restore raw mode, and show the cursor.
- Rendering: every component respects supplied width; descriptions and secondary status disappear first on narrow terminals.

## Verification

Automated tests cover secure config persistence and validation, API-key masking, provider model discovery outcomes, exact reasoning values, request-time reasoning propagation, dashboard request metadata, event order, settings transitions, command handling, FIFO queuing, width-constrained rendering, multiline input, resize, IME cursor markers, and terminal cleanup.

Final verification runs root tests, TypeScript compilation, web tests, Astro build, `git diff --check`, and a pseudo-terminal smoke test against a local fake OpenAI-compatible server.
