# Configurable Tool Output Retention Design

## Goal

Preserve recent shell observations verbatim for a user-configurable number of tool actions, apply a configurable per-output safety ceiling only to abnormally large outputs, keep memory bounded, and expose the exact behavior in `/settings` and the context dashboard.

## Confirmed Defaults and Limits

- Recent raw tool actions default: `3`.
- Single output safety limit default: `65,536` characters (`64K`).
- Recent action range: `1–20`.
- Safety limit range: `4K–1M` characters.
- Presets: actions `1, 2, 3, 5, 10`; limits `16K, 64K, 256K, 1M`.
- Custom limit input accepts integer characters and `K`/`M` suffixes.
- Context safety takes priority over the configured recent-action count.
- Safety truncation preserves the tail of the output.
- The model-facing shell tool no longer accepts `max_length`.

## Configuration

`~/.inlineagent/config.json` gains:

```json
{
  "recentRawToolActions": 3,
  "toolOutputSafetyLimit": 65536
}
```

Existing version-1 files without these fields load with the defaults. Saves include explicit values. `/settings` adds recent-action and safety-limit steps after reasoning. The confirmation view shows the maximum recoverable raw memory implied by the configured values.

## Shell Capture

Shell output is sanitized before applying limits. Output at or below the configured character limit is returned verbatim with its exit marker and is not logged. Output above the limit is written in full to a mode-`0600` file under the mode-`0700` directory `~/.inlineagent/log/`.

The model-facing tool result contains a truncation/log-path notice plus the output tail. The entire result, including the notice, must not exceed the configured safety limit. The tool schema contains only the required `command` argument, so the model cannot override the user ceiling.

## Bounded Canonical Trajectory

The canonical in-memory trajectory retains raw tool observations only for the newest 20 tool-action groups. After each tool round, action groups older than that recovery window are permanently reduced. This bounds recoverable raw tool content to:

```text
20 × toolOutputSafetyLimit
```

At the default this is 1,310,720 characters. At the user-selected maximum it is 20,971,520 characters. TUI tool cards retain at most a 4K tail preview, preventing a second unbounded copy in the render tree.

## Request-Time Projection

Immediately before every API request:

1. Start with the configured recent raw action count.
2. Compress all older tool-action groups in an immutable request-only projection.
3. Add the current system prompt and tool definition.
4. Estimate the complete request against the model context reservation.
5. If it does not fit, decrement the effective raw action count until it fits.
6. If even zero raw actions do not fit, fail before the provider call instead of silently modifying user/system text.

The canonical trajectory is not mutated by request projection. Increasing N can restore raw observations still inside the 20-action recovery ring. The cut-point logic must preserve exactly N complete assistant-tool groups, fixing the existing off-by-one behavior.

## Dashboard Metrics

The dashboard separates:

- `safetyTruncatedTokens`: cumulative tokens permanently removed by single-output safety limits;
- `currentProjectionTokens`: tokens omitted from the current API request by trajectory projection;
- `configuredRawActions`: the saved N value;
- `effectiveRawActions`: the count that fit the current request.

The exact `apiMessages` remains the actual projected request sent to the provider.

## Runtime Semantics

Settings changes preserve conversation state. A running loop uses its initial settings snapshot; the next queued loop uses newly saved values. Canonical recovery stays capped at 20 regardless of the selected N.

## Verification

Tests cover configuration defaults/validation, suffix parsing, presets, exact 1/3/20 action boundaries, off-by-one correction, 20-action canonical memory recovery, 64K tail truncation and secure log fallback, absence of `max_length`, context-pressure effective-N reduction, context overflow failure, 4K TUI preview, dashboard metric separation, and equality between provider request messages and dashboard snapshots.
