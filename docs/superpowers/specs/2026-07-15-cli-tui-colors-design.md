# CLI TUI Role Colors Design

## Goal

Make interactive terminal conversations immediately scannable by giving user input, agent tool activity, and agent replies distinct dark background colors.

## Visual Design

- `USER │`: dark navy background with light text.
- `TOOL │`: dark brown background with warm yellow text.
- `AGENT │`: dark green background with light green text.
- Background color covers only the rendered text area, not the terminal's full width.
- Every line of a multiline agent reply receives its own `AGENT │` prefix and style.

## Architecture

Create `src/tui.ts` as the only owner of ANSI escape sequences. It exposes pure formatting functions for the user prompt, tool lines, and agent reply lines, plus a reset sequence. `src/index.ts` uses it for the interactive prompt and final replies; `src/loop.ts` uses it for tool commands.

## Compatibility

Colors are enabled only when the target stream is a TTY and `NO_COLOR` is not set. Redirected output, CI logs, and noninteractive use remain plain text. Every colored line is explicitly reset so styles cannot leak into later terminal output; the interactive user prompt is reset immediately after submission and again on close.

## Testing

Unit tests verify that the three roles use distinct backgrounds, multiline agent replies style every line, reset sequences prevent color leakage, and disabled styling produces plain text. Existing test suites and TypeScript builds must continue to pass.

## Non-goals

- Full-screen terminal UI or cursor-position management.
- External color dependencies.
- Styling setup wizard, status, compression, or error lines.
- User-configurable themes in this change.
