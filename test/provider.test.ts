import test from "node:test";
import assert from "node:assert/strict";

import type { AgentConfig } from "../src/config.js";
import {
  createProviderClient,
  guessContextWindow,
  listProviderModels,
  providerDefinition,
} from "../src/provider.js";

const baseConfig: AgentConfig = {
  version: 1,
  provider: "zai",
  apiKey: "super-secret-key",
  model: "glm-5.2",
  reasoningEffort: "high",
};

test("describes provider endpoints, defaults, and exact reasoning values", () => {
  assert.deepEqual(providerDefinition("zai"), {
    id: "zai",
    label: "Z.AI Coding Plan",
    baseURL: "https://api.z.ai/api/coding/paas/v4",
    defaultModel: "glm-5.2",
    reasoningEfforts: [
      "none", "minimal", "low", "medium", "high", "xhigh", "max",
    ],
    defaultReasoningEffort: "high",
  });
  assert.deepEqual(providerDefinition("openai").reasoningEfforts, [
    "none", "minimal", "low", "medium", "high", "xhigh",
  ]);
  assert.deepEqual(providerDefinition("custom").reasoningEfforts, [
    "none", "minimal", "low", "medium", "high", "xhigh",
  ]);
  assert.equal(providerDefinition("openai").defaultReasoningEffort, "high");
  assert.equal(providerDefinition("custom").defaultReasoningEffort, "high");
});

test("uses model-specific context window estimates", () => {
  assert.equal(guessContextWindow("glm-5.2"), 1_000_000);
  assert.equal(guessContextWindow("gpt-5.1"), 400_000);
  assert.equal(guessContextWindow("unknown-model"), 200_000);
});

test("creates provider clients with the expected connection options", () => {
  const calls: unknown[] = [];
  const factory = (options: unknown) => {
    calls.push(options);
    return { options } as any;
  };

  createProviderClient(baseConfig, factory);
  createProviderClient({ ...baseConfig, provider: "openai" }, factory);
  createProviderClient({
    ...baseConfig,
    provider: "custom",
    baseURL: "https://example.test/v1",
  }, factory);

  assert.deepEqual(calls, [
    {
      apiKey: "super-secret-key",
      baseURL: "https://api.z.ai/api/coding/paas/v4",
    },
    { apiKey: "super-secret-key" },
    { apiKey: "super-secret-key", baseURL: "https://example.test/v1" },
  ]);
});

test("returns sorted unique model IDs from the provider", async () => {
  const client = {
    models: {
      list: async () => ({
        data: [{ id: "z-model" }, { id: "a-model" }, { id: "z-model" }],
      }),
    },
  };

  assert.deepEqual(await listProviderModels(baseConfig, client as any), {
    status: "success",
    models: ["a-model", "z-model"],
  });
});

test("blocks settings on 401 and 403 authentication errors", async () => {
  for (const status of [401, 403]) {
    const client = {
      models: {
        list: async () => {
          throw Object.assign(new Error(`bad super-secret-key`), { status });
        },
      },
    };

    const result = await listProviderModels(baseConfig, client as any);

    assert.equal(result.status, "auth-error");
    assert.equal(result.message.includes("super-secret-key"), false);
    assert.match(result.message, /인증/);
  }
});

test("allows direct model input when discovery is unsupported or unavailable", async () => {
  for (const error of [
    Object.assign(new Error("not found"), { status: 404 }),
    Object.assign(new Error("server unavailable"), { status: 503 }),
    new Error("network failed"),
  ]) {
    const client = { models: { list: async () => { throw error; } } };

    const result = await listProviderModels(baseConfig, client as any);

    assert.equal(result.status, "fallback");
    assert.ok(result.message.length > 0);
  }
});

test("falls back to direct input when a provider returns no models", async () => {
  const client = { models: { list: async () => ({ data: [] }) } };

  const result = await listProviderModels(baseConfig, client as any);

  assert.deepEqual(result, {
    status: "fallback",
    message: "모델 목록이 비어 있습니다. 모델 ID를 직접 입력하세요.",
  });
});
