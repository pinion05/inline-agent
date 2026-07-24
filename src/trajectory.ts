/**
 * Rule-based trajectory compression (#21).
 *
 * Recent N turns: keep as-is.
 * Older turns: merge assistant(tool_calls) + tool(result) into
 *   "$ command → result (truncated)"
 * No LLM call. Pure pattern matching.
 *
 * Research basis:
 *   AgentDiet (FSE 2026): 40-60% token reduction, 0 performance loss
 *   CoACT (2026): 33% reduction, +3.5% pass@1 improvement
 *   "Long contexts actively degrade LLM performance" (Liu et al. 2023)
 */
import { estimateTokens, type Message } from "./compact.js";

const KEEP_ACTIONS = 3; // default recent action groups (assistant+tool)
export const MAX_RECOVERABLE_TOOL_ACTIONS = 20;

/**
 * Compress old trajectory entries, keeping only recent turns intact.
 * Old assistant+tool pairs become single text messages.
 */
export function compressTrajectory(messages: Message[]): Message[] {
  return projectTrajectory(messages, KEEP_ACTIONS);
}

/** Build an immutable request view that keeps exactly N recent tool actions raw. */
export function projectTrajectory(
  messages: Message[],
  keepActions: number,
): Message[] {
  if (!Number.isInteger(keepActions) || keepActions < 0) {
    throw new Error("keepActions must be a non-negative integer");
  }
  if (messages.length === 0) return [];

  const actionIndices = messages
    .map((message, index) => (
      message.role === "assistant" && message.tool_calls?.length ? index : -1
    ))
    .filter((index) => index >= 0);
  if (actionIndices.length <= keepActions) return messages.slice();

  const recentStart = keepActions === 0
    ? messages.length
    : actionIndices[actionIndices.length - keepActions];
  const old = messages.slice(0, recentStart);
  const recent = messages.slice(recentStart);
  return [...mergeOldMessages(old), ...recent];
}

export function countRawToolActions(messages: Message[]): number {
  return messages.reduce(
    (count, message) => count + (
      message.role === "assistant" && message.tool_calls?.length ? 1 : 0
    ),
    0,
  );
}

export function compactCanonicalTrajectory(
  messages: Message[],
  maxRawActions: number = MAX_RECOVERABLE_TOOL_ACTIONS,
): {
  messages: Message[];
  compressedActions: number;
  eliminatedTokens: number;
} {
  const beforeActions = countRawToolActions(messages);
  const beforeTokens = estimateTokens(messages);
  const projected = projectTrajectory(messages, maxRawActions);
  return {
    messages: projected,
    compressedActions: beforeActions - countRawToolActions(projected),
    eliminatedTokens: Math.max(0, beforeTokens - estimateTokens(projected)),
  };
}

/**
 * Merge old messages: assistant(tool_calls) + tool(result) → single text.
 */
function mergeOldMessages(messages: Message[]): Message[] {
  const result: Message[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i];

    // User messages: keep as-is (user input is always high-value).
    if (msg.role === "user") {
      result.push(msg);
      i++;
      continue;
    }

    // Assistant with tool calls: merge with following tool results.
    if (msg.role === "assistant" && msg.tool_calls?.length) {
      const merged = mergeActionWithResults(msg, messages, i);
      result.push(merged.message);
      i = merged.nextIndex;
      continue;
    }

    // Assistant without tool calls (pure reasoning/text): compress to 1 line.
    if (msg.role === "assistant" && msg.content) {
      const oneLiner = compressReasoning(msg.content);
      if (oneLiner) {
        result.push({ role: "assistant", content: oneLiner });
      }
      i++;
      continue;
    }

    // Orphan tool result (shouldn't happen, but handle gracefully).
    if (msg.role === "tool") {
      result.push({
        role: "assistant",
        content: compressResult(msg.content),
      });
      i++;
      continue;
    }

    // System or anything else: keep.
    result.push(msg);
    i++;
  }

  return result;
}

/**
 * Merge an assistant(tool_calls) message with its tool results
 * into a single compact text message.
 */
function mergeActionWithResults(
  assistant: Message,
  messages: Message[],
  startIndex: number
): { message: Message; nextIndex: number } {
  const parts: string[] = [];

  // Extract commands from tool calls.
  const toolCalls = assistant.tool_calls ?? [];
  const results: Message[] = [];
  let nextIndex = startIndex + 1;

  // Collect all tool results that follow.
  for (let j = startIndex + 1; j < messages.length; j++) {
    if (messages[j].role !== "tool") break;
    results.push(messages[j]);
    nextIndex = j + 1;
  }

  // Match each tool call with its result.
  for (const tc of toolCalls) {
    let command = "";
    try {
      const args = JSON.parse(tc.function?.arguments ?? "{}");
      command = args.command ?? "(unknown)";
    } catch {
      command = "(parse error)";
    }

    const result = results.find(
      (r) => r.tool_call_id === (tc as any).id
    );

    const rawResult = result?.content ?? "(no result)";
    const compressedResult = compressResult(rawResult);

    parts.push(`$ ${command} → ${compressedResult}`);
  }

  // Include assistant's reasoning as a brief note (if any).
  if (assistant.content) {
    const reasoning = compressReasoning(assistant.content);
    if (reasoning) parts.unshift(reasoning);
  }

  return {
    message: {
      role: "assistant",
      content: parts.join("\n"),
    },
    nextIndex,
  };
}

/**
 * A run of directory-listing-like lines. `ls -l` rows start with a Unix
 * permission token; `ls` plain rows are bare names. We treat 3+ consecutive
 * matches as a listing and summarize it.
 */
const LS_LONG_LINE = /^[dls-][rwx-]{9}\s/;
const LS_TOTAL_LINE = /^total\s+\d+/i;
const BUILD_PROGRESS_LINE =
  /make\[\d+\]:\s+(Entering|Leaving)\s+directory|^\s*(gcc|cc|c\+\+|g\+\+|linking|compiling|building|cmake|ninja|tsc|webpack|rollup|esbuild|vite)\b/i;
const BUILD_DONE_LINE = /\b(build|compile|link|make)\b.*\b(succeed(?:ed)?|complete|done|finished|fail(?:ed)?)\b/i;
const BUILD_FAIL_WORD = /\bfail(?:ed)?\b/i;
const NONZERO_EXIT_LINE = /^\[exit:\s*([1-9]\d*)\]/;
const NOISE_LINE = /__pycache__|\.pyc$|\.egg-info|\.git\/(objects|refs|logs)/;
const ERROR_LINE =
  /error|fail|traceback|assert|exception|fatal|panic|cannot|denied|not found/i;

function isDirListingLine(line: string): boolean {
  return LS_LONG_LINE.test(line) || LS_TOTAL_LINE.test(line);
}

/**
 * Compress tool result using rule-based patterns (#21).
 * Keep errors, failures, diffs. Summarize noise:
 *   - passed tests → `[N tests passed]`
 *   - build logs   → `[Build succeeded]` or `[Build failed: <errors>]`
 *   - dir listings → `[dir listing: N entries]`
 *   - consecutive duplicate lines → deduped
 * No LLM call. Pure pattern matching.
 */
export function compressResult(text: string): string {
  const lines = text.split("\n");

  // --- First pass: classify lines, collect summary signals ---
  const kept: string[] = [];
  let passedCount = 0;
  let buildFailed = false;
  const buildErrors: string[] = [];
  let buildProgressSeen = false;

  let dirRun = 0; // active consecutive listing-line count
  const dirPending: string[] = []; // buffered originals for a short run

  for (const line of lines) {
    // --- Strip noise: pycache, git internals ---
    if (NOISE_LINE.test(line)) continue;

    // --- Passed tests ---
    if (
      /^test_.*\s+\.\s+\[OK\]/i.test(line)
      || /\. PASSED/i.test(line)
      || /^test.*\.\.\.\s+ok$/i.test(line)
      || /^\[ *\d+%\] (passed|ok)/i.test(line)
    ) {
      passedCount++;
      continue;
    }

    // --- Build progress / completion lines ---
    // A progress line that also signals an error (e.g. "webpack compiled with 1 error")
    // must be collected as a build error, not swallowed as pure progress.
    if (BUILD_PROGRESS_LINE.test(line)) {
      buildProgressSeen = true;
      if (ERROR_LINE.test(line)) {
        buildFailed = true;
        buildErrors.push(line);
      }
      continue;
    }
    // A build-done line ("Build succeeded", "Build failed", "compile complete").
    // Mark failures; never carry the termination line into buildErrors (it would
    // duplicate the [Build failed] summary header).
    if (BUILD_DONE_LINE.test(line)) {
      buildProgressSeen = true;
      if (BUILD_FAIL_WORD.test(line)) buildFailed = true;
      continue;
    }

    // --- Directory listing runs (>= 3 consecutive lines) ---
    if (isDirListingLine(line)) {
      // `total N` header is part of the listing but not an entry — don't count it.
      if (!LS_TOTAL_LINE.test(line)) dirRun++;
      dirPending.push(line);
      continue;
    }
    if (dirRun >= 3) {
      kept.push(`[dir listing: ${dirRun} entries]`);
    } else if (dirRun > 0) {
      // Too few to be a listing — preserve the originals verbatim.
      kept.push(...dirPending);
    }
    dirRun = 0;
    dirPending.length = 0;

    // --- Errors during a build are collected for the build summary ---
    if (buildProgressSeen && ERROR_LINE.test(line)) {
      buildFailed = true;
      buildErrors.push(line);
      continue;
    }

    // --- KEEP: errors, failures, tracebacks ---
    if (ERROR_LINE.test(line)) {
      kept.push(line);
      continue;
    }

    // --- KEEP: file change indicators (git status / diff) ---
    if (/^\s*[+~\-MADRC?!]{1,2}\s/.test(line)) {
      kept.push(line);
      continue;
    }
    if (/^@@|^\+{3}|^---/.test(line)) {
      kept.push(line);
      continue;
    }

    // --- Non-zero exit marks the (build) run as failed even without an
    //     error-looking line. Keep the marker; don't double-summarize. ---
    const exitMatch = line.match(NONZERO_EXIT_LINE);
    if (exitMatch) {
      if (buildProgressSeen) buildFailed = true;
      kept.push(line);
      continue;
    }
    if (/^\[exit:/.test(line)) {
      kept.push(line);
      continue;
    }

    // --- KEEP: everything else ---
    kept.push(line);
  }

  // Flush a trailing directory run.
  if (dirRun >= 3) {
    kept.push(`[dir listing: ${dirRun} entries]`);
  } else if (dirRun > 0) {
    kept.push(...dirPending);
  }

  // --- Second pass: dedup consecutive identical kept lines ---
  const deduped: string[] = [];
  for (const line of kept) {
    if (deduped[deduped.length - 1] === line) continue; // consecutive dup
    deduped.push(line);
  }

  let result = deduped.join("\n");

  // --- Build summary (prepend) ---
  if (buildProgressSeen) {
    const summary = buildFailed
      ? `[Build failed]\n${buildErrors.join("\n")}`
      : "[Build succeeded]";
    result = `${summary}\n${result}`;
  }

  // --- Passed-test summary (prepend) ---
  if (passedCount > 0) {
    result = `[${passedCount} tests passed]\n` + result;
  }

  // If still too long, keep first/last + middle truncation.
  const MAX_CHARS = 500;
  if (result.length > MAX_CHARS * 3) {
    const head = result.slice(0, MAX_CHARS);
    const tail = result.slice(-MAX_CHARS);
    result = `${head}\n[...${result.length - MAX_CHARS * 2} chars compressed...]\n${tail}`;
  }

  return result;
}

/**
 * Compress reasoning text to a single line.
 * Keeps first sentence or key insight.
 */
function compressReasoning(text: string): string {
  const firstLine = text.split("\n")[0]?.trim();
  if (!firstLine) return "";

  // If it's already short, keep it.
  if (firstLine.length <= 120) return firstLine;

  // Truncate to first sentence boundary.
  const sentenceEnd = firstLine.search(/[.!?]\s/);
  if (sentenceEnd > 0 && sentenceEnd < 150) {
    return firstLine.slice(0, sentenceEnd + 1);
  }

  return firstLine.slice(0, 117) + "...";
}
