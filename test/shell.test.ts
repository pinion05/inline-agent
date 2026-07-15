import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runShell } from "../src/shell.js";

async function temporaryLogDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inline-agent-log-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "log");
}

test("aborts a running shell command through AbortSignal", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runShell(
    "node -e \"setTimeout(() => {}, 10000)\"",
    { signal: controller.signal },
  );

  setTimeout(() => controller.abort(), 50);

  await assert.rejects(running, (error: Error) => error.name === "AbortError");
  assert.ok(Date.now() - startedAt < 2_000);
});

test("keeps output at or below the safety limit verbatim", async () => {
  const result = await runShell("printf exact-output", {
    safetyLimit: 4_096,
  });

  assert.equal(result.output, "exact-output\n[exit: 0]");
  assert.equal(result.truncated, false);
  assert.equal(result.eliminatedTokens, 0);
  assert.equal(result.fullOutputPath, undefined);
});

test("caps abnormal output, preserves its tail, and writes a secure full log", async (t) => {
  const logDir = await temporaryLogDirectory(t);
  const safetyLimit = 4_096;
  const result = await runShell(
    "node -e \"process.stdout.write('x'.repeat(10000))\"",
    { safetyLimit, logDir },
  );

  assert.equal(result.truncated, true);
  assert.ok(result.output.length <= safetyLimit);
  assert.match(result.output, /^\[truncated\./);
  assert.match(result.output, /Full output:/);
  assert.match(result.output, /x{100}\n\[exit: 0\]$/);
  assert.ok(result.eliminatedTokens > 0);
  assert.ok(result.fullOutputPath);
  assert.equal((await stat(logDir)).mode & 0o777, 0o700);
  assert.equal((await stat(result.fullOutputPath!)).mode & 0o777, 0o600);
  const full = await readFile(result.fullOutputPath!, "utf8");
  assert.equal(full, `${"x".repeat(10_000)}\n[exit: 0]`);
});
