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
import { chmodSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT } from "./config.js";

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT = 300_000; // 300s
const LOG_DIR = join(homedir(), ".inlineagent", "log");

export interface ShellResult {
  output: string;
  truncated: boolean;
  eliminatedTokens: number;
  exitCode: number;
  fullOutputPath?: string;
}

export interface RunShellOptions {
  safetyLimit?: number;
  timeout?: number;
  signal?: AbortSignal;
  logDir?: string;
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

/** Save full output to a secure log file under ~/.inlineagent/log/. */
function saveToLogFile(text: string, logDir: string): string {
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    chmodSync(logDir, 0o700);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `${ts}-${rand}.log`;
    const filepath = join(logDir, filename);
    writeFileSync(filepath, text, { encoding: "utf8", mode: 0o600 });
    chmodSync(filepath, 0o600);
    return filepath;
  } catch {
    return "";
  }
}

export async function runShell(
  command: string,
  options: RunShellOptions = {},
): Promise<ShellResult> {
  options.signal?.throwIfAborted();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const safetyLimit = options.safetyLimit ?? DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT;

  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    const { stdout: out, stderr: err } = await execAsync(command, {
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      shell: "/bin/sh",
      env: { ...process.env, PS1: "", PS2: "" },
      signal: options.signal,
    });
    stdout = out;
    stderr = err;
  } catch (e: any) {
    if (options.signal?.aborted || e?.name === "AbortError" || e?.code === "ABORT_ERR") {
      throw options.signal?.reason ?? e;
    }
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

  if (raw.length <= safetyLimit) {
    return { output: raw, truncated: false, eliminatedTokens: 0, exitCode };
  }

  const fullOutputPath = saveToLogFile(raw, options.logDir ?? LOG_DIR);
  const notice = fullOutputPath
    ? `[truncated. total: ${raw.length} chars. Full output: ${fullOutputPath}]\n`
    : `[truncated. total: ${raw.length} chars.]\n`;
  const tailBudget = Math.max(0, safetyLimit - notice.length);
  const tail = tailBudget > 0 ? raw.slice(-tailBudget) : "";
  const output = notice.slice(0, safetyLimit) + tail;

  return {
    output: output.slice(0, safetyLimit),
    truncated: true,
    eliminatedTokens: Math.max(
      0,
      Math.ceil(raw.length / 4) - Math.ceil(output.length / 4),
    ),
    exitCode,
    ...(fullOutputPath ? { fullOutputPath } : {}),
  };
}
