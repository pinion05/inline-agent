import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  CONFIG_FILE,
  environmentConfigSeed,
  loadConfig,
  maskApiKey,
  saveConfig,
  type AgentConfig,
} from "../src/config.js";

const validConfig: AgentConfig = {
  version: 1,
  provider: "zai",
  apiKey: "secret-key-1234",
  model: "glm-5.2",
  reasoningEffort: "high",
};

async function tempConfigPath(t: test.TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "inline-agent-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return join(home, ".inlineagent", "config.json");
}

test("uses only ~/.inlineagent/config.json", () => {
  assert.equal(CONFIG_FILE, join(homedir(), ".inlineagent", "config.json"));
});

test("securely saves and loads a valid config", async (t) => {
  const path = await tempConfigPath(t);

  await saveConfig(validConfig, path);
  const result = await loadConfig(path);

  assert.deepEqual(result, { status: "valid", config: validConfig });
  assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
});

test("atomically replaces an existing config", async (t) => {
  const path = await tempConfigPath(t);
  await saveConfig(validConfig, path);
  const replacement: AgentConfig = {
    ...validConfig,
    provider: "openai",
    model: "gpt-5.1",
    apiKey: "replacement-key",
  };

  await saveConfig(replacement, path);

  assert.deepEqual(await loadConfig(path), {
    status: "valid",
    config: replacement,
  });
  assert.deepEqual(await readdir(dirname(path)), ["config.json"]);
});

test("reports missing and corrupt configs without rewriting them", async (t) => {
  const path = await tempConfigPath(t);
  assert.deepEqual(await loadConfig(path), { status: "missing" });

  await mkdir(dirname(path), { recursive: true });
  const corrupt = "{not-json\n";
  await writeFile(path, corrupt, "utf8");
  const result = await loadConfig(path);

  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.match(result.error, /JSON|Unexpected/);
  assert.equal(await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8")), corrupt);
});

test("rejects invalid schema and provider-specific reasoning", async (t) => {
  const path = await tempConfigPath(t);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({
    ...validConfig,
    provider: "openai",
    reasoningEffort: "max",
  }));

  const result = await loadConfig(path);

  assert.equal(result.status, "invalid");
  if (result.status === "invalid") assert.match(result.error, /reasoningEffort/);
});

test("does not look up the old hyphenated config path", async (t) => {
  const newPath = await tempConfigPath(t);
  const oldPath = join(dirname(dirname(newPath)), ".inline-agent", "config.json");
  await mkdir(dirname(oldPath), { recursive: true });
  await writeFile(oldPath, JSON.stringify(validConfig));

  assert.deepEqual(await loadConfig(newPath), { status: "missing" });
});

test("masks API keys without revealing short secrets", () => {
  assert.equal(maskApiKey("secret-key-1234"), "••••1234");
  assert.equal(maskApiKey("abc"), "••••");
  assert.equal(maskApiKey(""), "설정 안 됨");
});

test("builds first-run seeds from existing environment variables", () => {
  assert.deepEqual(environmentConfigSeed({ ZAI_API_KEY: "z-key" }), {
    provider: "zai",
    apiKey: "z-key",
    model: "glm-5.2",
    reasoningEffort: "high",
  });
  assert.deepEqual(environmentConfigSeed({ OPENAI_API_KEY: "o-key" }), {
    provider: "openai",
    apiKey: "o-key",
    model: "gpt-5",
    reasoningEffort: "high",
  });
  assert.deepEqual(environmentConfigSeed({
    INLINE_BASE_URL: "https://example.test/v1",
    INLINE_API_KEY: "c-key",
    INLINE_MODEL: "custom-model",
  }), {
    provider: "custom",
    apiKey: "c-key",
    baseURL: "https://example.test/v1",
    model: "custom-model",
    reasoningEffort: "high",
  });
});
