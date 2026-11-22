import { aggregateCosts, apiBase, getJson, type FetchLike } from "./http";
import {
  aggregateTokens,
  ProviderError,
  type DailyCost,
  type DailyTokens,
} from "./types";

// 官方文档：https://openrouter.ai/docs/api/api-reference/analytics/get-user-activity
// GET /api/v1/activity 返回最近 30 个"已经过完"的 UTC 日，按日期、模型、服务端点各一行；
// usage 是花掉的 OpenRouter 额度（美元）。只有管理密钥（management key）能读，普通 API 密钥返回 403。
// 当天还没过完，所以当天的花费第二天才有
function activityUrl() {
  const base = apiBase(
    process.env.OPENROUTER_API_BASE_URL,
    "https://openrouter.ai",
  );
  return `${base}/api/v1/activity`;
}

const KEY_HINT =
  "Billfuse needs an OpenRouter management key, created under Settings → Management keys. Regular API keys won't work.";
const FORBIDDEN =
  "This looks like a regular OpenRouter API key. Billfuse needs a management key: create one under Settings → Management keys.";

type ActivityRow = {
  date?: string | null;
  model?: string | null;
  usage?: number | null;
  requests?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_tokens?: number | null;
};

export type OpenRouterActivity = { data?: ActivityRow[] | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function rowsSince(body: OpenRouterActivity, start: Date): ActivityRow[] {
  const startDay = start.toISOString().slice(0, 10);
  return (body.data ?? []).filter(
    (r) => typeof r.date === "string" && DAY.test(r.date) && r.date >= startDay,
  );
}

const count = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;

// 同一模型经不同服务端点（不同底层服务商）调用会分成几行，这里按模型合并。
// 只算 usage（OpenRouter 收的钱）；byok_usage_inference 是用户自带密钥时由原服务商直接收的钱，
// 那部分如果用户也把原服务商接进了 Billfuse，会被算两遍，所以不算
export function parseOpenRouterCosts(
  body: OpenRouterActivity,
  start: Date,
): DailyCost[] {
  const rows: DailyCost[] = [];
  for (const r of rowsSince(body, start)) {
    if (typeof r.usage !== "number" || !Number.isFinite(r.usage)) continue;
    const model = r.model?.trim() || "Other";
    rows.push({ date: r.date!, lineItem: model, model, costUsd: r.usage });
  }
  return aggregateCosts(rows);
}

export function parseOpenRouterTokens(
  body: OpenRouterActivity,
  start: Date,
): DailyTokens[] {
  return aggregateTokens(
    rowsSince(body, start).map((r) => {
      const input = count(r.prompt_tokens);
      return {
        date: r.date!,
        model: r.model?.trim() || "Other",
        inputTokens: input,
        // 文档说缓存命中"一般是输入的一部分"，但重放响应缓存时可能比输入还多；不让它超过输入
        cachedInputTokens: Math.min(count(r.cached_tokens), input),
        outputTokens: count(r.completion_tokens),
        requests: count(r.requests),
      };
    }),
  );
}

function headers(key: string) {
  return { Authorization: `Bearer ${key}` };
}

// 返回的东西看不懂时（没有 data 数组，或者有行却一行日期都读不出来）当作出错，而不是当作"没有花费"：
// 当作没花费的话，同步会把这段时间已经存下的花费删掉，控制台还显示"正常"
export function checkActivityShape(body: unknown): OpenRouterActivity {
  const data = (body as OpenRouterActivity | null)?.data;
  const unreadable =
    !Array.isArray(data) ||
    (data.length > 0 &&
      !data.some((r) => typeof r?.date === "string" && DAY.test(r.date)));
  if (unreadable) {
    throw new ProviderError(
      "OpenRouter returned usage data in a format Billfuse doesn't recognize. Your earlier spend is kept, and Billfuse will try again on the next sync.",
      "upstream",
    );
  }
  return body as OpenRouterActivity;
}

async function getActivity(key: string, fetchImpl?: FetchLike, date?: string) {
  const url = date
    ? `${activityUrl()}?${new URLSearchParams({ date })}`
    : activityUrl();
  return checkActivityShape(
    await getJson<unknown>(
      "openrouter",
      url,
      headers(key),
      KEY_HINT,
      fetchImpl,
      FORBIDDEN,
    ),
  );
}

export async function fetchOpenRouterCosts(
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyCost[]> {
  return parseOpenRouterCosts(await getActivity(key, fetchImpl), start);
}

export async function fetchOpenRouterTokens(
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyTokens[]> {
  return parseOpenRouterTokens(await getActivity(key, fetchImpl), start);
}

// 连接时检查密钥：读昨天（UTC）一天的数据，既验证密钥，也验证它是不是管理密钥
export async function validateOpenRouterKey(
  key: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  await getActivity(key, fetchImpl, yesterday);
}
