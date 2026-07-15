import test from "node:test";
import assert from "node:assert/strict";

import type { AgentEvent } from "../src/agent-events.js";
import type { Message } from "../src/compact.js";
import { run } from "../src/loop.js";

function toolThenAnswerClient() {
  let calls = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          calls++;
          if (calls === 1) {
            return {
              choices: [{
                message: {
                  content: "",
                  tool_calls: [{
                    id: "call_1",
                    type: "function",
                    function: {
                      name: "shell",
                      arguments: JSON.stringify({ command: "printf event-output" }),
                    },
                  }],
                },
              }],
            };
          }
          return {
            choices: [{ message: { content: "finished", tool_calls: [] } }],
          };
        },
      },
    },
  };
}

test("emits ordered run, tool, and assistant events without terminal writes", async () => {
  const events: AgentEvent[] = [];
  const messages: Message[] = [];
  const writes: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const reply = await run(
      {
        client: toolThenAnswerClient() as any,
        model: "test-model",
        reasoningEffort: "high",
        contextWindow: 100_000,
        messages,
        skillsInjected: true,
        systemPromptLoader: async () => undefined,
        onEvent: (event) => events.push(event),
      },
      "run it",
    );

    assert.equal(reply, "finished");
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.deepEqual(events.map((event) => event.type), [
    "run-start",
    "context-projection",
    "tool-start",
    "tool-complete",
    "context-projection",
    "assistant-complete",
  ]);
  assert.deepEqual(events[2], {
    type: "tool-start",
    id: "call_1",
    name: "shell",
    command: "printf event-output",
  });
  assert.equal(events[3].type, "tool-complete");
  if (events[3].type === "tool-complete") {
    assert.equal(events[3].output, "event-output\n[exit: 0]");
  }
  assert.equal(events[4].type, "context-projection");
  if (events[4].type === "context-projection") {
    assert.ok(events[4].estimatedTokens > 0);
    assert.equal(events[4].configuredRawActions, 3);
    assert.equal(events[4].effectiveRawActions, 3);
  }
  assert.deepEqual(events[5], {
    type: "assistant-complete",
    content: "finished",
  });
  assert.deepEqual(writes, []);
});

test("passes AbortSignal to the API and emits interrupted instead of error", async () => {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  let receivedSignal: AbortSignal | undefined;
  let rejectRequest: ((reason: unknown) => void) | undefined;
  const client = {
    chat: {
      completions: {
        create: async (_request: unknown, options?: { signal?: AbortSignal }) => {
          receivedSignal = options?.signal;
          await new Promise((_resolve, reject) => {
            rejectRequest = reject;
          });
        },
      },
    },
  };
  const running = run(
    {
      client: client as any,
      model: "test-model",
      reasoningEffort: "high",
      contextWindow: 100_000,
      messages: [],
      skillsInjected: true,
      systemPromptLoader: async () => undefined,
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    },
    "interrupt me",
  );
  await new Promise((resolve) => setImmediate(resolve));

  controller.abort();
  rejectRequest?.(controller.signal.reason);

  await assert.rejects(running, (error: Error) => error.name === "AbortError");
  assert.equal(receivedSignal, controller.signal);
  assert.deepEqual(events.map((event) => event.type), [
    "run-start", "context-projection", "interrupted",
  ]);
});

test("keeps tool-call trajectory valid when interruption occurs during a tool round", async () => {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const messages: Message[] = [];
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{
            message: {
              content: "",
              tool_calls: ["call_1", "call_2"].map((id) => ({
                id,
                type: "function",
                function: {
                  name: "shell",
                  arguments: JSON.stringify({ command: "sleep 10" }),
                },
              })),
            },
          }],
        }),
      },
    },
  };

  await assert.rejects(
    run(
      {
        client: client as any,
        model: "test-model",
        reasoningEffort: "high",
        contextWindow: 100_000,
        messages,
        skillsInjected: true,
        systemPromptLoader: async () => undefined,
        signal: controller.signal,
        onEvent: (event) => {
          events.push(event);
          if (event.type === "tool-start") controller.abort();
        },
      },
      "interrupt tools",
    ),
    (error: Error) => error.name === "AbortError",
  );

  assert.deepEqual(messages.map((message) => message.role), [
    "user", "assistant", "tool", "tool",
  ]);
  assert.deepEqual(messages.slice(2).map((message) => ({
    id: message.tool_call_id,
    content: message.content,
  })), [
    { id: "call_1", content: "[interrupted by user]" },
    { id: "call_2", content: "[interrupted by user]" },
  ]);
  assert.deepEqual(events.map((event) => event.type), [
    "run-start", "context-projection", "tool-start", "interrupted",
  ]);
});

test("emits an error event and preserves the thrown API failure", async () => {
  const events: AgentEvent[] = [];
  const failure = new Error("provider failed");
  const client = {
    chat: {
      completions: {
        create: async () => { throw failure; },
      },
    },
  };

  await assert.rejects(
    run(
      {
        client: client as any,
        model: "test-model",
        reasoningEffort: "high",
        contextWindow: 100_000,
        messages: [],
        skillsInjected: true,
        systemPromptLoader: async () => undefined,
        onEvent: (event) => events.push(event),
      },
      "fail",
    ),
    failure,
  );

  assert.deepEqual(events.map((event) => event.type), [
    "run-start", "context-projection", "error",
  ]);
  assert.deepEqual(events.at(-1), { type: "error", message: "provider failed" });
});
