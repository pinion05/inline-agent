/**
 * Accurate token counting via the GPT BPE tokenizer.
 *
 * The OpenAI Chat Completions API returns aggregate usage (total prompt
 * tokens) but never per-message counts. The dashboard needs per-message
 * counts, and the compaction trigger needs a fast pre-request estimate,
 * so we tokenize locally with the same BPE tokenizer the models use.
 *
 * `gpt-tokenizer` ships the GPT-4o/cl100k encoding which is a good fit
 * for OpenAI-compatible providers (OpenAI, Z.AI glm, custom). It is not a
 * perfect match for non-OpenAI tokenizers but is far more accurate than
 * the chars/4 heuristic, especially for Korean and other multibyte text
 * where chars/4 undercounts by 2-3x.
 */
import { encode } from "gpt-tokenizer";
import type { Message } from "./compact.js";

const count = (text: string): number => {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    // Fall back to chars/4 if the tokenizer throws on unexpected input.
    return Math.ceil(text.length / 4);
  }
};

/** Tokens for a single message (content + tool_calls + structural overhead). */
export function estimateMessageTokens(msg: Message): number {
  let tokens = count(msg.content ?? "");
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      tokens += count(JSON.stringify(tc));
    }
  }
  // Every message carries ~4 tokens of role/framing overhead.
  return tokens + 4;
}

/** Total tokens across a message list. */
export function estimateTokens(messages: Message[]): number {
  let tokens = 0;
  for (const msg of messages) {
    tokens += estimateMessageTokens(msg);
  }
  return tokens;
}

/** Tokens for a raw string (used for tool definitions). */
export function estimateRawTokens(text: string): number {
  return count(text);
}
