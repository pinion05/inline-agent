import test from "node:test";
import assert from "node:assert/strict";

import { compressResult } from "../src/trajectory.js";

test("compresses passed tests into a single summary line (#21)", () => {
  const input = [
    "test_foo.py . [OK] (1ms)",
    "test_bar.py . [OK] (2ms)",
    "test_baz.py . [OK] (3ms)",
  ].join("\n");

  const result = compressResult(input);

  assert.match(result, /^\[3 tests passed\]/);
  assert.equal(result.includes("test_foo.py"), false);
});

test("summarizes a successful build into one line (#21)", () => {
  const input = [
    "compiling src/index.ts",
    "linking dist/index.js",
    "building target all",
    "Build complete",
  ].join("\n");

  const result = compressResult(input);

  assert.match(result, /\[Build succeeded\]/);
  assert.equal(result.includes("compiling src/index.ts"), false);
  assert.equal(result.includes("linking dist/index.js"), false);
});

test("preserves only errors when a build fails (#21)", () => {
  const input = [
    "compiling src/index.ts",
    "src/index.ts(10): error TS2304: Cannot find name 'foo'",
    "linking dist/index.js",
    "Build failed",
  ].join("\n");

  const result = compressResult(input);

  assert.match(result, /\[Build failed\]/);
  assert.match(result, /error TS2304/);
  assert.equal(result.includes("compiling src/index.ts"), false);
  assert.equal(result.includes("linking dist/index.js"), false);
});

test("summarizes a directory listing into a compact count (#21)", () => {
  const input = [
    "drwxr-xr-x  src",
    "drwxr-xr-x  test",
    "-rw-r--r--  index.ts",
    "-rw-r--r--  server.ts",
    "-rw-r--r--  loop.ts",
    "-rw-r--r--  README.md",
  ].join("\n");

  const result = compressResult(input);

  assert.match(result, /\[dir listing: 6 entries\]/);
  assert.equal(result.includes("-rw-r--r--  index.ts"), false);
});

test("does not misclassify a bare word as a directory listing (#21)", () => {
  const result = compressResult("result-a");
  assert.equal(result, "result-a");
});

test("removes duplicate consecutive identical error lines (#21)", () => {
  const input = [
    "Error: ENOENT: no such file or directory, open '/tmp/missing'",
    "Error: ENOENT: no such file or directory, open '/tmp/missing'",
    "Error: ENOENT: no such file or directory, open '/tmp/missing'",
  ].join("\n");

  const result = compressResult(input);

  const occurrences = result.split("Error: ENOENT").length - 1;
  assert.equal(occurrences, 1);
});

test("keeps non-consecutive errors (dedup is consecutive-only) (#21)", () => {
  const input = [
    "Error: first failure",
    "some intervening output",
    "Error: second failure",
  ].join("\n");

  const result = compressResult(input);

  assert.match(result, /Error: first failure/);
  assert.match(result, /Error: second failure/);
});

test("treats a build-tool error line as a build failure, not progress (#56)", () => {
  const input = [
    "vite building production bundle",
    "webpack compiled with 1 error",
  ].join("\n");

  const result = compressResult(input);

  assert.match(result, /\[Build failed\]/);
  assert.match(result, /webpack compiled with 1 error/);
  assert.equal(result.includes("[Build succeeded]"), false);
});

test("marks build as failed on non-zero exit even without an error line (#56)", () => {
  const input = [
    "tsc compiling sources",
    "[exit: 2]",
  ].join("\n");

  const result = compressResult(input);

  assert.match(result, /\[Build failed\]/);
  assert.equal(result.includes("[Build succeeded]"), false);
});

test("does not duplicate the build-failed termination line (#56)", () => {
  const input = [
    "tsc compiling sources",
    "src/index.ts(10): error TS2304: Cannot find name 'foo'",
    "Build failed",
  ].join("\n");

  const result = compressResult(input);

  const occurrences = (result.match(/Build failed/g) ?? []).length;
  assert.equal(occurrences, 1);
  assert.match(result, /error TS2304/);
});

test("preserves a short (1-2 line) directory listing instead of dropping it (#56)", () => {
  const input = "-rw-r--r--  README.md";

  const result = compressResult(input);

  assert.equal(result, input);
});

test("counts only entries, not the `total N` header, in a dir listing (#56)", () => {
  const input = [
    "total 24",
    "-rw-r--r--  a.ts",
    "-rw-r--r--  b.ts",
    "-rw-r--r--  c.ts",
  ].join("\n");

  const result = compressResult(input);

  assert.match(result, /\[dir listing: 3 entries\]/);
  assert.equal(result.includes("-rw-r--r--  a.ts"), false);
});
