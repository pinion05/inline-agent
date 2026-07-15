import test from "node:test";
import assert from "node:assert/strict";

import { run } from "../src/loop.js";
import { getSnapshot } from "../src/server.js";
import type { Message } from "../src/compact.js";

test("captures exact system, messages, and tool definitions passed to the LLM", async () => {
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
  const messages: Message[] = [
    { role: "system", content: "exact system prompt" },
  ];

  await run(
    {
      client: client as any,
      model: "test-model",
      contextWindow: 100_000,
      messages,
      skillsInjected: true,
    },
    "exact user input"
  );

  const snapshot = getSnapshot();
  assert.deepEqual(snapshot.apiMessages, sentMessages);
  assert.deepEqual(snapshot.apiTools, sentTools);
  assert.deepEqual(sentMessages, [
    { role: "system", content: "exact system prompt" },
    { role: "user", content: "exact user input" },
  ]);
  assert.equal((sentTools[0] as any).function.name, "shell");
});
