import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

test("publishes inline-agent and inla as equivalent CLI commands", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("package.json", root), "utf8"),
  );

  assert.deepEqual(packageJson.bin, {
    "inline-agent": "dist/index.js",
    inla: "dist/index.js",
  });
});

test("CLI entry source keeps the executable shebang", async () => {
  const source = await readFile(new URL("src/index.ts", root), "utf8");
  assert.equal(source.startsWith("#!/usr/bin/env node\n"), true);
});
