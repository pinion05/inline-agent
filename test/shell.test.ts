import test from "node:test";
import assert from "node:assert/strict";

import { runShell } from "../src/shell.js";

test("reports tokens eliminated when long shell output is truncated", async () => {
  const result = await runShell(
    "node -e \"process.stdout.write('x'.repeat(2000))\"",
    { maxLength: 100 }
  );

  assert.equal(result.truncated, true);
  assert.ok(result.eliminatedTokens > 0);
});
