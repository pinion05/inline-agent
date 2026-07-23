import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type ProviderId = "zai" | "openai" | "custom";
export type ReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const DEFAULT_RECENT_RAW_TOOL_ACTIONS = 3;
export const MIN_RECENT_RAW_TOOL_ACTIONS = 1;
export const MAX_RECENT_RAW_TOOL_ACTIONS = 20;
export const DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT = 64 * 1024;
export const MIN_TOOL_OUTPUT_SAFETY_LIMIT = 4 * 1024;
export const MAX_TOOL_OUTPUT_SAFETY_LIMIT = 1024 * 1024;
export const DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE = 1;
export const MIN_MAX_TOOL_CALLS_PER_RESPONSE = 1;
export const MAX_MAX_TOOL_CALLS_PER_RESPONSE = 100;
export const DEFAULT_OPEN_BROWSER = true;

export interface AgentConfig {
  version: 1;
  provider: ProviderId;
  apiKey: string;
  baseURL?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  recentRawToolActions: number;
  toolOutputSafetyLimit: number;
  maxToolCallsPerResponse: number;
  openBrowser: boolean;
}

export type ConfigLoadResult =
  | { status: "missing" }
  | { status: "valid"; config: AgentConfig }
  | { status: "invalid"; error: string };

export const CONFIG_DIR = join(homedir(), ".inlineagent");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

const OPENAI_REASONING = new Set<ReasoningEffort>([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);
const ZAI_REASONING = new Set<ReasoningEffort>([
  ...OPENAI_REASONING,
  "max",
]);

export async function loadConfig(
  path: string = CONFIG_FILE,
): Promise<ConfigLoadResult> {
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "invalid", error: errorMessage(error) };
  }

  try {
    return { status: "valid", config: parseConfig(JSON.parse(source)) };
  } catch (error) {
    return { status: "invalid", error: errorMessage(error) };
  }
}

export async function saveConfig(
  config: AgentConfig,
  path: string = CONFIG_FILE,
): Promise<void> {
  const validated = parseConfig(config);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);

  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function parseCharacterLimit(value: string): number | undefined {
  const match = value.trim().match(/^(\d+)\s*([kKmM])?$/);
  if (!match) return undefined;
  const amount = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(amount)) return undefined;
  const multiplier = match[2]?.toLowerCase() === "m"
    ? 1024 * 1024
    : match[2]?.toLowerCase() === "k"
      ? 1024
      : 1;
  const result = amount * multiplier;
  return Number.isSafeInteger(result) ? result : undefined;
}

export function formatCharacterLimit(value: number): string {
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}M`;
  if (value % 1024 === 0) return `${value / 1024}K`;
  return value.toLocaleString("en-US");
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "설정 안 됨";
  if (apiKey.length <= 4) return "••••";
  return `••••${apiKey.slice(-4)}`;
}

export function environmentConfigSeed(
  env: Record<string, string | undefined> = process.env,
): Partial<AgentConfig> {
  const retention = {
    recentRawToolActions: DEFAULT_RECENT_RAW_TOOL_ACTIONS,
    toolOutputSafetyLimit: DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT,
    maxToolCallsPerResponse: DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE,
    openBrowser: DEFAULT_OPEN_BROWSER,
  };
  if (env.INLINE_BASE_URL) {
    return {
      provider: "custom",
      apiKey: env.INLINE_API_KEY ?? env.OPENAI_API_KEY ?? env.ZAI_API_KEY ?? "",
      baseURL: env.INLINE_BASE_URL,
      model: env.INLINE_MODEL ?? "gpt-5",
      reasoningEffort: "high",
      ...retention,
    };
  }
  if (env.ZAI_API_KEY) {
    return {
      provider: "zai",
      apiKey: env.ZAI_API_KEY,
      model: env.INLINE_MODEL ?? "glm-5.2",
      reasoningEffort: "high",
      ...retention,
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: env.OPENAI_API_KEY,
      model: env.INLINE_MODEL ?? "gpt-5",
      reasoningEffort: "high",
      ...retention,
    };
  }
  return {};
}

function parseConfig(value: unknown): AgentConfig {
  if (!isRecord(value)) throw new Error("config must be a JSON object");
  if (value.version !== 1) throw new Error("version must be 1");
  if (!isProvider(value.provider)) throw new Error("provider is invalid");
  if (typeof value.apiKey !== "string" || value.apiKey.length === 0) {
    throw new Error("apiKey must be a non-empty string");
  }
  if (typeof value.model !== "string" || value.model.trim().length === 0) {
    throw new Error("model must be a non-empty string");
  }
  if (typeof value.reasoningEffort !== "string") {
    throw new Error("reasoningEffort is invalid");
  }

  const allowed = value.provider === "zai" ? ZAI_REASONING : OPENAI_REASONING;
  if (!allowed.has(value.reasoningEffort as ReasoningEffort)) {
    throw new Error(
      `reasoningEffort ${JSON.stringify(value.reasoningEffort)} is not supported by ${value.provider}`,
    );
  }

  const recentRawToolActions = value.recentRawToolActions
    ?? DEFAULT_RECENT_RAW_TOOL_ACTIONS;
  if (
    typeof recentRawToolActions !== "number"
    || !Number.isInteger(recentRawToolActions)
    || recentRawToolActions < MIN_RECENT_RAW_TOOL_ACTIONS
    || recentRawToolActions > MAX_RECENT_RAW_TOOL_ACTIONS
  ) {
    throw new Error(
      `recentRawToolActions must be an integer from ${MIN_RECENT_RAW_TOOL_ACTIONS} to ${MAX_RECENT_RAW_TOOL_ACTIONS}`,
    );
  }

  const toolOutputSafetyLimit = value.toolOutputSafetyLimit
    ?? DEFAULT_TOOL_OUTPUT_SAFETY_LIMIT;
  if (
    typeof toolOutputSafetyLimit !== "number"
    || !Number.isInteger(toolOutputSafetyLimit)
    || toolOutputSafetyLimit < MIN_TOOL_OUTPUT_SAFETY_LIMIT
    || toolOutputSafetyLimit > MAX_TOOL_OUTPUT_SAFETY_LIMIT
  ) {
    throw new Error(
      `toolOutputSafetyLimit must be an integer from ${MIN_TOOL_OUTPUT_SAFETY_LIMIT} to ${MAX_TOOL_OUTPUT_SAFETY_LIMIT}`,
    );
  }

  const maxToolCallsPerResponse = value.maxToolCallsPerResponse
    ?? DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE;
  if (
    typeof maxToolCallsPerResponse !== "number"
    || !Number.isInteger(maxToolCallsPerResponse)
    || maxToolCallsPerResponse < MIN_MAX_TOOL_CALLS_PER_RESPONSE
    || maxToolCallsPerResponse > MAX_MAX_TOOL_CALLS_PER_RESPONSE
  ) {
    throw new Error(
      `maxToolCallsPerResponse must be an integer from ${MIN_MAX_TOOL_CALLS_PER_RESPONSE} to ${MAX_MAX_TOOL_CALLS_PER_RESPONSE}`,
    );
  }

  const openBrowser = value.openBrowser ?? DEFAULT_OPEN_BROWSER;
  if (typeof openBrowser !== "boolean") {
    throw new Error("openBrowser must be a boolean");
  }

  let baseURL: string | undefined;
  if (value.provider === "custom") {
    if (typeof value.baseURL !== "string" || value.baseURL.length === 0) {
      throw new Error("baseURL is required for a custom provider");
    }
    try {
      baseURL = new URL(value.baseURL).toString().replace(/\/$/, "");
    } catch {
      throw new Error("baseURL must be a valid URL");
    }
  }

  return {
    version: 1,
    provider: value.provider,
    apiKey: value.apiKey,
    ...(baseURL ? { baseURL } : {}),
    model: value.model.trim(),
    reasoningEffort: value.reasoningEffort as ReasoningEffort,
    recentRawToolActions,
    toolOutputSafetyLimit,
    maxToolCallsPerResponse,
    openBrowser,
  };
}

function isProvider(value: unknown): value is ProviderId {
  return value === "zai" || value === "openai" || value === "custom";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
