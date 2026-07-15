import {
  Key,
  ProcessTerminal,
  TUI,
  matchesKey,
  type OverlayHandle,
  type Terminal,
} from "@earendil-works/pi-tui";
import type OpenAI from "openai";

import type { AgentEvent } from "../agent-events.js";
import {
  saveConfig as persistConfig,
  type AgentConfig,
} from "../config.js";
import type { Message, UsageInfo } from "../compact.js";
import { run, type RunOptions } from "../loop.js";
import {
  createProviderClient,
  guessContextWindow,
  listProviderModels,
  type ModelDiscoveryResult,
} from "../provider.js";
import { ChatView } from "./chat.js";
import { SettingsController, SettingsView } from "./settings.js";

export interface InlineAgentAppOptions {
  terminal?: Terminal;
  initialConfig?: AgentConfig;
  configSeed?: Partial<AgentConfig>;
  configError?: string;
  saveConfig?: (config: AgentConfig) => Promise<void>;
  discoverModels?: (config: AgentConfig) => Promise<ModelDiscoveryResult>;
  createClient?: (config: AgentConfig) => OpenAI;
  runAgent?: (options: RunOptions, input: string) => Promise<string>;
  onExit?: () => void;
}

export class InlineAgentApp {
  readonly tui: TUI;
  readonly messages: Message[] = [];
  config?: AgentConfig;
  chatView?: ChatView;
  settingsController?: SettingsController;

  private readonly configSeed?: Partial<AgentConfig>;
  private readonly configError?: string;
  private readonly saveConfigImpl: (config: AgentConfig) => Promise<void>;
  private readonly discoverModelsImpl: (config: AgentConfig) => Promise<ModelDiscoveryResult>;
  private readonly createClientImpl: (config: AgentConfig) => OpenAI;
  private readonly runAgentImpl: (options: RunOptions, input: string) => Promise<string>;
  private readonly onExit?: () => void;
  private readonly queue: string[] = [];
  private client?: OpenAI;
  private contextWindow = 0;
  private projectedContextTokens = 0;
  private processing: Promise<void> | null = null;
  private settingsView?: SettingsView;
  private settingsOverlay?: OverlayHandle;
  private firstRunSettings = false;
  private skillsInjected = false;
  private lastUsage?: UsageInfo;
  private currentAbort?: AbortController;
  private cancelledQueueCount = 0;
  private removeInputListener?: () => void;
  private stopped = false;

  constructor(options: InlineAgentAppOptions = {}) {
    this.tui = new TUI(options.terminal ?? new ProcessTerminal(), true);
    this.config = options.initialConfig;
    this.configSeed = options.configSeed;
    this.configError = options.configError;
    this.saveConfigImpl = options.saveConfig ?? ((config) => persistConfig(config));
    this.discoverModelsImpl = options.discoverModels ?? ((config) => listProviderModels(config));
    this.createClientImpl = options.createClient ?? createProviderClient;
    this.runAgentImpl = options.runAgent ?? run;
    this.onExit = options.onExit;
  }

  get queueLength(): number { return this.queue.length; }

  start(): void {
    this.removeInputListener = this.tui.addInputListener((data) => {
      if (matchesKey(data, Key.ctrl("c"))) {
        this.stop();
        return { consume: true };
      }
      if (
        matchesKey(data, Key.ctrl("d"))
        && (!this.chatView || this.chatView.editor.getText().length === 0)
      ) {
        this.stop();
        return { consume: true };
      }
      if (matchesKey(data, Key.escape) && this.interrupt()) {
        return { consume: true };
      }
      return undefined;
    });
    if (this.config) {
      this.activateChat(this.config);
    } else {
      this.openSettings(true);
    }
    this.tui.start();
    this.tui.requestRender(true);
  }

  async submit(input: string): Promise<void> {
    const trimmed = input.trim();
    if (!trimmed) return;
    if (trimmed === "/settings") {
      this.openSettings(false);
      return;
    }
    if (trimmed === "/clear") {
      if (this.processing) {
        this.chatView?.addError("실행 중에는 대화를 초기화할 수 없습니다.");
        return;
      }
      this.messages.length = 0;
      this.queue.length = 0;
      this.skillsInjected = false;
      this.lastUsage = undefined;
      this.projectedContextTokens = 0;
      this.chatView?.clearTranscript();
      this.chatView?.setStatus("ready", 0, 0);
      return;
    }
    if (trimmed === "/exit" || trimmed === "/quit") {
      this.stop();
      return;
    }
    if (!this.config || !this.client || !this.chatView) {
      this.openSettings(true);
      return;
    }

    this.chatView.addUser(trimmed);
    this.queue.push(trimmed);
    this.chatView.setStatus(
      "running",
      this.queue.length,
      this.projectedContextTokens,
    );
    if (!this.processing) {
      this.processing = this.processQueue().finally(() => {
        this.processing = null;
      });
    }
    return this.processing;
  }

  interrupt(): boolean {
    if (!this.currentAbort || this.currentAbort.signal.aborted) return false;
    this.cancelledQueueCount = this.queue.length;
    this.queue.length = 0;
    this.chatView?.setStatus("interrupting", 0, this.projectedContextTokens);
    this.currentAbort.abort();
    this.tui.requestRender();
    return true;
  }

  async applyConfig(config: AgentConfig): Promise<void> {
    const client = this.createClientImpl(config);
    await this.saveConfigImpl(config);
    this.config = config;
    this.client = client;
    this.contextWindow = guessContextWindow(config.model);
    if (this.chatView) {
      this.chatView.setConfig(config, this.contextWindow);
      this.chatView.setStatus(
        this.processing ? "running" : "ready",
        this.queue.length,
        this.projectedContextTokens,
      );
    } else {
      this.activateChat(config, client);
    }
  }

  closeSettings(): void {
    this.settingsOverlay?.hide();
    this.settingsOverlay = undefined;
    this.settingsView?.dispose();
    this.settingsView = undefined;
    this.settingsController = undefined;
    this.firstRunSettings = false;
    if (this.chatView) this.tui.setFocus(this.chatView.editor);
    this.tui.requestRender(true);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    this.currentAbort?.abort();
    this.removeInputListener?.();
    this.removeInputListener = undefined;
    this.settingsView?.dispose();
    this.tui.stop();
    this.onExit?.();
  }

  private activateChat(config: AgentConfig, client?: OpenAI): void {
    this.client = client ?? this.createClientImpl(config);
    this.contextWindow = guessContextWindow(config.model);
    if (!this.chatView) {
      this.chatView = new ChatView(this.tui, config, this.contextWindow, {
        onSubmit: (input) => void this.submit(input),
      });
    } else {
      this.chatView.setConfig(config, this.contextWindow);
    }
    this.tui.clear();
    this.tui.addChild(this.chatView);
    this.tui.setFocus(this.chatView.editor);
    this.tui.requestRender(true);
  }

  private openSettings(firstRun: boolean): void {
    if (this.settingsView) return;
    this.firstRunSettings = firstRun || !this.config;
    const controller = new SettingsController({
      initialConfig: this.config,
      seed: this.config ?? this.configSeed,
      initialError: this.config ? undefined : this.configError,
      discoverModels: this.discoverModelsImpl,
      onComplete: async (config) => {
        await this.applyConfig(config);
        this.closeSettings();
      },
      onCancel: () => {
        if (this.firstRunSettings && !this.config) this.stop();
        else this.closeSettings();
      },
    });
    const view = new SettingsView(this.tui, controller);
    this.settingsController = controller;
    this.settingsView = view;

    if (this.chatView && !this.firstRunSettings) {
      this.settingsOverlay = this.tui.showOverlay(view, {
        width: "80%",
        minWidth: 40,
        maxHeight: "80%",
        anchor: "center",
        margin: 1,
      });
      this.settingsOverlay.focus();
    } else {
      this.tui.clear();
      this.tui.addChild(view);
      this.tui.setFocus(view);
    }
    this.tui.requestRender(true);
  }

  private async processQueue(): Promise<void> {
    while (this.queue.length > 0 && !this.stopped) {
      const input = this.queue.shift()!;
      const config = this.config;
      const client = this.client;
      if (!config || !client || !this.chatView) return;
      this.chatView.setStatus(
        "running",
        this.queue.length,
        this.projectedContextTokens,
      );
      let terminalEventSeen = false;
      const abortController = new AbortController();
      this.currentAbort = abortController;
      const runOptions: RunOptions = {
        client,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
        recentRawToolActions: config.recentRawToolActions,
        toolOutputSafetyLimit: config.toolOutputSafetyLimit,
        contextWindow: this.contextWindow,
        messages: this.messages,
        skillsInjected: this.skillsInjected,
        lastUsage: this.lastUsage,
        signal: abortController.signal,
        onEvent: (event) => {
          if (event.type === "error" || event.type === "interrupted") {
            terminalEventSeen = true;
          }
          this.handleAgentEvent(event, config.apiKey);
        },
      };

      try {
        await this.runAgentImpl(runOptions, input);
      } catch (error) {
        if (abortController.signal.aborted) {
          if (!terminalEventSeen) {
            this.chatView.addInterrupted(this.cancelledQueueCount);
          }
        } else if (!terminalEventSeen) {
          const message = error instanceof Error ? error.message : String(error);
          this.chatView.addError(redact(message, config.apiKey));
        }
      } finally {
        if (this.currentAbort === abortController) this.currentAbort = undefined;
        this.cancelledQueueCount = 0;
        this.skillsInjected = runOptions.skillsInjected ?? this.skillsInjected;
        this.lastUsage = runOptions.lastUsage;
      }
    }

    if (this.chatView && !this.stopped) {
      this.chatView.setStatus("ready", 0, this.projectedContextTokens);
      this.tui.setFocus(this.chatView.editor);
      this.tui.requestRender();
    }
  }

  private handleAgentEvent(event: AgentEvent, apiKey: string): void {
    const chat = this.chatView;
    if (!chat) return;
    switch (event.type) {
      case "run-start":
        return;
      case "context-projection":
        this.projectedContextTokens = event.estimatedTokens;
        chat.setStatus("running", this.queue.length, this.projectedContextTokens);
        return;
      case "tool-start":
        chat.addToolStart(event.id, event.name, event.command);
        return;
      case "tool-complete":
        chat.completeTool(event.id, event.output, event.exitCode);
        return;
      case "compression":
        chat.addCompression(event.before, event.after, event.eliminatedTokens);
        return;
      case "assistant-complete":
        chat.addAssistant(event.content);
        return;
      case "interrupted":
        chat.addInterrupted(this.cancelledQueueCount);
        this.cancelledQueueCount = 0;
        return;
      case "error":
        chat.addError(redact(event.message, apiKey));
    }
  }
}

function redact(message: string, secret: string): string {
  return secret ? message.replaceAll(secret, "[redacted]") : message;
}
