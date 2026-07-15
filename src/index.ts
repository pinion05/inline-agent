#!/usr/bin/env node
/**
 * Inline Agent — entry point.
 *
 * One tool. Zero system prompt. Maximum context.
 */
import OpenAI from "openai";
import * as readline from "node:readline";
import { run } from "./loop.js";
import type { Message } from "./compact.js";

async function main() {
  const model = process.env.INLINE_MODEL ?? "gpt-5";
  const baseURL = process.env.INLINE_BASE_URL;
  const apiKey = process.env.OPENAI_API_KEY ?? "";

  // Guess context window from model name.
  const contextWindow = guessContextWindow(model);

  const client = baseURL
    ? new OpenAI({ baseURL, apiKey })
    : new OpenAI({ apiKey });

  if (!apiKey) {
    process.stderr.write("Set OPENAI_API_KEY (or your provider's key).\n");
    process.exit(1);
  }

  const messages: Message[] = []; // no system prompt

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: ">>> ",
  });

  process.stderr.write(`inline-agent | model=${model} | ctx=${contextWindow}\n\n`);
  rl.prompt();

  const opts = { client, model, contextWindow, messages, skillsInjected: false };

  rl.on("line", async (input: string) => {
    const trimmed = input.trim();
    if (!trimmed) { rl.prompt(); return; }
    if (["/exit", "/quit"].includes(trimmed)) { rl.close(); return; }

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
  return 128_000;
}

main();
