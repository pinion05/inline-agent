/**
 * The agent loop. As thin as it gets.
 *
 * System prompt: optional, loaded from ~/.inlineagent/system.md.
 * Tool: shell (one).
 * Sanitization: invisible.
 * Trajectory compression: invisible.
 */
import type OpenAI from "openai";
import { runShell } from "./shell.js";
import type { Message, UsageInfo } from "./compact.js";
import {
  DEFAULT_RECENT_RAW_TOOL_ACTIONS,
  DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT,
  type ReasoningEffort,
} from "./config.js";
import { buildContextProjection } from "./context-projection.js";
import type { AgentEvent, AgentEventHandler } from "./agent-events.js";
import { compactCanonicalTrajectory } from "./trajectory.js";
import { skillsAnnouncement } from "./skills.js";
import { loadSystemPrompt } from "./system-prompt.js";
import {
  recordApiContext,
  recordCompression,
  recordSafetyTruncation,
  recordUsage,
  updateContext,
} from "./server.js";

const SHELL_TOOL = {
  type: "function" as const,
  function: {
    name: "shell",
    description:
      "Execute a shell command. Returns stdout and stderr. Abnormally large output is capped by the user safety limit and the full output path is provided for targeted follow-up reads.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
      },
      required: ["command"],
    },
  },
};

const MAX_ITERATIONS = 50;

export interface RunOptions {
  client: OpenAI;
  model: string;
  reasoningEffort: ReasoningEffort;
  recentRawToolActions: number;
  toolOutputSafetyLimit: number;
  contextWindow: number;
  messages: Message[];
  skillsInjected?: boolean;
  lastUsage?: UsageInfo;
  systemPromptLoader?: () => Promise<string | undefined>;
  signal?: AbortSignal;
  onEvent?: AgentEventHandler;
}

export async function run(opts: RunOptions, userInput: string): Promise<string> {
  emit(opts, { type: "run-start", input: userInput });
  try {
    return await executeRun(opts, userInput);
  } catch (error) {
    if (isInterrupted(error, opts.signal)) {
      updateContext(opts.messages, opts.contextWindow, "interrupted");
      emit(opts, { type: "interrupted" });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    updateContext(opts.messages, opts.contextWindow, `error: ${message}`);
    emit(opts, { type: "error", message });
    throw error;
  }
}

async function executeRun(opts: RunOptions, userInput: string): Promise<string> {
  const { client, model, reasoningEffort, contextWindow, messages } = opts;
  opts.signal?.throwIfAborted();

  // First message: inject skills list into user input (not system prompt).
  let effectiveInput = userInput;
  if (!opts.skillsInjected) {
    const skills = skillsAnnouncement();
    if (skills) {
      effectiveInput = `${userInput}\n\n${skills}`;
    }
    opts.skillsInjected = true;
  }

  messages.push({ role: "user", content: effectiveInput });
  updateContext(messages, contextWindow, "user input");

  compactCanonical(opts);

  const systemPromptLoader = opts.systemPromptLoader ?? loadSystemPrompt;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    opts.signal?.throwIfAborted();
    updateContext(messages, contextWindow, `LLM call #${i + 1}...`);
    const systemPrompt = await systemPromptLoader();
    opts.signal?.throwIfAborted();
    const configuredRawActions = opts.recentRawToolActions
      ?? DEFAULT_RECENT_RAW_TOOL_ACTIONS;
    const projection = buildContextProjection({
      messages,
      systemPrompt,
      tools: [SHELL_TOOL],
      configuredRawActions,
      maxInputTokens: Math.max(0, contextWindow - 16_384),
    });
    const request = {
      model,
      messages: projection.apiMessages as any,
      tools: [SHELL_TOOL],
      reasoning_effort: reasoningEffort as any,
    };
    recordApiContext(projection.apiMessages, request.tools, {
      model,
      reasoningEffort,
      configuredRawActions: projection.configuredRawActions,
      effectiveRawActions: projection.effectiveRawActions,
      projectionTokens: projection.compressionTokens,
    });

    const response = await client.chat.completions.create(request, {
      signal: opts.signal,
    });
    opts.signal?.throwIfAborted();

    const msg = response.choices[0].message;

    // Track actual API usage for accurate token counting.
    if (response.usage) {
      opts.lastUsage = {
        index: messages.length - 1,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
      };
      recordUsage(
        response.usage.prompt_tokens,
        response.usage.prompt_tokens_details?.cached_tokens ?? 0
      );
    }

    // Serialize assistant message.
    const entry: Message = {
      role: "assistant",
      content: msg.content ?? "",
    };
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      entry.tool_calls = msg.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }
    messages.push(entry);
    updateContext(messages, contextWindow, "assistant response");

    // No tool calls → agent is done.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const content = msg.content ?? "";
      updateContext(messages, contextWindow, "done");
      emit(opts, { type: "assistant-complete", content });
      return content;
    }

    // Execute tool calls.
    for (let toolIndex = 0; toolIndex < msg.tool_calls.length; toolIndex++) {
      opts.signal?.throwIfAborted();
      const tc = msg.tool_calls[toolIndex];
      const args = JSON.parse(tc.function.arguments);
      const command: string = args.command;

      emit(opts, {
        type: "tool-start",
        id: tc.id,
        name: tc.function.name,
        command,
      });
      updateContext(messages, contextWindow, `$ ${command}`);

      let result;
      try {
        result = await runShell(command, {
          safetyLimit: opts.toolOutputSafetyLimit
            ?? DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT,
          signal: opts.signal,
        });
      } catch (error) {
        if (isInterrupted(error, opts.signal)) {
          for (const pending of msg.tool_calls.slice(toolIndex)) {
            messages.push({
              role: "tool",
              tool_call_id: pending.id,
              content: "[interrupted by user]",
            });
          }
          updateContext(messages, contextWindow, "tool interrupted");
        }
        throw error;
      }
      recordSafetyTruncation(result.eliminatedTokens);
      emit(opts, {
        type: "tool-complete",
        id: tc.id,
        name: tc.function.name,
        command,
        output: result.output,
        exitCode: result.exitCode,
        truncated: result.truncated,
        eliminatedTokens: result.eliminatedTokens,
      });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.output,
      });
      updateContext(messages, contextWindow, "tool result");
    }

    compactCanonical(opts);
  }

  const content = "[max iterations reached]";
  updateContext(messages, contextWindow, "max iterations");
  emit(opts, { type: "assistant-complete", content });
  return content;
}

function compactCanonical(opts: RunOptions): void {
  const { messages, contextWindow } = opts;
  const before = messages.length;
  const compacted = compactCanonicalTrajectory(messages);
  if (compacted.compressedActions === 0) return;

  messages.length = 0;
  messages.push(...compacted.messages);
  opts.lastUsage = undefined;
  recordCompression(before, messages.length, compacted.eliminatedTokens);
  updateContext(messages, contextWindow, `recovery ring: ${before} → ${messages.length}`);
  emit(opts, {
    type: "compression",
    before,
    after: messages.length,
    eliminatedTokens: compacted.eliminatedTokens,
  });
}

function emit(opts: RunOptions, event: AgentEvent): void {
  opts.onEvent?.(event);
}

function isInterrupted(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate?.name === "AbortError" || candidate?.code === "ABORT_ERR";
}
