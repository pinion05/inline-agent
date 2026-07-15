import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import type { Message } from "../src/compact.js";
import {
  SYSTEM_PROMPT_PATH,
  loadSystemPrompt,
  prependSystemPrompt,
} from "../src/system-prompt.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "inline-agent-system-prompt-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("uses only the home-scoped system prompt path", () => {
  assert.equal(
    SYSTEM_PROMPT_PATH,
    join(homedir(), ".inlineagent", "system.md"),
  );
});

test("loads a non-empty UTF-8 system prompt without changing its bytes", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = join(directory, "system.md");
  const exactPrompt = "규칙을 지켜라.  \n마지막 개행도 보존한다.\n";
  await writeFile(path, exactPrompt, "utf8");

  assert.equal(await loadSystemPrompt(path), exactPrompt);
});

test("returns no prompt for a missing or zero-byte file", async (t) => {
  const directory = await temporaryDirectory(t);
  const missingPath = join(directory, "missing.md");
  const emptyPath = join(directory, "empty.md");
  await writeFile(emptyPath, "", "utf8");

  assert.equal(await loadSystemPrompt(missingPath), undefined);
  assert.equal(await loadSystemPrompt(emptyPath), undefined);
});

test("does not hide read errors other than a missing file", async (t) => {
  const directory = await temporaryDirectory(t);
  const unreadablePath = join(directory, "system.md");
  await mkdir(unreadablePath);

  await assert.rejects(
    loadSystemPrompt(unreadablePath),
    (error: NodeJS.ErrnoException) => error.code !== "ENOENT",
  );
});

test("prepends a request-only system message without mutating the trajectory", () => {
  const messages: Message[] = [{ role: "user", content: "hello" }];

  const apiMessages = prependSystemPrompt(messages, "exact prompt\n");

  assert.deepEqual(apiMessages, [
    { role: "system", content: "exact prompt\n" },
    { role: "user", content: "hello" },
  ]);
  assert.deepEqual(messages, [{ role: "user", content: "hello" }]);
  assert.notEqual(apiMessages, messages);
});

test("does not add a system message when the prompt is absent", () => {
  const messages: Message[] = [{ role: "user", content: "hello" }];

  assert.deepEqual(prependSystemPrompt(messages, undefined), messages);
});
