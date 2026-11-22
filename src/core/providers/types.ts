export const PROVIDERS = [
  "openai",
  "anthropic",
  "openrouter",
  "gemini",
  "xai",
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABEL: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  gemini: "Gemini",
  xai: "xAI",
};

// 这家的接口会不会返回当天（还没过完的 UTC 日）的花费。OpenRouter 只给已经过完的日子，
// Gemini 的花费来自 Google Cloud 账单导出，通常要一天左右才完整，
// 所以算"预计月底"时它们的天数要少算今天，否则月初会被低估一半以上。
// xAI 的用量接口能按小时分桶，CodexBar 也显示当天的花费，所以当作当天就报（没在真实账户上验证过，providers/xai.ts）
export const REPORTS_TODAY: Record<Provider, boolean> = {
  openai: true,
  anthropic: true,
  openrouter: false,
  gemini: false,
  xai: true,
};

export function isProvider(value: unknown): value is Provider {
  return PROVIDERS.includes(value as Provider);
}

// 一天里一个计费项的花费（美元）。日期是 UTC 的 YYYY-MM-DD，和各家接口的分桶方式一致
export type DailyCost = {
  date: string;
  lineItem: string;
  model: string;
  costUsd: number;
};

// 一天里一个模型的 token 用量。各家字段不同，统一成这几项
export type DailyTokens = {
  date: string;
  model: string;
  // 全部输入（含缓存命中和写缓存）
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  // Anthropic 不提供请求次数
  requests: number | null;
};

// 同一天同一模型可能分散在多条结果里（翻页、或接口按其他维度拆开），合并成一条
export function aggregateTokens(rows: DailyTokens[]): DailyTokens[] {
  const merged = new Map<string, DailyTokens>();
  for (const row of rows) {
    const key = `${row.date}|${row.model}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...row });
      continue;
    }
    existing.inputTokens += row.inputTokens;
    existing.cachedInputTokens += row.cachedInputTokens;
    existing.outputTokens += row.outputTokens;
    existing.requests =
      existing.requests === null && row.requests === null
        ? null
        : (existing.requests ?? 0) + (row.requests ?? 0);
  }
  return [...merged.values()];
}

export type ProviderErrorKind =
  "invalid_key" | "forbidden" | "rate_limited" | "upstream" | "network";

// message 会直接显示给用户，所以要写成用户能看懂、知道下一步做什么的句子
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: ProviderErrorKind,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
