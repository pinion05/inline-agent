#!/usr/bin/env node
/**
 * Inline Agent — entry point.
 *
 * TTY: Pi-style retained-mode interface with provider settings.
 * Non-TTY: line-oriented compatibility mode.
 */
import * as readline from "node:readline";

import type { AgentEvent } from "./agent-events.js";
import {
  DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE,
  DEFAULT_OPEN_BROWSER,
  DEFAULT_RECENT_RAW_TOOL_ACTIONS,
  DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT,
  environmentConfigSeed,
  loadConfig,
  type AgentConfig,
} from "./config.js";
import type { Message } from "./compact.js";
import { run, type RunOptions } from "./loop.js";
import {
  createProviderClient,
  guessContextWindow,
  providerDefinition,
} from "./provider.js";
import { recordHttpRequest, startServer } from "./server.js";
import { InlineAgentApp } from "./tui/app.js";
import {
  formatAgentReply,
  formatToolLine,
  formatUserPrompt,
  resetStyle,
  supportsColor,
} from "./tui.js";

async function main(): Promise<void> {
  const loaded = await loadConfig();
  const seed = environmentConfigSeed();
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const openBrowser = (loaded.status === "valid" ? loaded.config.openBrowser : seed.openBrowser) ?? true;
  startServer({ silent: interactive, open: openBrowser });

  if (interactive) {
    const app = new InlineAgentApp({
      initialConfig: loaded.status === "valid" ? loaded.config : undefined,
      configSeed: seed,
      configError: loaded.status === "invalid" ? loaded.error : undefined,
      onExit: () => {
        process.stdout.write("\n");
        process.exit(0);
      },
    });
    process.once("SIGTERM", () => app.stop());
    process.once("SIGHUP", () => app.stop());
    app.start();
    return;
  }

  const config = configForLineMode(loaded, seed);
  if (!config) {
    process.stderr.write(
      "설정이 없습니다. TTY에서 inline-agent를 실행해 설정하거나 "
      + "INLINE_* 환경변수를 지정하세요.\n",
    );
    process.exitCode = 1;
    return;
  }
  await startLineMode(config);
  process.exit(0);
}

function configForLineMode(
  loaded: Awaited<ReturnType<typeof loadConfig>>,
  seed: Partial<AgentConfig>,
): AgentConfig | undefined {
  if (seed.provider && seed.apiKey && seed.model && seed.reasoningEffort) {
    return {
      version: 1,
      provider: seed.provider,
      apiKey: seed.apiKey,
      ...(seed.provider === "custom" && seed.baseURL
        ? { baseURL: seed.baseURL }
        : {}),
      model: seed.model,
      reasoningEffort: seed.reasoningEffort,
      recentRawToolActions: seed.recentRawToolActions
        ?? DEFAULT_RECENT_RAW_TOOL_ACTIONS,
      toolOutputSafetyLimit: seed.toolOutputSafetyLimit
        ?? DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT,
      maxToolCallsPerResponse: seed.maxToolCallsPerResponse
        ?? DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE,
      openBrowser: seed.openBrowser ?? DEFAULT_OPEN_BROWSER,
    };
  }
  return loaded.status === "valid" ? loaded.config : undefined;
}

async function startLineMode(config: AgentConfig): Promise<void> {
  const client = createProviderClient(config, undefined, recordHttpRequest);
  const contextWindow = guessContextWindow(config.model);
  const messages: Message[] = [];
  const promptColors = supportsColor(process.stderr);
  const replyColors = supportsColor(process.stdout);
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: formatUserPrompt(promptColors),
  });

  const provider = providerDefinition(config.provider).label;
  process.stderr.write(
    `inline-agent | ${provider} ${config.model} | reasoning=${config.reasoningEffort} | ctx=${contextWindow.toLocaleString()}\n\n`,
  );
  rl.prompt();

  const options: RunOptions = {
    client,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    recentRawToolActions: config.recentRawToolActions,
    toolOutputSafetyLimit: config.toolOutputSafetyLimit,
    maxToolCallsPerResponse: config.maxToolCallsPerResponse,
    contextWindow,
    messages,
    skillsInjected: false,
    onEvent: lineEventAdapter,
  };

  for await (const input of rl) {
    process.stderr.write(resetStyle(promptColors));
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }
    if (trimmed === "/exit" || trimmed === "/quit") break;
    try {
      const reply = await run(options, trimmed);
      process.stdout.write(`${formatAgentReply(reply, replyColors)}\n\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[error] ${redact(message, config.apiKey)}\n\n`);
    }
    rl.prompt();
  }

  rl.close();
  process.stderr.write(`${resetStyle(promptColors)}\n`);
}

function lineEventAdapter(event: AgentEvent): void {
  if (event.type === "tool-start") {
    process.stderr.write(
      `${formatToolLine(event.command, supportsColor(process.stderr))}\n`,
    );
  } else if (event.type === "compression") {
    process.stderr.write(
      `[trajectory compressed: ${event.before} → ${event.after} messages, -${event.eliminatedTokens} tokens]\n`,
    );
  }
}

function redact(message: string, secret: string): string {
  return secret ? message.replaceAll(secret, "[redacted]") : message;
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[fatal] ${message}\n`);
  process.exit(1);
});
