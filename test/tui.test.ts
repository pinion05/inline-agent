import test from "node:test";
import assert from "node:assert/strict";

import {
  formatAgentReply,
  formatToolLine,
  formatUserPrompt,
  resetStyle,
  supportsColor,
} from "../src/tui.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

test("enables colors only for TTY streams without NO_COLOR", () => {
  assert.equal(supportsColor(tty, {}), true);
  assert.equal(supportsColor(pipe, {}), false);
  assert.equal(supportsColor(tty, { NO_COLOR: "" }), false);
  assert.equal(supportsColor(tty, { NO_COLOR: "1" }), false);
});

test("uses distinct dark backgrounds for user, tool, and agent roles", () => {
  const user = formatUserPrompt(true);
  const tool = formatToolLine("npm test", true);
  const agent = formatAgentReply("done", true);

  assert.match(user, /\x1b\[48;5;24m/);
  assert.match(tool, /\x1b\[48;5;58m/);
  assert.match(agent, /\x1b\[48;5;22m/);
  assert.equal(tool.endsWith("\x1b[0m"), true);
  assert.equal(agent.endsWith("\x1b[0m"), true);
  assert.equal(resetStyle(true), "\x1b[0m");
});

test("styles every line of a multiline agent reply and resets each line", () => {
  const lines = formatAgentReply("one\n\ntwo", true).split("\n");

  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.match(line, /\x1b\[48;5;22m/);
    assert.match(line, /AGENT │/);
    assert.equal(line.endsWith("\x1b[0m"), true);
  }
});

test("returns exact plain text when colors are disabled", () => {
  assert.equal(formatUserPrompt(false), "USER │ ");
  assert.equal(formatToolLine("npm test", false), "TOOL │ $ npm test");
  assert.equal(
    formatAgentReply("one\ntwo", false),
    "AGENT │ one\nAGENT │ two",
  );
  assert.equal(resetStyle(false), "");
});
