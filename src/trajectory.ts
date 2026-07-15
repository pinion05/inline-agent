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
 * Compress tool result using rule-based patterns.
 * Keep errors, failures, diffs. Remove noise.
 */
export function compressResult(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let passedCount = 0;
  let skipDirListing = false;

  for (const line of lines) {
    // --- Strip noise: passed tests ---
    if (/^test_.*\s+\.\s+\[OK\]/i.test(line) || /\. PASSED/i.test(line)) {
      passedCount++;
      continue;
    }
    if (/^test.*\.\.\.\s+ok$/i.test(line)) {
      passedCount++;
      continue;
    }
    if (/^\[ *\d+%\] (passed|ok)/i.test(line)) {
      passedCount++;
      continue;
    }

    // --- Strip noise: pycache, git internals ---
    if (/__pycache__|\.pyc$|\.egg-info|\.git\/(objects|refs|logs)/.test(line)) {
      skipDirListing = true;
      continue;
    }

    // --- Strip noise: build progress ---
    if (/make\[\d+\]: (Entering|Leaving) directory/.test(line)) {
      continue;
    }
    if (/^\s*(gcc|cc|c\+\+|linking|compiling|building)\s/i.test(line)) {
      continue;
    }

    // --- KEEP: errors, failures, tracebacks ---
    // Always keep lines with error/fail/traceback/assert/exception.
    if (
      /error|fail|traceback|assert|exception|fatal|panic|cannot|denied|not found/i.test(
        line
      )
    ) {
      out.push(line);
      continue;
    }

    // --- KEEP: file change indicators ---
    if (/^\s*[+~\-MADRC?!]{1,2}\s/.test(line)) {
      // git status format
      out.push(line);
      continue;
    }
    if (/^@@|^\+{3}|^---/.test(line)) {
      // diff headers
      out.push(line);
      continue;
    }

    // --- KEEP: exit code ---
    if (/^\[exit:/.test(line)) {
      out.push(line);
      continue;
    }

    // --- KEEP: everything else (within limits) ---
    out.push(line);
  }

  let result = out.join("\n");

  // Summarize passed tests in one line.
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
