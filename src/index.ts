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
import { run } from "./loop.js";
import type { Message } from "./compact.js";

async function main() {
  // --- Provider config ---
  // Priority: explicit override > ZAI_API_KEY > OPENAI_API_KEY
  const zaiKey = process.env.ZAI_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;

  let baseURL: string | undefined;
  let apiKey: string;
  let model: string;
  let contextWindow: number;

  if (process.env.INLINE_BASE_URL) {
    // Explicit override — any OpenAI-compatible provider
    baseURL = process.env.INLINE_BASE_URL;
    apiKey = process.env.INLINE_API_KEY ?? openaiKey ?? zaiKey ?? "";
    model = process.env.INLINE_MODEL ?? "gpt-5";
    contextWindow = guessContextWindow(model);
  } else if (zaiKey) {
    // Z.AI Coding Plan — default
    baseURL = "https://api.z.ai/api/coding/paas/v4";
    apiKey = zaiKey;
    model = process.env.INLINE_MODEL ?? "glm-5.2";
    contextWindow = 1_000_000;
  } else if (openaiKey) {
    // OpenAI
    apiKey = openaiKey;
    model = process.env.INLINE_MODEL ?? "gpt-5";
    contextWindow = guessContextWindow(model);
  } else {
    process.stderr.write(
      "Set ZAI_API_KEY or OPENAI_API_KEY.\n" +
        "  export ZAI_API_KEY=your-zai-coding-plan-key\n" +
        "  # or\n" +
        "  export OPENAI_API_KEY=sk-...\n"
    );
    process.exit(1);
  }

  const client = baseURL ? new OpenAI({ baseURL, apiKey }) : new OpenAI({ apiKey });

  const messages: Message[] = []; // no system prompt

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: ">>> ",
  });

  const provider = baseURL?.includes("z.ai") ? "Z.AI" : "OpenAI";
  process.stderr.write(
    `inline-agent | ${provider} ${model} | ctx=${contextWindow.toLocaleString()}\n\n`
  );
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

function guessContextWindow(model: string): number {
  const m = model.toLowerCase();
  if (m.includes("glm-5")) return 1_000_000;
  if (m.includes("gpt-5")) return 400_000;
  if (m.includes("opus")) return 500_000;
  if (m.includes("sonnet")) return 400_000;
  if (m.includes("gemini")) return 1_000_000;
  return 200_000;
}

main();
