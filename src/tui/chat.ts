import {
  Box,
  Container,
  Editor,
  Markdown,
  Spacer,
  Text,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";

import type { AgentConfig } from "../config.js";
import { providerDefinition } from "../provider.js";
import { tuiTheme } from "./theme.js";

export interface ChatViewOptions {
  onSubmit?: (text: string) => void;
}

type RunStatus = "ready" | "running" | "interrupting" | "error";

export class ChatView implements Component {
  readonly editor: Editor;

  private readonly tui: TUI;
  private readonly root = new Container();
  private readonly header = new Text("", 1, 0);
  private readonly transcript = new Container();
  private readonly footer = new Text("", 1, 0);
  private readonly tools = new Map<string, ToolBlock>();
  private config: AgentConfig;
  private contextWindow: number;
  private status: RunStatus = "ready";
  private queueLength = 0;
  private contextTokens = 0;
  private transcriptEntries = 0;

  constructor(
    tui: TUI,
    config: AgentConfig,
    contextWindow: number,
    options: ChatViewOptions = {},
  ) {
    this.tui = tui;
    this.config = config;
    this.contextWindow = contextWindow;
    this.editor = new Editor(tui, tuiTheme.editor, { paddingX: 1 });
    this.editor.onSubmit = (text) => {
      if (!text) return;
      this.editor.addToHistory(text);
      options.onSubmit?.(text);
      this.tui.requestRender();
    };

    this.root.addChild(this.header);
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.transcript);
    this.root.addChild(new Spacer(1));
    this.root.addChild(this.editor);
    this.root.addChild(this.footer);
    this.updateChrome();
  }

  addUser(content: string): void {
    this.addTranscript(new MessageBlock("USER", content, "user"));
  }

  addAssistant(content: string): void {
    this.addTranscript(new MessageBlock("AGENT", content, "assistant"));
  }

  addError(message: string): void {
    this.addTranscript(new MessageBlock("ERROR", message, "error"));
    this.status = "error";
    this.updateChrome();
  }

  addInterrupted(cancelledQueueCount = 0): void {
    for (const tool of this.tools.values()) tool.interrupt();
    const queueDetail = cancelledQueueCount > 0
      ? ` · queued ${cancelledQueueCount} cancelled`
      : "";
    this.addTranscript(new MessageBlock(
      "INTERRUPTED",
      `agent loop stopped${queueDetail}`,
      "tool",
    ));
  }

  addCompression(before: number, after: number, eliminatedTokens: number): void {
    const detail = `trajectory ${before} → ${after} messages · -${eliminatedTokens.toLocaleString()} tokens`;
    this.addTranscript(new MessageBlock("COMPRESSED", detail, "tool"));
  }

  addToolStart(id: string, name: string, command: string): void {
    const tool = new ToolBlock(name, command);
    this.tools.set(id, tool);
    this.addTranscript(tool);
  }

  completeTool(id: string, output: string, exitCode: number): void {
    const tool = this.tools.get(id);
    if (!tool) return;
    tool.complete(output, exitCode);
    this.tui.requestRender();
  }

  setStatus(
    status: RunStatus,
    queueLength: number = this.queueLength,
    contextTokens: number = this.contextTokens,
  ): void {
    this.status = status;
    this.queueLength = queueLength;
    this.contextTokens = contextTokens;
    this.updateChrome();
  }

  setConfig(config: AgentConfig, contextWindow: number): void {
    this.config = config;
    this.contextWindow = contextWindow;
    this.updateChrome();
  }

  clearTranscript(): void {
    this.transcript.clear();
    this.tools.clear();
    this.transcriptEntries = 0;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    return this.root.render(width);
  }

  invalidate(): void {
    this.root.invalidate();
  }

  private addTranscript(component: Component): void {
    if (this.transcriptEntries > 0) this.transcript.addChild(new Spacer(1));
    this.transcript.addChild(component);
    this.transcriptEntries++;
    this.tui.requestRender();
  }

  private updateChrome(): void {
    const provider = providerDefinition(this.config.provider).label;
    this.header.setText(
      tuiTheme.bold(tuiTheme.accent("inline-agent"))
      + tuiTheme.muted(" │ ")
      + tuiTheme.text(provider)
      + tuiTheme.muted(" │ ")
      + tuiTheme.text(this.config.model)
      + tuiTheme.muted(" │ reasoning ")
      + tuiTheme.warning(this.config.reasoningEffort),
    );

    const usage = this.contextWindow > 0
      ? `${((this.contextTokens / this.contextWindow) * 100).toFixed(1)}%`
      : "—";
    const statusColor = this.status === "error"
      ? tuiTheme.error
      : this.status === "running" || this.status === "interrupting"
        ? tuiTheme.warning
        : tuiTheme.success;
    this.footer.setText(
      statusColor(`● ${this.status}`)
      + tuiTheme.muted(` │ ctx ${usage} │ queue ${this.queueLength} │ /settings`),
    );
    this.tui.requestRender();
  }
}

class MessageBlock implements Component {
  private readonly box = new Box(1, 0);

  constructor(
    label: string,
    content: string,
    role: "user" | "assistant" | "tool" | "error",
  ) {
    const background = role === "user"
      ? tuiTheme.userBg
      : role === "assistant"
        ? tuiTheme.assistantBg
        : role === "error"
          ? tuiTheme.errorBg
          : tuiTheme.toolBg;
    this.box.setBgFn(background);
    const labelColor = role === "error"
      ? tuiTheme.error
      : role === "tool"
        ? tuiTheme.warning
        : role === "assistant"
          ? tuiTheme.success
          : tuiTheme.accent;
    this.box.addChild(new Text(tuiTheme.bold(labelColor(label)), 0, 0));
    if (role === "assistant") {
      this.box.addChild(new Markdown(
        content,
        0,
        0,
        tuiTheme.markdown,
        { color: tuiTheme.text },
      ));
    } else {
      this.box.addChild(new Text(tuiTheme.text(content), 0, 0));
    }
  }

  render(width: number): string[] { return this.box.render(width); }
  invalidate(): void { this.box.invalidate(); }
}

class ToolBlock implements Component {
  private readonly name: string;
  private readonly command: string;
  private output = "";
  private exitCode: number | null = null;
  private interrupted = false;
  private box = new Box(1, 0, tuiTheme.toolBg);

  constructor(name: string, command: string) {
    this.name = name;
    this.command = command;
    this.rebuild();
  }

  complete(output: string, exitCode: number): void {
    this.output = output;
    this.exitCode = exitCode;
    this.rebuild();
  }

  interrupt(): void {
    if (this.exitCode !== null) return;
    this.interrupted = true;
    this.output = "[interrupted by user]";
    this.rebuild();
  }

  render(width: number): string[] { return this.box.render(width); }
  invalidate(): void { this.box.invalidate(); }

  private rebuild(): void {
    this.box = new Box(1, 0, tuiTheme.toolBg);
    const icon = this.interrupted
      ? "■"
      : this.exitCode === null
        ? "…"
        : this.exitCode === 0
          ? "✓"
          : "✗";
    const color = this.interrupted
      ? tuiTheme.warning
      : this.exitCode === null
        ? tuiTheme.warning
        : this.exitCode === 0
          ? tuiTheme.success
          : tuiTheme.error;
    this.box.addChild(new Text(
      tuiTheme.bold(color(`TOOL ${this.name} ${icon}`)),
      0,
      0,
    ));
    this.box.addChild(new Text(tuiTheme.warning(`$ ${this.command}`), 0, 0));
    if (this.output) this.box.addChild(new Text(tuiTheme.text(this.output), 0, 0));
  }
}
