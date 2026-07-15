import { compressTrajectory } from "./src/trajectory.js";
import type { Message } from "./src/compact.js";

// Simulate 7 turns of agent conversation
const messages: Message[] = [
  { role: "user", content: "Fix the test failure in utils.test.ts" },

  // Turn 1 (old — should be compressed)
  {
    role: "assistant",
    content:
      "Let me first check what tests exist and run them to see the failure.",
    tool_calls: [
      {
        id: "call_1",
        type: "function",
        function: { name: "shell", arguments: JSON.stringify({ command: "npm test" }) },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "call_1",
    content:
      "[exit: 1]\ntest_add ... ok\ntest_sub ... ok\ntest_mul ... FAIL\n  AssertionError: expected 6 got 7\n  at utils.test.ts:42\ntest_div ... ok\ntest_mod ... ok\n3 tests passed.",
  },

  // Turn 2 (old — should be compressed)
  {
    role: "assistant",
    content: "Found the failure in test_mul. Let me look at the source file.",
    tool_calls: [
      {
        id: "call_2",
        type: "function",
        function: { name: "shell", arguments: JSON.stringify({ command: "cat src/utils.ts" }) },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "call_2",
    content:
      "export function mul(a, b) {\n  return a + b; // BUG: should be a * b\n}\n[exit: 0]",
  },

  // Turn 3 (old — should be compressed)
  {
    role: "assistant",
    content:
      "Found the bug. The multiply function is using addition instead of multiplication. Let me fix it.",
    tool_calls: [
      {
        id: "call_3",
        type: "function",
        function: { name: "shell", arguments: JSON.stringify({ command: "sed -i 's/return a + b/return a * b/' src/utils.ts" }) },
      },
    ],
  },
  { role: "tool", tool_call_id: "call_3", content: "[exit: 0]" },

  // Turn 4 (recent — should be kept as-is)
  {
    role: "assistant",
    content: "Now let me verify the fix by running the tests again.",
    tool_calls: [
      {
        id: "call_4",
        type: "function",
        function: { name: "shell", arguments: JSON.stringify({ command: "npm test" }) },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "call_4",
    content:
      "[exit: 0]\ntest_add ... ok\ntest_sub ... ok\ntest_mul ... ok\ntest_div ... ok\n4 tests passed.",
  },

  // Turn 5 (recent — should be kept as-is)
  {
    role: "assistant",
    content: "All tests pass. The bug is fixed.",
    tool_calls: [
      {
        id: "call_5",
        type: "function",
        function: { name: "shell", arguments: JSON.stringify({ command: "git diff" }) },
      },
    ],
  },
  {
    role: "tool",
    tool_call_id: "call_5",
    content:
      "--- a/src/utils.ts\n+++ b/src/utils.ts\n@@ -1,3 +1,3 @@\n export function mul(a, b) {\n-  return a + b;\n+  return a * b;\n }\n[exit: 0]",
  },

  // Turn 6 (recent — should be kept as-is)
  {
    role: "assistant",
    content: "The diff looks correct. Let me commit the fix.",
  },
];

console.log("=== BEFORE ===");
console.log("Messages:", messages.length);
let totalChars = 0;
for (const m of messages) totalChars += JSON.stringify(m).length;
console.log("Total chars:", totalChars);
console.log();

const result = compressTrajectory(messages);
console.log("=== AFTER ===");
console.log("Messages:", result.length);
let compressedChars = 0;
for (const m of result) compressedChars += JSON.stringify(m).length;
console.log("Total chars:", compressedChars);
console.log(
  "Reduction:",
  Math.round((1 - compressedChars / totalChars) * 100) + "%"
);
console.log();

console.log("=== COMPRESSED MESSAGES ===");
for (const m of result) {
  const preview = (m.content ?? "").slice(0, 150);
  const hasToolCalls = m.tool_calls?.length ? ` [+${m.tool_calls.length} tool_calls]` : "";
  console.log(`[${m.role}] ${preview}${hasToolCalls}`);
  if (m.tool_call_id) console.log(`  → tool_call_id: ${m.tool_call_id}`);
  console.log();
}
