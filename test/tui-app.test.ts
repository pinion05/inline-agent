import test from "node:test";
import assert from "node:assert/strict";

import type { Terminal } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../src/config.js";
import type { RunOptions } from "../src/loop.js";
import { InlineAgentApp } from "../src/tui/app.js";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  started = false;
  stopped = false;
  writes: string[] = [];
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const config: AgentConfig = {
  version: 1,
  provider: "zai",
  apiKey: "app-secret-key",
  model: "glm-5.2",
  reasoningEffort: "high",
};

const successfulRun = async (opts: RunOptions, input: string) => {
  opts.messages.push({ role: "user", content: input });
  opts.onEvent?.({ type: "run-start", input });
  const content = `answer: ${input}`;
  opts.messages.push({ role: "assistant", content });
  opts.onEvent?.({ type: "assistant-complete", content });
  return content;
};

test("shows invalid config errors in first-run settings", () => {
  const app = new InlineAgentApp({
    terminal: new FakeTerminal(),
    configError: "config JSON is broken",
    createClient: () => ({}) as any,
    runAgent: successfulRun,
  });

  app.start();

  assert.equal(app.settingsController?.state.error, "config JSON is broken");
  app.stop();
});

test("opens first-run settings and activates chat after secure save", async () => {
  const terminal = new FakeTerminal();
  const saved: AgentConfig[] = [];
  const app = new InlineAgentApp({
    terminal,
    configSeed: { provider: "zai", reasoningEffort: "high" },
    saveConfig: async (next) => { saved.push(next); },
    discoverModels: async () => ({ status: "success", models: ["glm-5.2"] }),
    createClient: () => ({}) as any,
    runAgent: successfulRun,
  });

  app.start();
  assert.equal(terminal.started, true);
  assert.equal(app.settingsController?.state.step, "provider");

  const settings = app.settingsController!;
  settings.selectProvider("zai");
  await settings.submitApiKey("first-key");
  settings.selectModel("glm-5.2");
  settings.selectReasoning("high");
  await settings.confirm();

  assert.equal(settings.state.step, "done");
  assert.deepEqual(saved, [{
    version: 1,
    provider: "zai",
    apiKey: "first-key",
    model: "glm-5.2",
    reasoningEffort: "high",
  }]);
  assert.equal(app.config?.apiKey, "first-key");
  assert.ok(app.chatView);
});

test("queues prompts in FIFO order while a run is active", async () => {
  const terminal = new FakeTerminal();
  const starts: string[] = [];
  const releases: Array<() => void> = [];
  const runAgent = async (opts: RunOptions, input: string) => {
    starts.push(input);
    opts.messages.push({ role: "user", content: input });
    opts.onEvent?.({ type: "run-start", input });
    await new Promise<void>((resolve) => releases.push(resolve));
    opts.messages.push({ role: "assistant", content: `done ${input}` });
    opts.onEvent?.({ type: "assistant-complete", content: `done ${input}` });
    return `done ${input}`;
  };
  const app = new InlineAgentApp({
    terminal,
    initialConfig: config,
    createClient: () => ({}) as any,
    runAgent,
  });
  app.start();

  const processing = app.submit("first");
  void app.submit("second");
  void app.submit("third");
  await tick();
  assert.deepEqual(starts, ["first"]);
  assert.equal(app.queueLength, 2);

  releases.shift()!();
  await tick();
  assert.deepEqual(starts, ["first", "second"]);
  releases.shift()!();
  await tick();
  assert.deepEqual(starts, ["first", "second", "third"]);
  releases.shift()!();
  await processing;

  assert.deepEqual(app.messages.filter((message) => message.role === "user").map((message) => message.content), [
    "first", "second", "third",
  ]);
  assert.equal(app.queueLength, 0);
});

test("handles settings, clear, and exit commands without sending them", async () => {
  const terminal = new FakeTerminal();
  const inputs: string[] = [];
  const app = new InlineAgentApp({
    terminal,
    initialConfig: config,
    createClient: () => ({}) as any,
    runAgent: async (opts, input) => {
      inputs.push(input);
      return successfulRun(opts, input);
    },
  });
  app.start();
  await app.submit("hello");
  assert.equal(app.messages.length, 2);

  await app.submit("/settings");
  assert.ok(app.settingsController);
  assert.equal(inputs.includes("/settings"), false);

  app.closeSettings();
  await app.submit("/clear");
  assert.deepEqual(app.messages, []);
  assert.equal(inputs.includes("/clear"), false);

  await app.submit("/exit");
  assert.equal(terminal.stopped, true);
});

test("applies new runtime settings without clearing messages", async () => {
  const terminal = new FakeTerminal();
  const saved: AgentConfig[] = [];
  const app = new InlineAgentApp({
    terminal,
    initialConfig: config,
    saveConfig: async (next) => { saved.push(next); },
    createClient: () => ({}) as any,
    runAgent: successfulRun,
  });
  app.start();
  await app.submit("keep me");
  const before = structuredClone(app.messages);
  const replacement: AgentConfig = {
    ...config,
    provider: "openai",
    model: "gpt-5.1",
    reasoningEffort: "xhigh",
  };

  await app.applyConfig(replacement);

  assert.deepEqual(app.messages, before);
  assert.deepEqual(saved, [replacement]);
  assert.equal(app.config?.model, "gpt-5.1");
  assert.match(stripAnsi(app.chatView!.render(80).join("\n")), /gpt-5\.1/);
});

test("redacts the API key from engine errors and restores the terminal", async () => {
  const terminal = new FakeTerminal();
  const app = new InlineAgentApp({
    terminal,
    initialConfig: config,
    createClient: () => ({}) as any,
    runAgent: async (opts) => {
      const message = `request failed for ${config.apiKey}`;
      opts.onEvent?.({ type: "error", message });
      throw new Error(message);
    },
  });
  app.start();

  await app.submit("fail");

  const output = app.chatView!.render(80).join("\n");
  assert.equal(output.includes(config.apiKey), false);
  assert.match(stripAnsi(output), /\[redacted\]/);
  app.stop();
  assert.equal(terminal.stopped, true);
});

async function tick(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
