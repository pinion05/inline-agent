import test from "node:test";
import assert from "node:assert/strict";

import {
  CURSOR_MARKER,
  TUI,
  visibleWidth,
  type Terminal,
} from "@earendil-works/pi-tui";
import type { AgentConfig } from "../src/config.js";
import { ChatView } from "../src/tui/chat.js";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  writes: string[] = [];
  stopped = false;
  private onInput?: (data: string) => void;
  start(onInput: (data: string) => void): void { this.onInput = onInput; }
  stop(): void { this.stopped = true; }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.writes.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  send(data: string): void { this.onInput?.(data); }
}

const config: AgentConfig = {
  version: 1,
  provider: "zai",
  apiKey: "never-render-this-key",
  model: "glm-5.2",
  reasoningEffort: "high",
  recentRawToolActions: 3,
  toolOutputSafetyLimit: 65_536,
  maxToolCallsPerResponse: 1,
};

test("renders width-safe retained user, tool, assistant, and error blocks", () => {
  const terminal = new FakeTerminal();
  const tui = new TUI(terminal);
  const view = new ChatView(tui, config, 1_000_000);

  view.addUser("긴 사용자 메시지 ".repeat(8));
  view.addToolStart("call_1", "shell", "npm test -- --very-long-command");
  view.completeTool("call_1", "15 tests passed\n[exit: 0]", 0);
  view.addAssistant("**완료했습니다.** 다음 줄도 표시합니다.");
  view.addError("provider failed");
  view.setStatus("running", 2, 12_345);

  const wide = view.render(80).join("\n");
  const plain = stripAnsi(wide);
  assert.match(plain, /USER/);
  assert.match(plain, /TOOL.*✓/);
  assert.match(plain, /AGENT/);
  assert.match(plain, /ERROR/);
  assert.match(plain, /glm-5\.2/);
  assert.match(plain, /reasoning high/);
  assert.match(plain, /raw 3/);
  assert.match(plain, /limit 64K/);
  assert.equal(wide.includes(config.apiKey), false);

  for (const line of view.render(24)) {
    assert.ok(visibleWidth(line) <= 24, `${visibleWidth(line)} > 24: ${line}`);
  }
});

test("retains at most a 4K tail preview in tool cards", () => {
  const terminal = new FakeTerminal();
  const view = new ChatView(new TUI(terminal), config, 1_000_000);
  const output = `${"a".repeat(6_000)}${"z".repeat(4_000)}`;

  view.addToolStart("call_preview", "shell", "large-output");
  view.completeTool("call_preview", output, 0);

  const rendered = stripAnsi(view.render(120).join("\n"));
  assert.match(rendered, /tool preview: last 4,096 chars/);
  assert.equal(rendered.includes("a".repeat(100)), false);
  assert.match(rendered, /z{100}/);
});

test("submits multiline editor input and exposes an IME cursor marker", () => {
  const terminal = new FakeTerminal();
  const tui = new TUI(terminal, true);
  const submissions: string[] = [];
  const view = new ChatView(tui, config, 1_000_000, {
    onSubmit: (text) => submissions.push(text),
  });

  view.editor.setText("첫 줄\n둘째 줄");
  view.editor.focused = true;
  assert.equal(view.editor.render(50).join("\n").includes(CURSOR_MARKER), true);

  view.editor.handleInput("\r");

  assert.deepEqual(submissions, ["첫 줄\n둘째 줄"]);
  assert.equal(view.editor.getText(), "");
});

test("updates runtime settings without clearing the transcript", () => {
  const terminal = new FakeTerminal();
  const view = new ChatView(new TUI(terminal), config, 1_000_000);
  view.addUser("keep this conversation");

  view.setConfig({
    ...config,
    provider: "openai",
    model: "gpt-5.1",
    reasoningEffort: "xhigh",
  }, 400_000);

  const output = stripAnsi(view.render(80).join("\n"));
  assert.match(output, /keep this conversation/);
  assert.match(output, /OpenAI/);
  assert.match(output, /gpt-5\.1/);
  assert.match(output, /reasoning xhigh/);
});

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
