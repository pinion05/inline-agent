import OpenAI, { type ClientOptions } from "openai";

import type {
  AgentConfig,
  ProviderId,
  ReasoningEffort,
} from "./config.js";
import {
  createObservableFetch,
  type HttpRequestCapture,
} from "./http-observer.js";

export interface ProviderDefinition {
  id: ProviderId;
  label: string;
  baseURL?: string;
  defaultModel: string;
  reasoningEfforts: ReasoningEffort[];
  defaultReasoningEffort: ReasoningEffort;
}

export type ModelDiscoveryResult =
  | { status: "success"; models: string[] }
  | { status: "auth-error"; message: string }
  | { status: "fallback"; message: string };

const OPENAI_REASONING: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const PROVIDERS: Record<ProviderId, ProviderDefinition> = {
  zai: {
    id: "zai",
    label: "Z.AI Coding Plan",
    baseURL: "https://api.z.ai/api/coding/paas/v4",
    defaultModel: "glm-5.2",
    reasoningEfforts: [...OPENAI_REASONING, "max"],
    defaultReasoningEffort: "high",
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    defaultModel: "gpt-5",
    reasoningEfforts: [...OPENAI_REASONING],
    defaultReasoningEffort: "high",
  },
  custom: {
    id: "custom",
    label: "Custom OpenAI-compatible",
    defaultModel: "gpt-5",
    reasoningEfforts: [...OPENAI_REASONING],
    defaultReasoningEffort: "high",
  },
};

export function guessContextWindow(model: string): number {
  const normalized = model.toLowerCase();
  if (normalized.includes("glm-5")) return 1_000_000;
  if (normalized.includes("gpt-5")) return 400_000;
  if (normalized.includes("opus")) return 500_000;
  if (normalized.includes("sonnet")) return 400_000;
  if (normalized.includes("gemini")) return 1_000_000;
  return 200_000;
}

export function providerDefinition(provider: ProviderId): ProviderDefinition {
  const definition = PROVIDERS[provider];
  return {
    ...definition,
    reasoningEfforts: [...definition.reasoningEfforts],
  };
}

type OpenAIOptions = ClientOptions;
type OpenAIFactory = (options: OpenAIOptions) => OpenAI;

export function createProviderClient(
  config: AgentConfig,
  factory: OpenAIFactory = (options) => new OpenAI(options),
  onFetch?: (capture: HttpRequestCapture) => void,
): OpenAI {
  const definition = providerDefinition(config.provider);
  const baseURL = config.provider === "custom"
    ? config.baseURL
    : definition.baseURL;
  const options: OpenAIOptions = {
    apiKey: config.apiKey,
    ...(baseURL ? { baseURL } : {}),
  };
  // When an observer sink is provided, wrap fetch so every HTTP attempt
  // (original + retries) is captured for the dashboard.
  if (onFetch) {
    options.fetch = createObservableFetch(onFetch) as ClientOptions["fetch"];
  }
  return factory(options);
}

export async function listProviderModels(
  config: AgentConfig,
  client: Pick<OpenAI, "models"> = createProviderClient(config),
): Promise<ModelDiscoveryResult> {
  try {
    const response = await client.models.list();
    const models = [...new Set(
      response.data
        .map((model) => model.id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    )].sort((left, right) => left.localeCompare(right));

    if (models.length === 0) {
      return {
        status: "fallback",
        message: "모델 목록이 비어 있습니다. 모델 ID를 직접 입력하세요.",
      };
    }
    return { status: "success", models };
  } catch (error) {
    const status = typeof (error as { status?: unknown }).status === "number"
      ? (error as { status: number }).status
      : undefined;
    if (status === 401 || status === 403) {
      return {
        status: "auth-error",
        message: "Provider 인증에 실패했습니다. API Key를 확인하세요.",
      };
    }

    return {
      status: "fallback",
      message: `모델 목록을 불러오지 못했습니다. 직접 입력할 수 있습니다: ${sanitizedError(error, config.apiKey)}`,
    };
  }
}

function sanitizedError(error: unknown, apiKey: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return apiKey ? message.replaceAll(apiKey, "[redacted]") : message;
}
