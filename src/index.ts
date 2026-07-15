#!/usr/bin/env node
/**
 * Inline Agent — entry point.
 *
 * Zero system prompt. One shell tool. Invisible context sanitization.
 * Rule-based trajectory compression.
 *
 * Defaults to Z.AI Coding Plan (glm-5.2).
 * Works with any OpenAI-compatible provider.
 */
import OpenAI from "openai";
import * as readline from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { run } from "./loop.js";
import type { Message } from "./compact.js";

const CONFIG_DIR = join(homedir(), ".inline-agent");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

interface Config {
  provider: "zai" | "openai" | "custom";
  apiKey: string;
  baseURL?: string;
  model?: string;
}

function loadConfig(): Config | null {
  try {
    if (!existsSync(CONFIG_FILE)) return null;
    return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveConfig(config: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/** Line queue: prevents losing lines when readline emits faster than we listen. */
function createLineReader(rl: readline.Interface) {
  const queue: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  rl.on("line", (line: string) => {
    if (waiters.length > 0) {
      waiters.shift()!(line);
    } else {
      queue.push(line);
    }
  });
  return function ask(q: string): Promise<string> {
    process.stderr.write(q);
    if (queue.length > 0) {
      return Promise.resolve(queue.shift()!.trim());
    }
    return new Promise((resolve) => waiters.push((l) => resolve(l.trim())));
  };
}

function guessContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("glm-5")) return 1_000_000;
  if (m.includes("gpt-5")) return 400_000;
  if (m.includes("opus")) return 500_000;
  if (m.includes("sonnet")) return 400_000;
  if (m.includes("gemini")) return 1_000_000;
  return 200_000;
}

function configToConnect(config: Config): {
  baseURL?: string;
  apiKey: string;
  model: string;
} {
  if (config.provider === "zai") {
    return {
      baseURL: "https://api.z.ai/api/coding/paas/v4",
      apiKey: config.apiKey,
      model: config.model ?? "glm-5.2",
    };
  }
  if (config.provider === "openai") {
    return { apiKey: config.apiKey, model: config.model ?? "gpt-5" };
  }
  return {
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model ?? "gpt-5",
  };
}

async function setupWizard(rl: readline.Interface): Promise<Config> {
  const ask = createLineReader(rl);
  process.stderr.write(
    "\n╔══════════════════════════════════════════╗\n" +
      "║        inline-agent 첫 실행 설정          ║\n" +
      "╚══════════════════════════════════════════╝\n\n"
  );
  process.stderr.write("제공자 선택:\n");
  process.stderr.write("  1. Z.AI Coding Plan (glm-5.2, 기본)\n");
  process.stderr.write("  2. OpenAI\n");
  process.stderr.write("  3. 커스텀 (OpenAI-compatible)\n");

  const choice = await ask("\n선택 [1]: ");

  let config: Config;
  if (choice === "2") {
    const key = await ask("OpenAI API Key: ");
    config = { provider: "openai", apiKey: key };
  } else if (choice === "3") {
    const key = await ask("API Key: ");
    const url = await ask("Base URL: ");
    const model = await ask("Model: ");
    config = { provider: "custom", apiKey: key, baseURL: url, model };
  } else {
    const key = await ask("Z.AI API Key: ");
    config = { provider: "zai", apiKey: key };
  }

  saveConfig(config);
  process.stderr.write(`\n설정 저장됨: ${CONFIG_FILE}\n\n`);
  return config;
}

async function main() {
  const zaiKey = process.env.ZAI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  // Resolve connection info
  let baseURL: string | undefined;
  let apiKey: string;
  let model: string;

  if (process.env.INLINE_BASE_URL) {
    baseURL = process.env.INLINE_BASE_URL;
    apiKey = process.env.INLINE_API_KEY ?? openaiKey ?? zaiKey ?? "";
    model = process.env.INLINE_MODEL ?? "gpt-5";
  } else if (zaiKey) {
    baseURL = "https://api.z.ai/api/coding/paas/v4";
    apiKey = zaiKey;
    model = process.env.INLINE_MODEL ?? "glm-5.2";
  } else if (openaiKey) {
    apiKey = openaiKey;
    model = process.env.INLINE_MODEL ?? "gpt-5";
  } else {
    // No env vars — check config file or run wizard
    const config = loadConfig();
    if (config) {
      const c = configToConnect(config);
      baseURL = c.baseURL;
      apiKey = c.apiKey;
      model = c.model;
    } else {
      // First run — interactive setup
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stderr,
      });
      const newConfig = await setupWizard(rl);
      const c = configToConnect(newConfig);
      baseURL = c.baseURL;
      apiKey = c.apiKey;
      model = c.model;
      // Don't close rl — reuse for agent loop
      startAgent(rl, baseURL, apiKey, model);
      return;
    }
  }

  if (!apiKey) {
    process.stderr.write("API Key가 없습니다. 설정 파일을 삭제하고 다시 시도:\n");
    process.stderr.write(`  rm ${CONFIG_FILE}\n`);
    process.exit(1);
  }

  startAgent(undefined, baseURL, apiKey, model);
}

function startAgent(
  reusedRl: readline.Interface | undefined,
  baseURL: string | undefined,
  apiKey: string,
  model: string
) {
  const contextWindow = guessContextWindow(model);
  const client = baseURL
    ? new OpenAI({ baseURL, apiKey })
    : new OpenAI({ apiKey });

  const messages: Message[] = [];
  const rl =
    reusedRl ??
    readline.createInterface({ input: process.stdin, output: process.stderr });

  const provider = baseURL?.includes("z.ai")
    ? "Z.AI"
    : baseURL
      ? "Custom"
      : "OpenAI";
  process.stderr.write(
    `inline-agent | ${provider} ${model} | ctx=${contextWindow.toLocaleString()}\n\n`
  );
  rl.setPrompt(">>> ");
  rl.prompt();

  const opts = {
    client,
    model,
    contextWindow,
    messages,
    skillsInjected: false,
  };

  rl.on("line", async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }
    if (["/exit", "/quit"].includes(trimmed)) {
      rl.close();
      return;
    }
    try {
      const reply = await run(opts, trimmed);
      process.stdout.write(reply + "\n\n");
    } catch (e: any) {
      process.stderr.write(`[error] ${e.message}\n\n`);
    }
    rl.prompt();
  });

  rl.on("close", () => {
    process.stderr.write("\n");
    process.exit(0);
  });
}

main();
