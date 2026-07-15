/**
 * Shell execution + information sanitization layer.
 *
 * The LLM never sees raw output directly. Everything passes through:
 *   - ANSI/binary sanitization
 *   - Output truncation with temp file fallback
 *   - 300s timeout
 *
 * No "Y for summary" — temp file path is provided for LLM to
 * self-serve via tail/grep/head.
 */
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";

const execAsync = promisify(exec);

const DEFAULT_MAX_CHARS = 500;
const DEFAULT_TIMEOUT = 300_000; // 300s
const TMP_DIR = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"),
  "inline-agent",
  "tmp"
);

export interface ShellResult {
  output: string;
  truncated: boolean;
  exitCode: number;
}

/** Strip ANSI escape codes, control chars, normalize line endings. */
function sanitize(text: string): string {
  // ANSI escape sequences (CSI, OSC, etc.)
  text = text.replace(
    /[\u001B\u009B][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    ""
  );
  text = text.replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "");
  text = text.replace(/\u001B[@-_]/g, "");

  // Carriage returns
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Other control characters (except newline/tab)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  return text;
}

/** Save full output to temp file, return path. */
function saveToTempFile(text: string): string {
  try {
    mkdirSync(TMP_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `${ts}-${rand}.log`;
    const filepath = join(TMP_DIR, filename);
    writeFileSync(filepath, text, "utf-8");
    return filepath;
  } catch {
    return "";
  }
}

/** Cut to N non-whitespace chars from the tail (keep errors at end). */
function truncateTail(output: string, maxNonWs: number): { text: string; total: number } {
  const total = output.replace(/\s/g, "").length;
  if (total <= maxNonWs) return { text: output, total };

  // Walk backward from end until we've collected maxNonWs non-ws chars.
  let count = 0;
  let i = output.length;
  for (; i > 0 && count < maxNonWs; i--) {
    if (!/\s/.test(output[i - 1])) count++;
  }
  return { text: output.slice(i), total };
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
      shell: "/bin/sh",
      env: { ...process.env, PS1: "", PS2: "" },
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

  // Combine stdout + stderr
  let raw = stdout;
  if (stderr) raw += (raw ? "\n[stderr]\n" : "") + stderr;
  raw += `\n[exit: ${exitCode}]`;

  // Sanitize: ANSI, control chars, binary garbage
  raw = sanitize(raw) || "[no output]";

  // No truncation
  if (noLimit) {
    return { output: raw, truncated: false, exitCode };
  }

  const maxChars = options?.maxLength ?? DEFAULT_MAX_CHARS;
  const { text, total } = truncateTail(raw, maxChars);

  if (total <= maxChars) {
    return { output: raw, truncated: false, exitCode };
  }

  // Save full output to temp file for LLM self-service.
  const tmpPath = saveToTempFile(raw);

  const hint = tmpPath
    ? `\n[truncated. total: ${total} chars. Full output: ${tmpPath}\nUse tail, grep, or head to read specific parts.]`
    : `\n[truncated. total: ${total} chars.]`;

  return {
    output: `...${total - text.replace(/\s/g, "").length} chars truncated...\n${hint}\n\n${text}`,
    truncated: true,
    exitCode,
  };
}
