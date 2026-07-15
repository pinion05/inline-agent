import test from "node:test";
import assert from "node:assert/strict";

import type { Message } from "../src/compact.js";
import {
  compactCanonicalTrajectory,
  countRawToolActions,
  projectTrajectory,
} from "../src/trajectory.js";
import {
  ContextOverflowError,
  buildContextProjection,
  estimateRequestTokens,
} from "../src/context-projection.js";

function actionHistory(groups: number, outputSize = 200): Message[] {
  const messages: Message[] = [{ role: "user", content: "do the work" }];
  for (let index = 1; index <= groups; index++) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: [{
        id: `call_${index}`,
        type: "function",
        function: {
          name: "shell",
          arguments: JSON.stringify({ command: `command-${index}` }),
        },
      }],
    });
    messages.push({
      role: "tool",
      tool_call_id: `call_${index}`,
      content: `${String(index).repeat(outputSize)}\n[exit: 0]`,
    });
  }
  return messages;
}

test("projects exactly the configured number of recent raw action groups", () => {
  const input = actionHistory(5);
  const original = structuredClone(input);

  const keepOne = projectTrajectory(input, 1);
  const keepThree = projectTrajectory(input, 3);
  const keepTwenty = projectTrajectory(input, 20);

  assert.equal(countRawToolActions(keepOne), 1);
  assert.equal(countRawToolActions(keepThree), 3);
  assert.equal(countRawToolActions(keepTwenty), 5);
  assert.match(keepOne.find((message) => message.role === "tool")?.content ?? "", /^5+/);
  assert.deepEqual(input, original);
});

test("fixes the cut-point off-by-one at the N plus one boundary", () => {
  const input = actionHistory(4);
  const projected = projectTrajectory(input, 3);

  assert.equal(countRawToolActions(projected), 3);
  assert.equal(projected.some((message) => (
    message.role === "assistant"
    && message.content.includes("$ command-1 →")
  )), true);
});

test("keeps complete multi-tool action groups on both sides of the boundary", () => {
  const first: Message[] = [
    { role: "user", content: "parallel work" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_a",
          type: "function",
          function: { name: "shell", arguments: '{"command":"a"}' },
        },
        {
          id: "call_b",
          type: "function",
          function: { name: "shell", arguments: '{"command":"b"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_a", content: "result-a" },
    { role: "tool", tool_call_id: "call_b", content: "result-b" },
    ...actionHistory(1).slice(1),
  ];

  const projected = projectTrajectory(first, 1);
  const summary = projected.find((message) => (
    message.role === "assistant" && !message.tool_calls?.length
  ))?.content ?? "";

  assert.equal(countRawToolActions(projected), 1);
  assert.match(summary, /\$ a → result-a/);
  assert.match(summary, /\$ b → result-b/);
  assert.equal(projected.filter((message) => message.role === "tool").length, 1);
});

test("canonical recovery compaction keeps at most twenty raw action groups", () => {
  const input = actionHistory(25, 1_000);

  const result = compactCanonicalTrajectory(input);

  assert.equal(countRawToolActions(result.messages), 20);
  assert.equal(result.compressedActions, 5);
  assert.ok(result.eliminatedTokens > 0);
  assert.equal(countRawToolActions(input), 25);
});

test("context projection lowers effective raw actions until the request fits", () => {
  const result = buildContextProjection({
    messages: actionHistory(3, 4_000),
    systemPrompt: "system",
    tools: [{ type: "function", function: { name: "shell" } }],
    configuredRawActions: 3,
    maxInputTokens: 1_800,
  });

  assert.equal(result.configuredRawActions, 3);
  assert.ok(result.effectiveRawActions < 3);
  assert.ok(result.effectiveRawActions >= 0);
  assert.ok(result.estimatedTokens <= 1_800);
  assert.ok(result.compressionTokens > 0);
  assert.equal(countRawToolActions(result.apiMessages), result.effectiveRawActions);
});

test("uses the dashboard's exact request-token estimate", () => {
  const messages: Message[] = [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "shell", arguments: '{"command":"pwd"}' },
      }],
    },
  ];
  const tools = [{ type: "function", function: { name: "shell" } }];
  const dashboardEstimate = messages.reduce(
    (total, message) => total + Math.ceil(JSON.stringify(message).length / 4),
    Math.ceil(JSON.stringify(tools).length / 4),
  );

  assert.equal(estimateRequestTokens(messages, tools), dashboardEstimate);
});

test("throws before the provider call when zero raw actions still cannot fit", () => {
  assert.throws(
    () => buildContextProjection({
      messages: [{ role: "user", content: "x".repeat(20_000) }],
      systemPrompt: "system",
      tools: [],
      configuredRawActions: 3,
      maxInputTokens: 100,
    }),
    (error: Error) => (
      error instanceof ContextOverflowError
      && error.estimatedTokens > error.maxInputTokens
    ),
  );
});
