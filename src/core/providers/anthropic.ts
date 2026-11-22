import { aggregateCosts, apiBase, getJson, type FetchLike } from "./http";
import { aggregateTokens, type DailyCost, type DailyTokens } from "./types";

// 官方文档：https://platform.claude.com/docs/en/api/beta/organization/cost_report/retrieve
// 成本只按天分桶，每页最多 31 天。amount 是"最小货币单位"的字符串，USD 下就是美分："123.45" = $1.23
function costReportUrl() {
  const base = apiBase(
    process.env.ANTHROPIC_API_BASE_URL,
    "https://api.anthropic.com",
  );
  return `${base}/v1/organizations/cost_report`;
}
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_PAGES = 10;

const KEY_HINT =
  "Billfuse needs an Anthropic Admin API key (it starts with sk-ant-admin), not a regular API key.";
// 401 时先说最可能的原因：管理员密钥建时要选多久过期，过期或被删了请求就被拒
const REJECTED_HINT = `It may have expired or been deleted: create a new admin key and connect it. ${KEY_HINT}`;
// 403 的话照旧（就是 errorForStatus 的默认说法），免得也带上上面那句"可能过期了"
const FORBIDDEN = `This Anthropic key isn't allowed to read usage and cost data. ${KEY_HINT}`;

// 管理员密钥都以 sk-ant-admin 开头，普通 API 密钥是 sk-ant-api…。连接时只收管理员密钥，暂停前也再看一遍
// （connect-text.ts、pause.ts）
export function isAnthropicAdminKey(key: string): boolean {
  return key.startsWith("sk-ant-admin");
}

type CostResult = {
  amount?: string | null;
  currency?: string | null;
  cost_type?: string | null;
  description?: string | null;
  model?: string | null;
};

export type AnthropicCostPage = {
  data: { starting_at: string; ending_at: string; results: CostResult[] }[];
  has_more: boolean;
  next_page: string | null;
};

const COST_TYPE_LABEL: Record<string, string> = {
  tokens: "Tokens",
  web_search: "Web search",
  code_execution: "Code execution",
  session_usage: "Sessions",
};

export function parseAnthropicCosts(page: AnthropicCostPage): DailyCost[] {
  const rows: DailyCost[] = [];
  for (const bucket of page.data ?? []) {
    const date = bucket.starting_at.slice(0, 10);
    for (const result of bucket.results ?? []) {
      const cents = Number(result.amount);
      if (result.amount == null || !Number.isFinite(cents)) continue;
      const costTypeLabel = result.cost_type
        ? (COST_TYPE_LABEL[result.cost_type] ?? result.cost_type)
        : null;
      const lineItem = result.description?.trim() || costTypeLabel || "Other";
      rows.push({
        date,
        lineItem,
        // 网页搜索、代码执行这类不按模型计费的项目，model 是 null，用费用类型代替
        model: result.model?.trim() || costTypeLabel || "Other",
        costUsd: cents / 100,
      });
    }
  }
  return rows;
}

function headers(key: string) {
  return { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION };
}

function query(
  start: Date,
  limit: number,
  page: string | null,
  groupBy = "description",
): string {
  // 文档里数组参数写作 group_by[]=...，这里照原样拼
  const parts = [
    `starting_at=${encodeURIComponent(start.toISOString())}`,
    "bucket_width=1d",
    `group_by[]=${groupBy}`,
    `limit=${limit}`,
  ];
  if (page) parts.push(`page=${encodeURIComponent(page)}`);
  return parts.join("&");
}

// 读取 start 当天 00:00 (UTC) 到现在的每日花费，按计费项拆分
export async function fetchAnthropicCosts(
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyCost[]> {
  const rows: DailyCost[] = [];
  let page: string | null = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const body: AnthropicCostPage = await getJson<AnthropicCostPage>(
      "anthropic",
      `${costReportUrl()}?${query(start, 31, page)}`,
      headers(key),
      REJECTED_HINT,
      fetchImpl,
      FORBIDDEN,
    );
    rows.push(...parseAnthropicCosts(body));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }

  return aggregateCosts(rows);
}

// 官方文档：https://platform.claude.com/docs/en/api/beta/organization/usage_report/retrieve_messages
function usageReportUrl() {
  const base = apiBase(
    process.env.ANTHROPIC_API_BASE_URL,
    "https://api.anthropic.com",
  );
  return `${base}/v1/organizations/usage_report/messages`;
}

type UsageResult = {
  model?: string | null;
  uncached_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number | null;
    ephemeral_1h_input_tokens?: number | null;
  } | null;
  output_tokens?: number | null;
};

export type AnthropicUsagePage = {
  data: { starting_at: string; results: UsageResult[] }[];
  has_more: boolean;
  next_page: string | null;
};

export function parseAnthropicUsage(page: AnthropicUsagePage): DailyTokens[] {
  const rows: DailyTokens[] = [];
  for (const bucket of page.data ?? []) {
    const date = bucket.starting_at.slice(0, 10);
    for (const r of bucket.results ?? []) {
      const cached = r.cache_read_input_tokens ?? 0;
      const cacheWrites =
        (r.cache_creation?.ephemeral_5m_input_tokens ?? 0) +
        (r.cache_creation?.ephemeral_1h_input_tokens ?? 0);
      rows.push({
        date,
        model: r.model?.trim() || "Other",
        // 和 OpenAI 保持一致：输入 = 未缓存 + 命中缓存 + 写缓存
        inputTokens: (r.uncached_input_tokens ?? 0) + cached + cacheWrites,
        cachedInputTokens: cached,
        outputTokens: r.output_tokens ?? 0,
        requests: null,
      });
    }
  }
  return rows;
}

export async function fetchAnthropicTokens(
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyTokens[]> {
  const rows: DailyTokens[] = [];
  let page: string | null = null;

  for (let i = 0; i < MAX_PAGES; i++) {
    const body: AnthropicUsagePage = await getJson<AnthropicUsagePage>(
      "anthropic",
      `${usageReportUrl()}?${query(start, 31, page, "model")}`,
      headers(key),
      REJECTED_HINT,
      fetchImpl,
      FORBIDDEN,
    );
    rows.push(...parseAnthropicUsage(body));
    if (!body.has_more || !body.next_page) break;
    page = body.next_page;
  }

  return aggregateTokens(rows);
}

// 连接时检查密钥：请求一天的成本数据。管理员密钥没有权限范围之分，能读到就说明可用
export async function validateAnthropicKey(
  key: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const start = new Date(Date.now() - 86_400_000);
  await getJson(
    "anthropic",
    `${costReportUrl()}?${query(start, 1, null)}`,
    headers(key),
    REJECTED_HINT,
    fetchImpl,
    FORBIDDEN,
  );
}
