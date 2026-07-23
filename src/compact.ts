/**
 * Token estimation + compaction trigger.
 *
 * Per-message token counts come from the GPT BPE tokenizer (tokenize.ts)
 * since the API only reports aggregate usage. When a recent API usage is
 * available, we anchor on that and only estimate the messages added since.
 */

import { estimateMessageTokens, estimateTokens } from "./tokenize.js";

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

export interface UsageInfo {
  index: number;
  promptTokens: number;
  completionTokens: number;
}

const COMPACTION_BUFFER = 16_000;

// Re-exported so existing imports (`from "./compact.js"`) keep working.
export { estimateTokens };

/**
 * Check if we need trajectory compression.
 * Uses context window - output reservation - buffer.
 */
export function needsCompression(
  messages: Message[],
  contextWindow: number,
  lastUsage?: UsageInfo,
  maxOutput: number = 16_384,
): boolean {
  let tokens: number;

  if (lastUsage) {
    // Use actual API usage + estimate for messages after.
    tokens = lastUsage.promptTokens + lastUsage.completionTokens;
    for (let i = lastUsage.index + 1; i < messages.length; i++) {
      tokens += estimateMessageTokens(messages[i]);
    }
  } else {
    tokens = estimateTokens(messages);
  }

  const usable = Math.max(0, contextWindow - Math.max(COMPACTION_BUFFER, maxOutput));
  return tokens >= usable;
}
