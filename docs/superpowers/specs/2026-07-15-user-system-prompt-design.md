# User System Prompt Design

## Goal

Allow the user to control the LLM system prompt through the single home-scoped file `~/.inlineagent/system.md` while keeping the existing zero-system-prompt behavior when that file is absent or empty.

## Confirmed Decisions

- The only supported path is `~/.inlineagent/system.md`.
- Project-local files are not searched.
- The file is read immediately before every LLM API call.
- Changes made while the agent is running apply to the next API call.
- The UTF-8 file contents are sent without trimming or newline normalization.

## Request Construction

The conversation trajectory remains free of configuration messages. Immediately before each API call, the loop reads the configured file and creates a request-only message array:

```ts
const apiMessages = systemPrompt === undefined
  ? messages
  : [{ role: "system", content: systemPrompt }, ...messages];
```

The system message is always the first API message. It is not appended to the mutable conversation history, so changing the file replaces the effective prompt instead of accumulating obsolete system messages. Trajectory compression therefore cannot remove or rewrite it.

The exact request-only array is passed to both OpenAI and `recordApiContext()`. The dashboard consequently displays the same system prompt under both **실제 SYSTEM PROMPT** and **실제 LLM 컨텍스트**.

## File Semantics

- Missing file (`ENOENT`): return no system prompt.
- Zero-byte file: return no system prompt.
- Non-empty file, including whitespace-only content: preserve and send it exactly.
- Other read failures, including permission and directory errors: throw the original error so the CLI reports the configuration problem instead of silently calling the model without the requested prompt.
- Home resolution uses `node:os` `homedir()` and is independent of the current working directory.

## Interfaces

A focused module owns path resolution and loading:

```ts
export const SYSTEM_PROMPT_PATH: string;
export function loadSystemPrompt(path?: string): Promise<string | undefined>;
export function prependSystemPrompt(
  messages: Message[],
  prompt: string | undefined,
): Message[];
```

`RunOptions` accepts an optional `systemPromptLoader` dependency. Production defaults to `loadSystemPrompt`; tests inject deterministic loaders so a developer's real home configuration never affects test results.

## Documentation

README setup instructions show:

```bash
mkdir -p ~/.inlineagent
$EDITOR ~/.inlineagent/system.md
```

The documentation states that the file is optional, hot-reloaded before each API call, and visible verbatim on the context dashboard.

## Verification

Automated tests cover:

1. exact UTF-8 and trailing-newline preservation;
2. missing and zero-byte files;
3. propagation of non-`ENOENT` errors;
4. request-only prefixing without conversation mutation;
5. exact equality among the loader content, API request messages, and dashboard snapshot;
6. reloading between successive tool-loop API calls.

The final verification runs root tests, TypeScript compilation, web tests, Astro build, and `git diff --check`.
