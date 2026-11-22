import { aggregateCosts, apiBase, getJson, type FetchLike } from "./http";
import { aggregateTokens, type DailyCost, type DailyTokens } from "./types";

// 官方文档：https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/costs
// 成本只按天分桶（bucket_width 只能是 1d），金额 amount.value 单位是美元
function costsUrl() {
  const base = apiBase(
    process.env.OPENAI_API_BASE_URL,
    "https://api.openai.com",
  );
  return `${base}/v1/organization/costs`;
}
const MAX_PAGES = 10;

const KEY_HINT =
  "Billfuse needs an OpenAI admin key (it starts with sk-admin-) with Read only or All permissions, created by an organization owner.";

type CostsResult = {
  amount?: { value?: number | null; currency?: string | null } | null;
  line_item?: string | null;
};

export type OpenAiCostsPage = {
  data: { start_time: number; end_time: number; results: CostsResult[] }[];
  has_more: boolean;
  next_page: string | null;
};

// 计费项形如 "gpt-4o-2024-08-06, input"，逗号前是模型名；没有逗号的（如 "assistants api | file search"）整体当作名字
export function openAiModelFromLineItem(lineItem: string): string {
  const comma = lineItem.lastIndexOf(", ");
  return (
    (comma === -1 ? lineItem : lineItem.slice(0, comma)).trim() || lineItem
  );
}

export function parseOpenAiCosts(page: OpenAiCostsPage): DailyCost[] {
  const rows: DailyCost[] = [];
  for (const bucket of page.data ?? []) {
    const date = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
    for (const result of bucket.results ?? []) {
      const value = result.amount?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const lineItem = result.line_item?.trim() || "Other";
      rows.push({
        date,
        lineItem,
        model: openAiModelFromLineItem(lineItem),
        costUsd: value,
      });
    }
  }
  return rows;
}

function headers(key: string) {
  return { Authorization: `Bearer ${key}` };
}

// 读取 start 当天 00:00 (UTC) 到现在的每日花费，按计费项拆分
export async function fetchOpenAiCosts(
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyCost[]> {
  const rows: DailyCost[] = [];
  let page: string | null = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({
      start_time: String(Math.floor(start.getTime() / 1000)),
      bucket_width: "1d",
      group_by: "line_item",
      limit: "180",
    });
    if (page) params.set("page", page);

    const body = await getJson<OpenAiCostsPage>(
      "openai",
      `${costsUrl()}?${params}`,
      headers(key),
      KEY_HINT,
      fetchImpl,
    );
    rows.push(...parseOpenAiCosts(body));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }

  return aggregateCosts(rows);
}

// 官方文档：https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage/methods/completions
// 只读对话类模型（completions）的用量；按天、按模型分组，每页最多 31 天
function completionsUsageUrl() {
  const base = apiBase(
    process.env.OPENAI_API_BASE_URL,
    "https://api.openai.com",
  );
  return `${base}/v1/organization/usage/completions`;
}

type CompletionsResult = {
  model?: string | null;
  input_tokens?: number | null;
  input_cached_tokens?: number | null;
  output_tokens?: number | null;
  num_model_requests?: number | null;
};

export type OpenAiUsagePage = {
  data: { start_time: number; results: CompletionsResult[] }[];
  has_more: boolean;
  next_page: string | null;
};

export function parseOpenAiUsage(page: OpenAiUsagePage): DailyTokens[] {
  const rows: DailyTokens[] = [];
  for (const bucket of page.data ?? []) {
    const date = new Date(bucket.start_time * 1000).toISOString().slice(0, 10);
    for (const r of bucket.results ?? []) {
      rows.push({
        date,
        model: r.model?.trim() || "Other",
        inputTokens: r.input_tokens ?? 0,
        cachedInputTokens: r.input_cached_tokens ?? 0,
        outputTokens: r.output_tokens ?? 0,
        requests: r.num_model_requests ?? 0,
      });
    }
  }
  return rows;
}

export async function fetchOpenAiTokens(
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyTokens[]> {
  const rows: DailyTokens[] = [];
  let page: string | null = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const params = new URLSearchParams({
      start_time: String(Math.floor(start.getTime() / 1000)),
      bucket_width: "1d",
      group_by: "model",
      limit: "31",
    });
    if (page) params.set("page", page);

    const body = await getJson<OpenAiUsagePage>(
      "openai",
      `${completionsUsageUrl()}?${params}`,
      headers(key),
      KEY_HINT,
      fetchImpl,
    );
    rows.push(...parseOpenAiUsage(body));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }

  return aggregateTokens(rows);
}

// 连接时检查密钥：直接请求一天的成本数据，既验证密钥本身，也验证它有没有读成本的权限
export async function validateOpenAiKey(
  key: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const params = new URLSearchParams({
    start_time: String(Math.floor(Date.now() / 1000) - 86_400),
    limit: "1",
  });
  await getJson(
    "openai",
    `${costsUrl()}?${params}`,
    headers(key),
    KEY_HINT,
    fetchImpl,
  );
}
