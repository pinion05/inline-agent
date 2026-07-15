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
import { compressTrajectory } from "./trajectory.js";
import { skillsAnnouncement } from "./skills.js";
import { formatToolLine, supportsColor } from "./tui.js";
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

interface RunOptions {
  client: OpenAI;
  model: string;
  contextWindow: number;
  messages: Message[];
  skillsInjected?: boolean;
  lastUsage?: UsageInfo;
  systemPromptLoader?: () => Promise<string | undefined>;
}

export async function run(opts: RunOptions, userInput: string): Promise<string> {
  const { client, model, contextWindow, messages } = opts;

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
    };
    recordApiContext(apiMessages, request.tools);

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
      updateContext(messages, contextWindow, "done");
      return msg.content ?? "";
    }

    // Execute tool calls.
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const command: string = args.command;
      const maxLength: number | undefined = args.max_length;

      process.stderr.write(
        formatToolLine(command, supportsColor(process.stderr)) + "\n"
      );
      updateContext(messages, contextWindow, `$ ${command}`);

      const result = await runShell(command, { maxLength });
      recordEliminatedTokens(result.eliminatedTokens);
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

  updateContext(messages, contextWindow, "max iterations");
  return "[max iterations reached]";
}

function maybeCompress(opts: RunOptions): void {
  const { messages, contextWindow, lastUsage } = opts;
  if (needsCompression(messages, contextWindow, lastUsage)) {
    process.stderr.write("[compressing trajectory...]\n");
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
    process.stderr.write(
      `[trajectory compressed: ${before} → ${messages.length} messages]\n`
    );
  }
}
