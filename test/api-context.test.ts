import test from "node:test";
import assert from "node:assert/strict";

import { run } from "../src/loop.js";
import { getSnapshot } from "../src/server.js";
import type { Message } from "../src/compact.js";

test("captures an immutable copy of the exact messages passed to the LLM", async () => {
  let sentMessages: Message[] = [];
  const client = {
    chat: {
      completions: {
        create: async (request: { messages: Message[] }) => {
          sentMessages = structuredClone(request.messages);
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
    },
    "exact user input"
  );

  assert.deepEqual(getSnapshot().apiMessages, sentMessages);
  assert.deepEqual(sentMessages, [{ role: "user", content: "exact user input" }]);
});
