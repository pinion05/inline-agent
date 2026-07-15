/**
 * Shell execution + information sanitization layer.
 *
 * The LLM never sees raw output. Everything passes through here:
 *   - 500 non-ws char cut (default)
 *   - "Y for summary?" prompt on truncation
 *   - max_length override
 *   - 300s timeout
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

const DEFAULT_MAX_CHARS = 500;
const DEFAULT_TIMEOUT = 300_000; // 300s

export interface ShellResult {
  output: string;
  truncated: boolean;
  totalNonWsChars: number;
}

/** Count non-whitespace characters. */
function countNonWs(s: string): number {
  return s.replace(/\s/g, "").length;
}

/** Cut to N non-whitespace chars from the front. */
function truncate(output: string, maxNonWs: number): { text: string; total: number } {
  const total = countNonWs(output);
  if (total <= maxNonWs) return { text: output, total };

  // Walk forward until we've collected maxNonWs non-ws chars.
  let count = 0;
  let i = 0;
  for (; i < output.length && count < maxNonWs; i++) {
    if (!/\s/.test(output[i])) count++;
  }
  return { text: output.slice(0, i), total };
}

export async function runShell(
  command: string,
  options?: { maxLength?: number; timeout?: number }
): Promise<ShellResult> {
  const timeout = options?.timeout ?? DEFAULT_TIMEOUT;
  const noLimit = options?.maxLength === 0;

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const { stdout: out, stderr: err } = await execAsync(command, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      shell: process.env.SHELL ?? "/bin/bash",
    });
    stdout = out;
    stderr = err;
  } catch (e: any) {
    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    exitCode = e.code ?? 1;
    if (e.killed || e.signal === "SIGTERM") {
      stderr += "\n[timeout: command exceeded limit]";
    }
  }

  let raw = stdout;
  if (stderr) raw += (raw ? "\n[stderr]\n" : "") + stderr;
  raw += `\n[exit: ${exitCode}]`;

  if (noLimit) {
    return { output: raw || "[no output]", truncated: false, totalNonWsChars: countNonWs(raw) };
  }

  const maxChars = options?.maxLength ?? DEFAULT_MAX_CHARS;
  const { text, total } = truncate(raw, maxChars);

  if (total <= maxChars) {
    return { output: raw || "[no output]", truncated: false, totalNonWsChars: total };
  }

  const truncated =
    text +
    `\n[truncated. total: ${total} chars. Send Y for summary.]`;

  return { output: truncated, truncated: true, totalNonWsChars: total };
}

/**
 * Summarize a large shell output using the sanitization LLM.
 * Plain text call — no tools, no system prompt.
 */
export async function summarizeOutput(
  client: any,
  model: string,
  rawOutput: string
): Promise<string> {
  const resp = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "user",
        content: `Compress this command output, preserving key information:\n\n${rawOutput}`,
      },
    ],
  });
  return resp.choices[0].message.content ?? "[summary failed]";
}
