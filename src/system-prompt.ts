import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Message } from "./compact.js";

export const SYSTEM_PROMPT_PATH = join(
  homedir(),
  ".inlineagent",
  "system.md",
);

export async function loadSystemPrompt(
  path: string = SYSTEM_PROMPT_PATH,
): Promise<string | undefined> {
  try {
    const prompt = await readFile(path, "utf8");
    return prompt.length > 0 ? prompt : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function prependSystemPrompt(
  messages: Message[],
  prompt: string | undefined,
): Message[] {
  if (prompt === undefined) return messages;
  return [{ role: "system", content: prompt }, ...messages];
}
