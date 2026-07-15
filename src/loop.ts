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
import { needsCompression, type Message, type UsageInfo } from "./compact.js";
import type { ReasoningEffort } from "./config.js";
import type { AgentEvent, AgentEventHandler } from "./agent-events.js";
import { compressTrajectory } from "./trajectory.js";
import { skillsAnnouncement } from "./skills.js";
import { loadSystemPrompt, prependSystemPrompt } from "./system-prompt.js";
import {
  estimateTokens,
  recordApiContext,
  recordCompression,
  recordEliminatedTokens,
  recordUsage,
  updateContext,
} from "./server.js";

const SHELL_TOOL = {
  type: "function" as const,
  function: {
    name: "shell",
    description:
      "Execute a shell command. Returns stdout and stderr. Output is truncated to the last 500 non-whitespace chars; if truncated, a temp file path is provided for full access via tail/grep/head.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        max_length: {
          type: "integer",
          description:
            "Override output truncation limit (non-ws chars). 0 = no truncation. Default: 500.",
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
  contextWindow: number;
  messages: Message[];
  skillsInjected?: boolean;
  lastUsage?: UsageInfo;
  systemPromptLoader?: () => Promise<string | undefined>;
  onEvent?: AgentEventHandler;
}

export async function run(opts: RunOptions, userInput: string): Promise<string> {
  emit(opts, { type: "run-start", input: userInput });
  try {
    return await executeRun(opts, userInput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateContext(opts.messages, opts.contextWindow, `error: ${message}`);
    emit(opts, { type: "error", message });
    throw error;
  }
}

async function executeRun(opts: RunOptions, userInput: string): Promise<string> {
  const { client, model, reasoningEffort, contextWindow, messages } = opts;

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

  // Apply trajectory compression before starting.
  maybeCompress(opts);

  const systemPromptLoader = opts.systemPromptLoader ?? loadSystemPrompt;
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    updateContext(messages, contextWindow, `LLM call #${i + 1}...`);
    const systemPrompt = await systemPromptLoader();
    const apiMessages = prependSystemPrompt(messages, systemPrompt);
    const request = {
      model,
      messages: apiMessages as any,
      tools: [SHELL_TOOL],
      reasoning_effort: reasoningEffort as any,
    };
    recordApiContext(apiMessages, request.tools, {
      model,
      reasoningEffort,
    });

    const response = await client.chat.completions.create(request);

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
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const command: string = args.command;
      const maxLength: number | undefined = args.max_length;

      emit(opts, {
        type: "tool-start",
        id: tc.id,
        name: tc.function.name,
        command,
      });
      updateContext(messages, contextWindow, `$ ${command}`);

      const result = await runShell(command, { maxLength });
      recordEliminatedTokens(result.eliminatedTokens);
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

    // Apply trajectory compression after each tool round.
    maybeCompress(opts);
  }

  const content = "[max iterations reached]";
  updateContext(messages, contextWindow, "max iterations");
  emit(opts, { type: "assistant-complete", content });
  return content;
}

function maybeCompress(opts: RunOptions): void {
  const { messages, contextWindow, lastUsage } = opts;
  if (needsCompression(messages, contextWindow, lastUsage)) {
    const before = messages.length;
    const beforeTokens = estimateTokens(messages);
    const compressed = compressTrajectory(messages);
    messages.length = 0;
    messages.push(...compressed);
    const eliminatedTokens = Math.max(
      0,
      beforeTokens - estimateTokens(messages)
    );
    opts.lastUsage = undefined;
    recordCompression(before, messages.length, eliminatedTokens);
    updateContext(messages, contextWindow, `compressed: ${before} → ${messages.length}`);
    emit(opts, {
      type: "compression",
      before,
      after: messages.length,
      eliminatedTokens,
    });
  }
}

function emit(opts: RunOptions, event: AgentEvent): void {
  opts.onEvent?.(event);
}
