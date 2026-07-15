/**
 * Token estimation + compaction trigger.
 *
 * Uses API usage when available, falls back to chars/4.
 */

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

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    if (m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += JSON.stringify(tc).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

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

function estimateMessageTokens(msg: Message): number {
  const text = JSON.stringify(msg);
  return Math.ceil(text.length / 4);
}
