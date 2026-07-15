import test from "node:test";
import assert from "node:assert/strict";

import { runShell } from "../src/shell.js";

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

test("reports tokens eliminated when long shell output is truncated", async () => {
  const result = await runShell(
    "node -e \"process.stdout.write('x'.repeat(2000))\"",
    { maxLength: 100 }
  );

  assert.equal(result.truncated, true);
  assert.ok(result.eliminatedTokens > 0);
});
