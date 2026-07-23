import type { Message } from "./compact.js";
import { insertRuntimeToolPolicy } from "./runtime-tool-policy.js";
import { prependSystemPrompt } from "./system-prompt.js";
import { estimateMessageTokens, estimateRawTokens } from "./tokenize.js";
import { projectTrajectory } from "./trajectory.js";

export interface ContextProjectionOptions {
  messages: Message[];
  systemPrompt: string | undefined;
  tools: unknown[];
  configuredRawActions: number;
  maxToolCallsPerResponse: number;
  maxInputTokens: number;
}

export interface ContextProjection {
  apiMessages: Message[];
  configuredRawActions: number;
  effectiveRawActions: number;
  estimatedTokens: number;
  compressionTokens: number;
}

export class ContextOverflowError extends Error {
  constructor(
    readonly estimatedTokens: number,
    readonly maxInputTokens: number,
  ) {
    super(
      `Context requires approximately ${estimatedTokens.toLocaleString()} input tokens, but only ${maxInputTokens.toLocaleString()} are available even with zero raw tool actions.`,
    );
    this.name = "ContextOverflowError";
  }
}

export function buildContextProjection(
  options: ContextProjectionOptions,
): ContextProjection {
  const {
    messages,
    systemPrompt,
    tools,
    configuredRawActions,
    maxToolCallsPerResponse,
    maxInputTokens,
  } = options;
  const fullMessages = prependSystemPrompt(
    insertRuntimeToolPolicy(messages, maxToolCallsPerResponse),
    systemPrompt,
  );
  const fullTokens = estimateRequestTokens(fullMessages, tools);
  let smallestEstimate = fullTokens;

  for (let keep = configuredRawActions; keep >= 0; keep--) {
    const projected = projectTrajectory(messages, keep);
    const apiMessages = prependSystemPrompt(
      insertRuntimeToolPolicy(projected, maxToolCallsPerResponse),
      systemPrompt,
    );
    const estimatedTokens = estimateRequestTokens(apiMessages, tools);
    smallestEstimate = estimatedTokens;
    if (estimatedTokens <= maxInputTokens) {
      return {
        apiMessages,
        configuredRawActions,
        effectiveRawActions: keep,
        estimatedTokens,
        compressionTokens: Math.max(0, fullTokens - estimatedTokens),
      };
    }
  }

  throw new ContextOverflowError(smallestEstimate, maxInputTokens);
}

export function estimateRequestTokens(
  messages: Message[],
  tools: unknown[],
): number {
  return messages.reduce(
    (total, message) => total + estimateMessageTokens(message),
    estimateRawTokens(JSON.stringify(tools)),
  );
}
