import test from "node:test";
import assert from "node:assert/strict";

import { run } from "../src/loop.js";
import { getSnapshot } from "../src/server.js";
import type { Message } from "../src/compact.js";
import { countRawToolActions } from "../src/trajectory.js";

test("captures the exact request-only system prompt, messages, and tools", async () => {
  let sentMessages: Message[] = [];
  let sentTools: unknown[] = [];
  let sentReasoning: string | undefined;
  const client = {
    chat: {
      completions: {
        create: async (request: {
          messages: Message[];
          tools: unknown[];
          reasoning_effort?: string;
        }) => {
          sentMessages = structuredClone(request.messages);
          sentTools = structuredClone(request.tools);
          sentReasoning = request.reasoning_effort;
          return {
            choices: [{ message: { content: "ok", tool_calls: [] } }],
          };
        },
      },
    },
  };
  const messages: Message[] = [];

  await run(
    {
      client: client as any,
      model: "test-model",
      reasoningEffort: "high",
      recentRawToolActions: 3,
      toolOutputSafetyLimit: 65_536,
      contextWindow: 100_000,
      messages,
      skillsInjected: true,
      systemPromptLoader: async () => "exact system prompt\n",
    },
    "exact user input",
  );

  const snapshot = getSnapshot();
  assert.deepEqual(snapshot.apiMessages, sentMessages);
  assert.deepEqual(snapshot.apiTools, sentTools);
  assert.equal(sentReasoning, "high");
  assert.equal(snapshot.apiModel, "test-model");
  assert.equal(snapshot.apiReasoningEffort, "high");
  assert.equal(snapshot.stats.configuredRawActions, 3);
  assert.equal(snapshot.stats.effectiveRawActions, 3);
  assert.deepEqual(sentMessages, [
    { role: "system", content: "exact system prompt\n" },
    { role: "user", content: "exact user input" },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "exact user input" },
    { role: "assistant", content: "ok" },
  ]);
  assert.equal((sentTools[0] as any).function.name, "shell");
  assert.deepEqual(
    Object.keys((sentTools[0] as any).function.parameters.properties),
    ["command"],
  );
  assert.equal(
    "max_length" in (sentTools[0] as any).function.parameters.properties,
    false,
  );
});

test("reloads the system prompt before every tool-loop API call", async () => {
  const sentRequests: Message[][] = [];
  const prompts = ["first prompt", "second prompt"];
  let promptIndex = 0;
  const client = {
    chat: {
      completions: {
        create: async (request: { messages: Message[] }) => {
          sentRequests.push(structuredClone(request.messages));
          if (sentRequests.length === 1) {
            return {
              choices: [{
                message: {
                  content: "",
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "shell",
                      arguments: JSON.stringify({ command: "printf tool-output" }),
                    },
                  }],
                },
              }],
            };
          }
          return {
            choices: [{ message: { content: "done", tool_calls: [] } }],
          };
        },
      },
    },
  };
  const messages: Message[] = [];

  await run(
    {
      client: client as any,
      model: "test-model",
      reasoningEffort: "low",
      recentRawToolActions: 3,
      toolOutputSafetyLimit: 65_536,
      contextWindow: 100_000,
      messages,
      skillsInjected: true,
      systemPromptLoader: async () => prompts[promptIndex++],
    },
    "run a tool",
  );

  assert.equal(sentRequests.length, 2);
  assert.deepEqual(sentRequests.map((request) => request[0]), [
    { role: "system", content: "first prompt" },
    { role: "system", content: "second prompt" },
  ]);
  assert.deepEqual(messages.map((message) => message.role), [
    "user",
    "assistant",
    "tool",
    "assistant",
  ]);
  assert.equal(messages.some((message) => message.role === "system"), false);
  assert.deepEqual(getSnapshot().apiMessages, sentRequests[1]);
  assert.equal(getSnapshot().apiReasoningEffort, "low");
});

test("sends a request-only projection while retaining the canonical raw ring", async () => {
  const requests: Message[][] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: { messages: Message[] }) => {
          requests.push(structuredClone(request.messages));
          const round = requests.length;
          if (round <= 4) {
            return {
              choices: [{
                message: {
                  content: "",
                  tool_calls: [{
                    id: `call_${round}`,
                    type: "function",
                    function: {
                      name: "shell",
                      arguments: JSON.stringify({ command: `printf result-${round}` }),
                    },
                  }],
                },
              }],
            };
          }
          return { choices: [{ message: { content: "done", tool_calls: [] } }] };
        },
      },
    },
  };
  const messages: Message[] = [];

  await run({
    client: client as any,
    model: "test-model",
    reasoningEffort: "high",
    recentRawToolActions: 1,
    toolOutputSafetyLimit: 65_536,
    contextWindow: 100_000,
    messages,
    skillsInjected: true,
    systemPromptLoader: async () => undefined,
  }, "project actions");

  assert.equal(countRawToolActions(messages), 4);
  assert.equal(countRawToolActions(requests.at(-1)!), 1);
  assert.deepEqual(getSnapshot().apiMessages, requests.at(-1));
  assert.equal(getSnapshot().stats.configuredRawActions, 1);
  assert.equal(getSnapshot().stats.effectiveRawActions, 1);
  assert.ok(getSnapshot().stats.currentProjectionTokens > 0);
});
