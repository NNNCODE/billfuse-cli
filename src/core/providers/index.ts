import {
  fetchAnthropicCosts,
  fetchAnthropicTokens,
  validateAnthropicKey,
} from "./anthropic";
import {
  fetchGeminiCosts,
  fetchGeminiTokens,
  validateGeminiKey,
} from "./gemini";
import type { FetchLike } from "./http";
import {
  fetchOpenAiCosts,
  fetchOpenAiTokens,
  validateOpenAiKey,
} from "./openai";
import {
  fetchOpenRouterCosts,
  fetchOpenRouterTokens,
  validateOpenRouterKey,
} from "./openrouter";
import type { DailyCost, DailyTokens, Provider } from "./types";
import { fetchXaiCosts, fetchXaiTokens, validateXaiKey } from "./xai";

type ProviderApi = {
  costs: (key: string, start: Date, f?: FetchLike) => Promise<DailyCost[]>;
  tokens: (key: string, start: Date, f?: FetchLike) => Promise<DailyTokens[]>;
  validate: (key: string, f?: FetchLike) => Promise<void>;
};

// 每家服务商的三个接口。加新服务商时 TypeScript 会提醒这里漏了哪家
const APIS: Record<Provider, ProviderApi> = {
  openai: {
    costs: fetchOpenAiCosts,
    tokens: fetchOpenAiTokens,
    validate: validateOpenAiKey,
  },
  anthropic: {
    costs: fetchAnthropicCosts,
    tokens: fetchAnthropicTokens,
    validate: validateAnthropicKey,
  },
  openrouter: {
    costs: fetchOpenRouterCosts,
    tokens: fetchOpenRouterTokens,
    validate: validateOpenRouterKey,
  },
  gemini: {
    costs: fetchGeminiCosts,
    tokens: fetchGeminiTokens,
    validate: validateGeminiKey,
  },
  xai: {
    costs: fetchXaiCosts,
    tokens: fetchXaiTokens,
    validate: validateXaiKey,
  },
};

export function fetchDailyCosts(
  provider: Provider,
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyCost[]> {
  return APIS[provider].costs(key, start, fetchImpl);
}

export function fetchDailyTokens(
  provider: Provider,
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyTokens[]> {
  return APIS[provider].tokens(key, start, fetchImpl);
}

export function validateProviderKey(
  provider: Provider,
  key: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  return APIS[provider].validate(key, fetchImpl);
}
