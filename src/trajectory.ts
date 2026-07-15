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
import type { Message } from "./compact.js";

const KEEP_ACTIONS = 3; // keep last N action groups (assistant+tool)

/**
 * Compress old trajectory entries, keeping only recent turns intact.
 * Old assistant+tool pairs become single text messages.
 */
export function compressTrajectory(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  // Find the cut index: keep last KEEP_ACTIONS action groups.
  const cutIndex = findCutIndex(messages, KEEP_ACTIONS);
  if (cutIndex <= 0) return messages;

  const old = messages.slice(0, cutIndex);
  const recent = messages.slice(cutIndex);

  // Merge old assistant+tool pairs into compact text messages.
  const compressed = mergeOldMessages(old);

  return [...compressed, ...recent];
}

/**
 * Find where to cut: keep last N action groups (assistant+tool pairs).
 * Never cut between an assistant(tool_calls) and its tool(result).
 * User messages are always kept as-is.
 */
function findCutIndex(messages: Message[], keepActions: number): number {
  // Count action groups (assistant with tool_calls) from the end.
  let actionCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant" && messages[i].tool_calls?.length) {
      actionCount++;
      if (actionCount > keepActions) {
        // Found the cut point — this assistant and its tools should be compressed.
        // But don't split: include the full group (assistant + following tools).
        return i;
      }
    }
  }
  return -1;
}

/**
 * Never split between assistant(tool_calls) and tool(result).
 * If the cut lands inside a tool group, move forward to the end of it.
 */
function adjustToGroupBoundary(messages: Message[], index: number): number {
  const msg = messages[index];
  if (msg.role === "user" && !msg.tool_calls?.length) return index;
  if (msg.role === "assistant" && !msg.tool_calls?.length) return index;

  // If this is a tool result or assistant with tool_calls,
  // move forward to after the group.
  if (msg.role === "tool") {
    // Find the matching assistant(tool_calls) for this tool_call_id.
    const callId = msg.tool_call_id;
    for (let i = index; i >= 0; i--) {
      if (
        messages[i].role === "assistant" &&
        messages[i].tool_calls?.some((tc: any) => tc.id === callId)
      ) {
        return i; // Keep the assistant+tool group together in "recent"
      }
    }
  }

  return index;
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
