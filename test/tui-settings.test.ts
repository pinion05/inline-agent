import test from "node:test";
import assert from "node:assert/strict";

import { TUI, type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentConfig } from "../src/config.js";
import type { ModelDiscoveryResult } from "../src/provider.js";
import {
  SettingsController,
  SettingsView,
} from "../src/tui/settings.js";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  start(): void {}
  stop(): void {}
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

const existing: AgentConfig = {
  version: 1,
  provider: "zai",
  apiKey: "secret-key-1234",
  model: "glm-5.2",
  reasoningEffort: "high",
  recentRawToolActions: 3,
  toolOutputSafetyLimit: 65_536,
  maxToolCallsPerResponse: 1,
  openBrowser: true,
};

function controllerWith(
  result: ModelDiscoveryResult,
  options: { initialConfig?: AgentConfig; completed?: AgentConfig[] } = {},
) {
  return new SettingsController({
    initialConfig: options.initialConfig,
    seed: options.initialConfig,
    discoverModels: async () => result,
    onComplete: async (config) => { options.completed?.push(config); },
  });
}

test("completes provider, auth, model, reasoning, and confirmation steps", async () => {
  const completed: AgentConfig[] = [];
  const controller = controllerWith(
    { status: "success", models: ["glm-5", "glm-5.2"] },
    { completed },
  );

  assert.equal(controller.state.step, "provider");
  controller.selectProvider("zai");
  assert.equal(controller.state.step, "api-key");
  await controller.submitApiKey("new-key");
  assert.equal(controller.state.step, "model");
  assert.deepEqual(controller.state.models, ["glm-5", "glm-5.2"]);
  controller.selectModel("glm-5.2");
  assert.equal(controller.state.step, "reasoning");
  assert.deepEqual(controller.availableReasoningEfforts(), [
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);
  controller.selectReasoning("max");
  assert.equal(controller.state.step, "raw-actions");
  controller.selectRecentRawToolActions(5);
  assert.equal(controller.state.step, "safety-limit");
  controller.selectToolOutputSafetyLimit(262_144);
  assert.equal(controller.state.step, "max-tool-calls");
  controller.selectMaxToolCallsPerResponse(1);
  assert.equal(controller.state.step, "confirm");
  await controller.confirm();

  assert.deepEqual(completed, [{
    version: 1,
    provider: "zai",
    apiKey: "new-key",
    model: "glm-5.2",
    reasoningEffort: "max",
    recentRawToolActions: 5,
    toolOutputSafetyLimit: 262_144,
    maxToolCallsPerResponse: 1,
    openBrowser: true,
  }]);
  assert.equal(controller.state.step, "done");
});

test("opens a direct settings menu for an existing chat config", async () => {
  const completed: AgentConfig[] = [];
  const controller = controllerWith(
    { status: "success", models: ["glm-5.2"] },
    { initialConfig: existing, completed },
  );

  assert.equal(controller.state.step, "menu");

  controller.editReasoning();
  assert.equal(controller.state.step, "reasoning");
  controller.selectReasoning("max");
  assert.equal(controller.state.step, "menu");

  controller.editRecentRawToolActions();
  assert.equal(controller.state.step, "raw-actions");
  controller.selectRecentRawToolActions(5);
  assert.equal(controller.state.step, "menu");

  controller.editToolOutputSafetyLimit();
  assert.equal(controller.state.step, "safety-limit");
  controller.selectToolOutputSafetyLimit(262_144);
  assert.equal(controller.state.step, "menu");

  controller.editMaxToolCallsPerResponse();
  assert.equal(controller.state.step, "max-tool-calls");
  controller.selectMaxToolCallsPerResponse(9);
  assert.equal(controller.state.step, "menu");

  await controller.confirm();
  assert.deepEqual(completed, [{
    ...existing,
    reasoningEffort: "max",
    recentRawToolActions: 5,
    toolOutputSafetyLimit: 262_144,
    maxToolCallsPerResponse: 9,
  }]);
});

test("retains an existing key when the API key field is empty", async () => {
  const controller = controllerWith(
    { status: "success", models: ["glm-5.2"] },
    { initialConfig: existing },
  );

  controller.selectProvider("zai");
  await controller.submitApiKey("");

  assert.equal(controller.state.step, "model");
  assert.equal(controller.draft.apiKey, existing.apiKey);
});

test("blocks on auth errors and allows direct model fallback", async () => {
  const auth = controllerWith({ status: "auth-error", message: "인증 실패" });
  auth.selectProvider("openai");
  await auth.submitApiKey("bad-key");
  assert.equal(auth.state.step, "api-key");
  assert.equal(auth.state.error, "인증 실패");

  const fallback = controllerWith({ status: "fallback", message: "직접 입력" });
  fallback.selectProvider("custom");
  await fallback.submitApiKey("custom-key");
  assert.equal(fallback.state.step, "base-url");
  await fallback.submitBaseURL("https://example.test/v1");
  assert.equal(fallback.state.step, "model-input");
  assert.equal(fallback.state.warning, "직접 입력");
  fallback.submitModel("vendor-model");
  assert.equal(fallback.state.step, "reasoning");
  assert.deepEqual(fallback.availableReasoningEfforts(), [
    "none", "minimal", "low", "medium", "high", "xhigh",
  ]);
});

test("accepts custom retention values and validates their ranges", () => {
  const controller = controllerWith({ status: "success", models: ["model"] });
  controller.selectProvider("zai");
  controller.selectModel("model");
  controller.selectReasoning("high");

  controller.chooseCustomRecentRawToolActions();
  assert.equal(controller.state.step, "raw-actions-input");
  controller.submitRecentRawToolActions("21");
  assert.equal(controller.state.step, "raw-actions-input");
  assert.match(controller.state.error ?? "", /1.*20/);
  controller.submitRecentRawToolActions("20");
  assert.equal(controller.state.step, "safety-limit");

  controller.chooseCustomToolOutputSafetyLimit();
  assert.equal(controller.state.step, "safety-limit-input");
  controller.submitToolOutputSafetyLimit("2K");
  assert.equal(controller.state.step, "safety-limit-input");
  assert.match(controller.state.error ?? "", /4K.*1M/);
  controller.submitToolOutputSafetyLimit("256K");
  assert.equal(controller.state.step, "max-tool-calls");
  controller.selectMaxToolCallsPerResponse(1);
  assert.equal(controller.state.step, "confirm");
  assert.equal(controller.draft.recentRawToolActions, 20);
  assert.equal(controller.draft.toolOutputSafetyLimit, 262_144);
});

test("validates custom maximum tool calls per response", () => {
  const controller = controllerWith(
    { status: "success", models: ["model"] },
    { initialConfig: existing },
  );

  controller.editMaxToolCallsPerResponse();
  controller.chooseCustomMaxToolCallsPerResponse();
  assert.equal(controller.state.step, "max-tool-calls-input");
  controller.submitMaxToolCallsPerResponse("0");
  assert.match(controller.state.error ?? "", /1.*100/);
  controller.submitMaxToolCallsPerResponse("101");
  assert.match(controller.state.error ?? "", /1.*100/);
  controller.submitMaxToolCallsPerResponse("100");
  assert.equal(controller.state.step, "menu");
  assert.equal(controller.draft.maxToolCallsPerResponse, 100);
});

test("keeps global retention settings when the provider changes", () => {
  const controller = new SettingsController({
    initialConfig: {
      ...existing,
      recentRawToolActions: 7,
      toolOutputSafetyLimit: 128 * 1024,
    },
    discoverModels: async () => ({ kind: "models", models: [] }),
    onComplete: async () => undefined,
  });

  controller.selectProvider("openai");

  assert.equal(controller.draft.recentRawToolActions, 7);
  assert.equal(controller.draft.toolOutputSafetyLimit, 128 * 1024);
});

test("toggles browser auto-open from the menu and persists it", async () => {
  const completed: AgentConfig[] = [];
  const controller = controllerWith(
    { status: "success", models: ["glm-5.2"] },
    { initialConfig: existing, completed },
  );

  assert.equal(controller.state.step, "menu");
  assert.equal(controller.draft.openBrowser, true);

  controller.toggleOpenBrowser();
  assert.equal(controller.state.step, "menu");
  assert.equal(controller.draft.openBrowser, false);

  controller.toggleOpenBrowser();
  assert.equal(controller.draft.openBrowser, true);

  await controller.confirm();
  assert.equal(completed[0]?.openBrowser, true);
});

test("defaults every provider draft to high reasoning, retention, and one tool call", () => {
  for (const provider of ["zai", "openai", "custom"] as const) {
    const controller = controllerWith({ status: "success", models: ["model"] });
    controller.selectProvider(provider);
    assert.equal(controller.draft.reasoningEffort, "high");
    assert.equal(controller.draft.recentRawToolActions, 3);
    assert.equal(controller.draft.toolOutputSafetyLimit, 65_536);
    assert.equal(controller.draft.maxToolCallsPerResponse, 1);
  }
});

test("model selection supports fuzzy keyboard filtering", async () => {
  const controller = controllerWith({
    status: "success",
    models: ["alpha-model", "zeta-model"],
  });
  controller.selectProvider("zai");
  await controller.submitApiKey("key");
  const view = new SettingsView(new TUI(new FakeTerminal()), controller);

  view.handleInput("z");

  const output = stripAnsi(view.render(80).join("\n"));
  assert.match(output, /search: z/);
  assert.match(output, /zeta-model/);
  assert.equal(output.includes("alpha-model"), false);
});

test("settings view masks secrets and remains width safe", () => {
  const controller = controllerWith(
    { status: "success", models: ["glm-5.2"] },
    { initialConfig: existing },
  );
  const view = new SettingsView(new TUI(new FakeTerminal()), controller);

  const output = view.render(80).join("\n");
  const plain = stripAnsi(output);
  assert.match(output, /••••1234/);
  assert.match(plain, /Provider \/ API Key \/ Model/);
  assert.match(plain, /Raw tool actions: 3/);
  assert.match(plain, /Output safety limit: 64K/);
  assert.match(plain, /Max tool calls per response: 1/);
  assert.match(stripAnsi(output), /raw 3/);
  assert.match(stripAnsi(output), /limit 64K/);
  assert.equal(output.includes(existing.apiKey), false);
  for (const line of view.render(28)) {
    assert.ok(visibleWidth(line) <= 28, `${visibleWidth(line)} > 28`);
  }
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
