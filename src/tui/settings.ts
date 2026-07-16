import {
  Container,
  CURSOR_MARKER,
  Input,
  decodeKittyPrintable,
  Key,
  SelectList,
  Spacer,
  Text,
  isFocusable,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";

import {
  DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE,
  DEFAULT_RECENT_RAW_TOOL_ACTIONS,
  DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT,
  MAX_MAX_TOOL_CALLS_PER_RESPONSE,
  MAX_RECENT_RAW_TOOL_ACTIONS,
  MAX_TOOL_OUTPUT_SAFETY_LIMIT,
  MIN_MAX_TOOL_CALLS_PER_RESPONSE,
  MIN_RECENT_RAW_TOOL_ACTIONS,
  MIN_TOOL_OUTPUT_SAFETY_LIMIT,
  formatCharacterLimit,
  maskApiKey,
  parseCharacterLimit,
  type AgentConfig,
  type ProviderId,
  type ReasoningEffort,
} from "../config.js";
import {
  providerDefinition,
  type ModelDiscoveryResult,
} from "../provider.js";
import { tuiTheme } from "./theme.js";

export type SettingsStep =
  | "menu"
  | "provider"
  | "api-key"
  | "base-url"
  | "loading-models"
  | "model"
  | "model-input"
  | "reasoning"
  | "raw-actions"
  | "raw-actions-input"
  | "safety-limit"
  | "safety-limit-input"
  | "max-tool-calls"
  | "max-tool-calls-input"
  | "confirm"
  | "saving"
  | "done";

export interface SettingsState {
  step: SettingsStep;
  models: string[];
  error?: string;
  warning?: string;
}

export interface SettingsDraft {
  provider: ProviderId;
  apiKey: string;
  baseURL?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  recentRawToolActions: number;
  toolOutputSafetyLimit: number;
  maxToolCallsPerResponse: number;
}

interface SettingsControllerOptions {
  initialConfig?: AgentConfig;
  seed?: Partial<AgentConfig>;
  initialError?: string;
  discoverModels: (config: AgentConfig) => Promise<ModelDiscoveryResult>;
  onComplete: (config: AgentConfig) => Promise<void> | void;
  onCancel?: () => void;
}

export class SettingsController {
  state: SettingsState = { step: "provider", models: [] };
  readonly draft: SettingsDraft;

  private readonly options: SettingsControllerOptions;
  private readonly listeners = new Set<() => void>();
  private returnToMenuAfterEdit = false;

  constructor(options: SettingsControllerOptions) {
    this.options = options;
    this.state = {
      step: options.initialConfig ? "menu" : "provider",
      models: [],
      ...(options.initialError ? { error: options.initialError } : {}),
    };
    const source = options.initialConfig ?? options.seed ?? {};
    const provider = source.provider ?? "zai";
    const definition = providerDefinition(provider);
    this.draft = {
      provider,
      apiKey: source.apiKey ?? "",
      ...(source.baseURL ? { baseURL: source.baseURL } : {}),
      model: source.model ?? definition.defaultModel,
      reasoningEffort: source.reasoningEffort ?? "high",
      recentRawToolActions: source.recentRawToolActions
        ?? DEFAULT_RECENT_RAW_TOOL_ACTIONS,
      toolOutputSafetyLimit: source.toolOutputSafetyLimit
        ?? DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT,
      maxToolCallsPerResponse: source.maxToolCallsPerResponse
        ?? DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE,
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startProviderSetup(): void {
    this.returnToMenuAfterEdit = false;
    this.setState({ step: "provider", models: [] });
  }

  editReasoning(): void {
    this.returnToMenuAfterEdit = true;
    this.setState({ step: "reasoning", models: this.state.models });
  }

  editRecentRawToolActions(): void {
    this.returnToMenuAfterEdit = true;
    this.setState({ step: "raw-actions", models: this.state.models });
  }

  editToolOutputSafetyLimit(): void {
    this.returnToMenuAfterEdit = true;
    this.setState({ step: "safety-limit", models: this.state.models });
  }

  editMaxToolCallsPerResponse(): void {
    this.returnToMenuAfterEdit = true;
    this.setState({ step: "max-tool-calls", models: this.state.models });
  }

  selectProvider(provider: ProviderId): void {
    const changed = provider !== this.draft.provider;
    const definition = providerDefinition(provider);
    this.draft.provider = provider;
    this.draft.reasoningEffort = "high";
    if (changed) {
      this.draft.apiKey = "";
      this.draft.model = definition.defaultModel;
      delete this.draft.baseURL;
    }
    this.setState({ step: "api-key", models: [] });
  }

  async submitApiKey(value: string): Promise<void> {
    const apiKey = value || this.draft.apiKey;
    if (!apiKey) {
      this.setState({
        ...this.state,
        step: "api-key",
        error: "API Key를 입력하세요.",
      });
      return;
    }
    this.draft.apiKey = apiKey;
    if (this.draft.provider === "custom") {
      this.setState({ step: "base-url", models: [] });
      return;
    }
    await this.discover();
  }

  async submitBaseURL(value: string): Promise<void> {
    try {
      this.draft.baseURL = new URL(value).toString().replace(/\/$/, "");
    } catch {
      this.setState({
        ...this.state,
        step: "base-url",
        error: "올바른 Base URL을 입력하세요.",
      });
      return;
    }
    await this.discover();
  }

  selectModel(model: string): void {
    if (!model) return;
    this.draft.model = model;
    this.setState({ step: "reasoning", models: this.state.models });
  }

  chooseDirectModel(): void {
    this.setState({
      step: "model-input",
      models: this.state.models,
      warning: this.state.warning,
    });
  }

  submitModel(model: string): void {
    if (!model.trim()) {
      this.setState({
        ...this.state,
        step: "model-input",
        error: "모델 ID를 입력하세요.",
      });
      return;
    }
    this.draft.model = model.trim();
    this.setState({ step: "reasoning", models: this.state.models });
  }

  availableReasoningEfforts(): ReasoningEffort[] {
    return providerDefinition(this.draft.provider).reasoningEfforts;
  }

  selectReasoning(reasoningEffort: ReasoningEffort): void {
    if (!this.availableReasoningEfforts().includes(reasoningEffort)) return;
    this.draft.reasoningEffort = reasoningEffort;
    if (this.finishMenuEdit()) return;
    this.setState({ step: "raw-actions", models: this.state.models });
  }

  selectRecentRawToolActions(value: number): void {
    if (
      !Number.isInteger(value)
      || value < MIN_RECENT_RAW_TOOL_ACTIONS
      || value > MAX_RECENT_RAW_TOOL_ACTIONS
    ) return;
    this.draft.recentRawToolActions = value;
    if (this.finishMenuEdit()) return;
    this.setState({ step: "safety-limit", models: this.state.models });
  }

  chooseCustomRecentRawToolActions(): void {
    this.setState({ step: "raw-actions-input", models: this.state.models });
  }

  submitRecentRawToolActions(value: string): void {
    const parsed = Number(value.trim());
    if (
      !Number.isInteger(parsed)
      || parsed < MIN_RECENT_RAW_TOOL_ACTIONS
      || parsed > MAX_RECENT_RAW_TOOL_ACTIONS
    ) {
      this.setState({
        step: "raw-actions-input",
        models: this.state.models,
        error: `최근 raw actions는 ${MIN_RECENT_RAW_TOOL_ACTIONS}–${MAX_RECENT_RAW_TOOL_ACTIONS} 사이여야 합니다.`,
      });
      return;
    }
    this.selectRecentRawToolActions(parsed);
  }

  selectToolOutputSafetyLimit(value: number): void {
    if (
      !Number.isInteger(value)
      || value < MIN_TOOL_OUTPUT_SAFETY_LIMIT
      || value > MAX_TOOL_OUTPUT_SAFETY_LIMIT
    ) return;
    this.draft.toolOutputSafetyLimit = value;
    if (this.finishMenuEdit()) return;
    this.setState({ step: "max-tool-calls", models: this.state.models });
  }

  chooseCustomToolOutputSafetyLimit(): void {
    this.setState({ step: "safety-limit-input", models: this.state.models });
  }

  submitToolOutputSafetyLimit(value: string): void {
    const parsed = parseCharacterLimit(value);
    if (
      parsed === undefined
      || parsed < MIN_TOOL_OUTPUT_SAFETY_LIMIT
      || parsed > MAX_TOOL_OUTPUT_SAFETY_LIMIT
    ) {
      this.setState({
        step: "safety-limit-input",
        models: this.state.models,
        error: "단일 출력 상한은 4K–1M 사이여야 합니다.",
      });
      return;
    }
    this.selectToolOutputSafetyLimit(parsed);
  }

  selectMaxToolCallsPerResponse(value: number): void {
    if (
      !Number.isInteger(value)
      || value < MIN_MAX_TOOL_CALLS_PER_RESPONSE
      || value > MAX_MAX_TOOL_CALLS_PER_RESPONSE
    ) return;
    this.draft.maxToolCallsPerResponse = value;
    if (this.finishMenuEdit()) return;
    this.setState({ step: "confirm", models: this.state.models });
  }

  chooseCustomMaxToolCallsPerResponse(): void {
    this.setState({ step: "max-tool-calls-input", models: this.state.models });
  }

  submitMaxToolCallsPerResponse(value: string): void {
    const parsed = Number(value.trim());
    if (
      !Number.isInteger(parsed)
      || parsed < MIN_MAX_TOOL_CALLS_PER_RESPONSE
      || parsed > MAX_MAX_TOOL_CALLS_PER_RESPONSE
    ) {
      this.setState({
        step: "max-tool-calls-input",
        models: this.state.models,
        error: `응답당 최대 tool calls는 ${MIN_MAX_TOOL_CALLS_PER_RESPONSE}–${MAX_MAX_TOOL_CALLS_PER_RESPONSE} 사이여야 합니다.`,
      });
      return;
    }
    this.selectMaxToolCallsPerResponse(parsed);
  }

  backToMaxToolCalls(): void {
    this.setState({ step: "max-tool-calls", models: this.state.models });
  }

  async confirm(): Promise<void> {
    const config = this.toConfig();
    const failureStep: SettingsStep = this.state.step === "menu"
      ? "menu"
      : "confirm";
    this.setState({ step: "saving", models: this.state.models });
    try {
      await this.options.onComplete(config);
      this.setState({ step: "done", models: this.state.models });
    } catch (error) {
      this.setState({
        step: failureStep,
        models: this.state.models,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  cancel(): void {
    this.options.onCancel?.();
  }

  private finishMenuEdit(): boolean {
    if (!this.returnToMenuAfterEdit) return false;
    this.returnToMenuAfterEdit = false;
    this.setState({ step: "menu", models: this.state.models });
    return true;
  }

  private async discover(): Promise<void> {
    this.setState({ step: "loading-models", models: [] });
    const result = await this.options.discoverModels(this.toConfig());
    if (result.status === "auth-error") {
      this.setState({
        step: "api-key",
        models: [],
        error: result.message,
      });
      return;
    }
    if (result.status === "fallback") {
      this.setState({
        step: "model-input",
        models: [],
        warning: result.message,
      });
      return;
    }
    this.setState({ step: "model", models: result.models });
  }

  private toConfig(): AgentConfig {
    return {
      version: 1,
      provider: this.draft.provider,
      apiKey: this.draft.apiKey,
      ...(this.draft.provider === "custom" && this.draft.baseURL
        ? { baseURL: this.draft.baseURL }
        : {}),
      model: this.draft.model,
      reasoningEffort: this.draft.reasoningEffort,
      recentRawToolActions: this.draft.recentRawToolActions,
      toolOutputSafetyLimit: this.draft.toolOutputSafetyLimit,
      maxToolCallsPerResponse: this.draft.maxToolCallsPerResponse,
    };
  }

  private setState(state: SettingsState): void {
    this.state = state;
    for (const listener of this.listeners) listener();
  }
}

export class SettingsView implements Component, Focusable {
  private readonly root = new Container();
  private active: Component | null = null;
  private unsubscribe: () => void;
  private _focused = false;

  constructor(
    private readonly tui: TUI,
    private readonly controller: SettingsController,
  ) {
    this.unsubscribe = controller.subscribe(() => {
      this.rebuild();
      this.tui.requestRender();
    });
    this.rebuild();
  }

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    if (isFocusable(this.active)) this.active.focused = value;
  }

  render(width: number): string[] { return this.root.render(width); }
  invalidate(): void { this.root.invalidate(); }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.controller.cancel();
      return;
    }
    this.active?.handleInput?.(data);
    this.tui.requestRender();
  }

  dispose(): void { this.unsubscribe(); }

  private rebuild(): void {
    this.root.clear();
    this.root.addChild(new Text(
      tuiTheme.bold(tuiTheme.accent("inline-agent settings")),
      1,
      0,
    ));
    const provider = providerDefinition(this.controller.draft.provider).label;
    this.root.addChild(new Text(
      tuiTheme.muted(
        `${provider} │ ${this.controller.draft.model} │ reasoning ${this.controller.draft.reasoningEffort} │ raw ${this.controller.draft.recentRawToolActions} │ limit ${formatCharacterLimit(this.controller.draft.toolOutputSafetyLimit)} │ calls ${this.controller.draft.maxToolCallsPerResponse} │ max raw ${formatApproximateCharacters(MAX_RECENT_RAW_TOOL_ACTIONS * this.controller.draft.toolOutputSafetyLimit)} │ key ${maskApiKey(this.controller.draft.apiKey)}`,
      ),
      1,
      0,
    ));
    if (this.controller.state.error) {
      this.root.addChild(new Text(tuiTheme.error(this.controller.state.error), 1, 0));
    }
    if (this.controller.state.warning) {
      this.root.addChild(new Text(tuiTheme.warning(this.controller.state.warning), 1, 0));
    }
    this.root.addChild(new Spacer(1));

    this.active = this.createActiveComponent();
    if (isFocusable(this.active)) this.active.focused = this._focused;
    this.root.addChild(this.active);
    this.root.addChild(new Spacer(1));
    this.root.addChild(new Text(
      tuiTheme.muted("↑↓ navigate │ enter select │ esc cancel"),
      1,
      0,
    ));
  }

  private createActiveComponent(): Component {
    switch (this.controller.state.step) {
      case "menu":
        return this.selector(
          "변경할 설정을 선택하세요",
          [
            { value: "provider", label: "Provider / API Key / Model" },
            {
              value: "reasoning",
              label: `Reasoning: ${this.controller.draft.reasoningEffort}`,
            },
            {
              value: "raw-actions",
              label: `Raw tool actions: ${this.controller.draft.recentRawToolActions}`,
            },
            {
              value: "safety-limit",
              label: `Output safety limit: ${formatCharacterLimit(this.controller.draft.toolOutputSafetyLimit)}`,
            },
            {
              value: "max-tool-calls",
              label: `Max tool calls per response: ${this.controller.draft.maxToolCallsPerResponse}`,
            },
            { value: "save", label: "저장 및 적용" },
            { value: "cancel", label: "취소" },
          ],
          (value) => {
            if (value === "provider") this.controller.startProviderSetup();
            else if (value === "reasoning") this.controller.editReasoning();
            else if (value === "raw-actions") {
              this.controller.editRecentRawToolActions();
            } else if (value === "safety-limit") {
              this.controller.editToolOutputSafetyLimit();
            } else if (value === "max-tool-calls") {
              this.controller.editMaxToolCallsPerResponse();
            } else if (value === "save") void this.controller.confirm();
            else this.controller.cancel();
          },
        );
      case "provider":
        return this.selector(
          "Provider를 선택하세요",
          [
            { value: "zai", label: "Z.AI Coding Plan" },
            { value: "openai", label: "OpenAI" },
            { value: "custom", label: "Custom OpenAI-compatible" },
          ],
          (value) => this.controller.selectProvider(value as ProviderId),
        );
      case "api-key": {
        const input = new SecretInput();
        input.onSubmit = (value) => void this.controller.submitApiKey(value);
        return this.inputGroup(
          `API Key를 입력하세요 (${maskApiKey(this.controller.draft.apiKey)} · 빈 값은 기존 키 유지)`,
          input,
        );
      }
      case "base-url": {
        const input = new Input();
        input.setValue(this.controller.draft.baseURL ?? "");
        input.onSubmit = (value) => void this.controller.submitBaseURL(value);
        return this.inputGroup("OpenAI-compatible Base URL을 입력하세요", input);
      }
      case "loading-models":
        return new Text(tuiTheme.warning("◌ 인증 확인 및 모델 목록 조회 중..."), 1, 0);
      case "model":
        return this.selector(
          "모델을 선택하세요",
          [
            { value: "__direct__", label: "모델 ID 직접 입력" },
            ...this.controller.state.models.map((model) => ({ value: model, label: model })),
          ],
          (value) => value === "__direct__"
            ? this.controller.chooseDirectModel()
            : this.controller.selectModel(value),
          true,
        );
      case "model-input": {
        const input = new Input();
        input.setValue(this.controller.draft.model);
        input.onSubmit = (value) => this.controller.submitModel(value);
        return this.inputGroup("모델 ID를 직접 입력하세요", input);
      }
      case "reasoning":
        return this.selector(
          "reasoning_effort를 선택하세요",
          this.controller.availableReasoningEfforts().map((effort) => ({
            value: effort,
            label: effort,
          })),
          (value) => this.controller.selectReasoning(value as ReasoningEffort),
        );
      case "raw-actions":
        return this.selector(
          "최근 몇 개 tool action을 원문으로 보존할까요?",
          [1, 2, 3, 5, 10, 20].map((value) => ({
            value: String(value),
            label: `${value} actions`,
          })).concat([{ value: "custom", label: "직접 입력 (1–20)" }]),
          (value) => value === "custom"
            ? this.controller.chooseCustomRecentRawToolActions()
            : this.controller.selectRecentRawToolActions(Number(value)),
        );
      case "raw-actions-input": {
        const input = new Input();
        input.setValue(String(this.controller.draft.recentRawToolActions));
        input.onSubmit = (value) => this.controller.submitRecentRawToolActions(value);
        return this.inputGroup("최근 raw actions를 입력하세요 (1–20)", input);
      }
      case "safety-limit":
        return this.selector(
          "단일 shell 출력 안전 상한을 선택하세요",
          [4 * 1024, 16 * 1024, 64 * 1024, 256 * 1024, 1024 * 1024]
            .map((value) => ({
              value: String(value),
              label: formatCharacterLimit(value),
            }))
            .concat([{ value: "custom", label: "직접 입력 (4K–1M)" }]),
          (value) => value === "custom"
            ? this.controller.chooseCustomToolOutputSafetyLimit()
            : this.controller.selectToolOutputSafetyLimit(Number(value)),
        );
      case "safety-limit-input": {
        const input = new Input();
        input.setValue(formatCharacterLimit(this.controller.draft.toolOutputSafetyLimit));
        input.onSubmit = (value) => this.controller.submitToolOutputSafetyLimit(value);
        return this.inputGroup("출력 상한을 입력하세요 (예: 65536, 64K, 1M)", input);
      }
      case "max-tool-calls":
        return this.selector(
          "한 assistant 응답의 최대 shell tool call 수를 선택하세요",
          [1, 2, 3, 5, 10, 20, 50, 100]
            .map((value) => ({
              value: String(value),
              label: `${value} calls`,
            }))
            .concat([{ value: "custom", label: "직접 입력 (1–100)" }]),
          (value) => value === "custom"
            ? this.controller.chooseCustomMaxToolCallsPerResponse()
            : this.controller.selectMaxToolCallsPerResponse(Number(value)),
        );
      case "max-tool-calls-input": {
        const input = new Input();
        input.setValue(String(this.controller.draft.maxToolCallsPerResponse));
        input.onSubmit = (value) => (
          this.controller.submitMaxToolCallsPerResponse(value)
        );
        return this.inputGroup("응답당 최대 tool calls를 입력하세요 (1–100)", input);
      }
      case "confirm":
        return this.selector(
          "이 설정을 저장하고 적용할까요?",
          [
            { value: "save", label: "저장 및 적용" },
            { value: "back", label: "최대 tool calls 다시 선택" },
          ],
          (value) => value === "save"
            ? void this.controller.confirm()
            : this.controller.backToMaxToolCalls(),
        );
      case "saving":
        return new Text(tuiTheme.warning("◌ 설정 저장 중..."), 1, 0);
      case "done":
        return new Text(tuiTheme.success("✓ 설정이 적용되었습니다."), 1, 0);
    }
  }

  private selector(
    title: string,
    items: SelectItem[],
    onSelect: (value: string) => void,
    searchable = false,
  ): Component {
    const container = new Container();
    container.addChild(new Text(tuiTheme.text(title), 1, 0));
    const list = new SelectList(items, Math.min(items.length, 12), tuiTheme.selectList);
    list.onSelect = (item) => onSelect(item.value);
    list.onCancel = () => this.controller.cancel();
    const control: Component = searchable ? new SearchableSelect(list) : list;
    container.addChild(control);
    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => control.handleInput?.(data),
    };
  }

  private inputGroup(title: string, input: Component): Component {
    const container = new Container();
    container.addChild(new Text(tuiTheme.text(title), 1, 0));
    container.addChild(input);
    return {
      get focused() {
        return isFocusable(input) ? input.focused : false;
      },
      set focused(value: boolean) {
        if (isFocusable(input)) input.focused = value;
      },
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => input.handleInput?.(data),
    } as Component & Focusable;
  }
}

function formatApproximateCharacters(value: number): string {
  if (value >= 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(2).replace(/\.00$/, "")}M chars`;
  }
  if (value >= 1024) return `${Math.round(value / 1024)}K chars`;
  return `${value} chars`;
}

class SearchableSelect implements Component {
  private query = "";

  constructor(private readonly list: SelectList) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.backspace)) {
      this.query = Array.from(this.query).slice(0, -1).join("");
      this.list.setFilter(this.query);
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.query = "";
      this.list.setFilter("");
      return;
    }
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.query += kittyPrintable;
      this.list.setFilter(this.query);
      return;
    }
    if (!data.includes("\x1b") && Array.from(data).every((char) => char >= " ")) {
      this.query += data;
      this.list.setFilter(this.query);
      return;
    }
    this.list.handleInput(data);
  }

  render(width: number): string[] {
    return [
      ...new Text(tuiTheme.muted(`search: ${this.query || "type to filter"}`), 1, 0).render(width),
      ...this.list.render(width),
    ];
  }

  invalidate(): void { this.list.invalidate(); }
}

class SecretInput implements Component, Focusable {
  focused = false;
  onSubmit?: (value: string) => void;
  private value = "";

  handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.onSubmit?.(this.value);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.value = Array.from(this.value).slice(0, -1).join("");
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.value = "";
      return;
    }
    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.value += kittyPrintable;
    } else if (!data.includes("\x1b") && Array.from(data).every((char) => char >= " ")) {
      this.value += data;
    }
  }

  render(width: number): string[] {
    const available = Math.max(0, width - 3);
    const bullets = "•".repeat(Math.min(Array.from(this.value).length, available));
    const cursor = this.focused ? CURSOR_MARKER : "";
    return [truncateToWidth(`> ${bullets}${cursor}\x1b[7m \x1b[27m`, width, "")];
  }

  invalidate(): void {}
}
