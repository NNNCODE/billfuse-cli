import { aggregateCosts, apiBase, requestJson, type FetchLike } from "./http";
import { ProviderError, type DailyCost, type DailyTokens } from "./types";

// 官方文档：https://docs.x.ai/developers/rest-api-reference/management/billing
// 和 https://docs.x.ai/developers/management-api-guide 。xAI 的花费在"管理接口"（management-api.x.ai）上，
// 和调模型的接口是两个地址，只认管理密钥（xAI Console → Settings → Management Keys），普通 API 密钥不行。
//   1. GET /auth/management-keys/validation 返回这把密钥属于哪个团队（scope 是 SCOPE_TEAM 时看 scopeId，
//      teamId 字段文档标了"已弃用"，只作后备）。用户只填密钥，团队编号每次同步现查，不另存
//   2. POST /v1/billing/teams/{team_id}/usage 按时间分桶返回用量，values 选 usd 就是花费，
//      groupBy description（"产品名加计费的东西，通常是模型"）就是按模型分
// usd 文档只写了"Cost in USD"，没说是美元还是美分：同一页的余额、账单接口用的是"美分字符串"，
// 用量接口返回的却是数字（double）。两个开源工具（CodexBar 的 xai.js、sheprd 的 xai.rs，2026-11-12 查的）
// 都直接当美元读，这里也当美元。sheprd 的测试数据是照文档里 units 的例子写的，不算验证；
// 没在真实账户上和 xAI 后台的数字对过，README"已知限制"里写了
function managementBase() {
  return apiBase(process.env.XAI_API_BASE_URL, "https://management-api.x.ai");
}

const KEY_HINT =
  "Billfuse needs an xAI management key, created in the xAI Console under Settings → Management Keys. Regular API keys won't work.";
const FORBIDDEN =
  "This xAI key can't read billing data. Billfuse needs a management key, created in the xAI Console under Settings → Management Keys. Regular API keys won't work.";
const NO_TEAM =
  "xAI didn't find a team for this management key. Create the management key in the xAI Console of the team whose spend you want to track.";
const UNREADABLE =
  "xAI returned usage data in a format Billfuse doesn't recognize. Your earlier spend is kept, and Billfuse will try again on the next sync.";
// 文档：limitReached 为 true 时"只返回了一部分结果"。只存一部分的话，同步会把缺的那部分已存花费删掉，所以当作出错
const PARTIAL =
  "xAI returned only part of your usage this time. Your earlier spend is kept, and Billfuse will try again on the next sync.";

type KeyInfo = {
  scope?: string | null;
  scopeId?: string | null;
  teamId?: string | null;
};

type DataPoint = {
  timestamp?: string | null;
  values?: (number | null)[] | null;
};

type Series = {
  group?: (string | null)[] | null;
  groupLabels?: (string | null)[] | null;
  dataPoints?: DataPoint[] | null;
};

export type XaiUsage = {
  timeSeries?: Series[] | null;
  limitReached?: boolean | null;
};

function headers(key: string) {
  return { Authorization: `Bearer ${key}` };
}

function utcDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function teamIdFromKeyInfo(info: KeyInfo | null): string {
  const id =
    info?.scope === "SCOPE_TEAM" && info.scopeId?.trim()
      ? info.scopeId.trim()
      : info?.teamId?.trim();
  if (!id) throw new ProviderError(NO_TEAM, "forbidden");
  return id;
}

async function teamId(key: string, fetchImpl?: FetchLike): Promise<string> {
  const info = await requestJson<KeyInfo>(
    "xai",
    `${managementBase()}/auth/management-keys/validation`,
    headers(key),
    KEY_HINT,
    { fetchImpl, forbidden: FORBIDDEN },
  );
  return teamIdFromKeyInfo(info);
}

// 按 UTC 日分桶的花费查询。起止时间按 timezone 解释，结束时间不含；文档的例子用 Etc/GMT（就是 UTC）。
// 结束放在明天 0 点，今天还没过完的那部分也查到
export function usageQuery(start: Date, end: Date) {
  return {
    analyticsRequest: {
      timeRange: {
        startTime: `${utcDay(start)} 00:00:00`,
        endTime: `${utcDay(end)} 00:00:00`,
        timezone: "Etc/GMT",
      },
      timeUnit: "TIME_UNIT_DAY",
      values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
      groupBy: ["description"],
      filters: [],
    },
  };
}

// xAI 的接口看起来是 gRPC 网关转出来的 JSON（枚举写成 TIME_UNIT_DAY，出错时带 code），这种 JSON 默认不写
// 空数组和 false：一个模型都没用过的团队可能只回 {}。没有 timeSeries、也不像出错信息的对象，当作"没有花费"
function isEmptyAnswer(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    !("timeSeries" in body) &&
    !("code" in body) &&
    !("error" in body) &&
    !("message" in body)
  );
}

// 返回的东西看不懂时当作出错，而不是当作"没有花费"：当作没花费的话，同步会把这段时间已经存下的花费删掉
export function checkUsageShape(body: unknown): XaiUsage {
  const usage = body as XaiUsage | null;
  if (usage?.limitReached === true) {
    throw new ProviderError(PARTIAL, "upstream");
  }
  if (isEmptyAnswer(body)) return { timeSeries: [] };
  const series = usage?.timeSeries;
  const readable =
    Array.isArray(series) &&
    series.every(
      (s) =>
        Array.isArray(s?.dataPoints) &&
        s.dataPoints.every(
          (p) =>
            typeof p?.timestamp === "string" &&
            Number.isFinite(Date.parse(p.timestamp)) &&
            Array.isArray(p.values) &&
            typeof p.values[0] === "number" &&
            Number.isFinite(p.values[0]),
        ),
    );
  if (!readable) throw new ProviderError(UNREADABLE, "upstream");
  return usage!;
}

// 每个模型一条时间序列，每天一个点（文档说点是"稠密"的：范围里每一天都有一个点）。值是 0 的不存
export function parseXaiCosts(body: XaiUsage, start: Date): DailyCost[] {
  const startDay = utcDay(start);
  const rows: DailyCost[] = [];
  for (const series of body.timeSeries ?? []) {
    const model =
      series.group?.[0]?.trim() || series.groupLabels?.[0]?.trim() || "Other";
    for (const point of series.dataPoints ?? []) {
      const costUsd = point.values?.[0];
      if (typeof costUsd !== "number" || costUsd === 0) continue;
      const date = utcDay(new Date(point.timestamp!));
      if (date < startDay) continue;
      rows.push({ date, lineItem: model, model, costUsd });
    }
  }
  return aggregateCosts(rows);
}

async function getUsage(
  key: string,
  start: Date,
  end: Date,
  fetchImpl?: FetchLike,
): Promise<XaiUsage> {
  const team = await teamId(key, fetchImpl);
  const body = await requestJson<unknown>(
    "xai",
    `${managementBase()}/v1/billing/teams/${encodeURIComponent(team)}/usage`,
    headers(key),
    KEY_HINT,
    {
      method: "POST",
      body: usageQuery(start, end),
      allow404: true,
      forbidden: FORBIDDEN,
      fetchImpl,
    },
  );
  // 404：团队编号不对，或者这把密钥不属于这个团队
  if (body === null) throw new ProviderError(NO_TEAM, "forbidden");
  return checkUsageShape(body);
}

function tomorrow(now = new Date()) {
  return new Date(now.getTime() + 86_400_000);
}

export async function fetchXaiCosts(
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
): Promise<DailyCost[]> {
  return parseXaiCosts(
    await getUsage(key, start, tomorrow(), fetchImpl),
    start,
  );
}

// token 用量先不读：用量接口能按 unit_type（"Prompt text tokens"、"Cached prompt text tokens"……）分，
// 但文档没说"缓存命中的输入"算不算在普通输入里，算错了控制台的缓存比例就是错的。和 Gemini 一样返回空
export async function fetchXaiTokens(): Promise<DailyTokens[]> {
  return [];
}

// 连接时检查密钥：找得到团队，而且读得了昨天到今天的花费
export async function validateXaiKey(
  key: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const now = new Date();
  await getUsage(
    key,
    new Date(now.getTime() - 86_400_000),
    tomorrow(now),
    fetchImpl,
  );
}
