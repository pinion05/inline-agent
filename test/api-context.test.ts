import test from "node:test";
import assert from "node:assert/strict";

import { run } from "../src/loop.js";
import { getSnapshot } from "../src/server.js";
import type { Message } from "../src/compact.js";

test("captures the exact request-only system prompt, messages, and tools", async () => {
  let sentMessages: Message[] = [];
  let sentTools: unknown[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: { messages: Message[]; tools: unknown[] }) => {
          sentMessages = structuredClone(request.messages);
          sentTools = structuredClone(request.tools);
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
  assert.deepEqual(sentMessages, [
    { role: "system", content: "exact system prompt\n" },
    { role: "user", content: "exact user input" },
  ]);
  assert.deepEqual(messages, [
    { role: "user", content: "exact user input" },
    { role: "assistant", content: "ok" },
  ]);
  assert.equal((sentTools[0] as any).function.name, "shell");
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
});
