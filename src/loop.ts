/**
 * The agent loop. As thin as it gets.
 *
 * System prompt: 0 lines.
 * Tool: shell (one).
 * Sanitization: invisible.
 * Compaction: invisible.
 */
import type OpenAI from "openai";
import { runShell, summarizeOutput } from "./shell.js";
import { needsCompaction, compact, type Message } from "./compact.js";
import { skillsAnnouncement } from "./skills.js";

const SHELL_TOOL = {
  type: "function" as const,
  function: {
    name: "shell",
    description: "Execute a shell command. Returns stdout, stderr, and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        max_length: {
          type: "integer",
          description: "Override output truncation. 0 = no limit. Default: 500 chars.",
        },
      },
      required: ["command"],
    },
  },
};

interface RunOptions {
  client: OpenAI;
  model: string;
  contextWindow: number;
  messages: Message[];
  skillsInjected?: boolean;
}

export async function run(
  opts: RunOptions,
  userInput: string
): Promise<string> {
  const { client, model, contextWindow, messages } = opts;

  // First message: inject skills list into the user input (not system prompt).
  let effectiveInput = userInput;
  if (!opts.skillsInjected) {
    const skills = skillsAnnouncement();
    if (skills) {
      effectiveInput = `${userInput}\n\n${skills}`;
    }
    opts.skillsInjected = true;
  }

  messages.push({ role: "user", content: effectiveInput });

  // Check compaction before adding more context.
  if (needsCompaction(messages, contextWindow)) {
    process.stderr.write("[compacting...]\n");
    const compacted = await compact(client, model, messages);
    messages.length = 0;
    messages.push(...compacted);
  }

  const MAX_ITERATIONS = 50;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const response = await client.chat.completions.create({
      model,
      messages: messages as any,
      tools: [SHELL_TOOL],
    });

    const msg = response.choices[0].message;

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

    // No tool calls → agent is done.
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Check for "Y" summary request (from previous truncated output).
      const content = (msg.content ?? "").trim().toUpperCase();
      if (content === "Y" && i > 0) {
        const lastToolResult = findLastRawOutput(messages);
        if (lastToolResult) {
          process.stderr.write("[summarizing...]\n");
          const summary = await summarizeOutput(client, model, lastToolResult);
          messages.push({
            role: "tool",
            tool_call_id: "summary",
            content: `[summary]\n${summary}`,
          });
          continue; // let the LLM process the summary
        }
      }
      return msg.content ?? "";
    }

    // Execute tool calls.
    for (const tc of msg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const command: string = args.command;
      const maxLength: number | undefined = args.max_length;

      process.stderr.write(`  $ ${command}\n`);

      const result = await runShell(command, { maxLength });
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.output,
      });
    }

    // Check compaction mid-loop too.
    if (needsCompaction(messages, contextWindow)) {
      process.stderr.write("[compacting...]\n");
      const compacted = await compact(client, model, messages);
      messages.length = 0;
      messages.push(...compacted);
    }
  }

  return "[max iterations reached]";
}

/** Find the last tool result that was truncated, to summarize it. */
function findLastRawOutput(messages: Message[]): string | null {
  // Walk backward to find the last truncated tool result.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "tool" && m.content.includes("[truncated.")) {
      // The raw output was the full output before truncation.
      // We stored the truncated version — we need to re-run the command
      // or store the raw output separately.
      // For now, return the truncated content as context.
      return m.content;
    }
  }
  return null;
}
