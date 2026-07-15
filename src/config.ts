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

export interface AgentConfig {
  version: 1;
  provider: ProviderId;
  apiKey: string;
  baseURL?: string;
  model: string;
  reasoningEffort: ReasoningEffort;
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

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "설정 안 됨";
  if (apiKey.length <= 4) return "••••";
  return `••••${apiKey.slice(-4)}`;
}

export function environmentConfigSeed(
  env: Record<string, string | undefined> = process.env,
): Partial<AgentConfig> {
  if (env.INLINE_BASE_URL) {
    return {
      provider: "custom",
      apiKey: env.INLINE_API_KEY ?? env.OPENAI_API_KEY ?? env.ZAI_API_KEY ?? "",
      baseURL: env.INLINE_BASE_URL,
      model: env.INLINE_MODEL ?? "gpt-5",
      reasoningEffort: "high",
    };
  }
  if (env.ZAI_API_KEY) {
    return {
      provider: "zai",
      apiKey: env.ZAI_API_KEY,
      model: env.INLINE_MODEL ?? "glm-5.2",
      reasoningEffort: "high",
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      apiKey: env.OPENAI_API_KEY,
      model: env.INLINE_MODEL ?? "gpt-5",
      reasoningEffort: "high",
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
