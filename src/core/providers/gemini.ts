import { createSign, randomUUID } from "node:crypto";
import { aggregateCosts, apiBase, type FetchLike } from "./http";
import { ProviderError, type DailyCost, type DailyTokens } from "./types";

// Google Gemini 没有像 OpenAI 那样直接查花费的接口：花费只在 Google Cloud 账单里。
// 用户把账单导出到 BigQuery（Billing → Billing export → Standard usage cost），
// 再给 Billfuse 一个服务账号的 JSON 密钥：Billfuse 用它换访问令牌，查这张导出表里 Gemini 的行。
//   账单导出表的字段：https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/standard-usage
//   查询接口 jobs.query：https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query
//   服务账号换令牌：https://developers.google.com/identity/protocols/oauth2/service-account
// 导出的数据"通常一天内到"，有时更久，所以当天的花费第二天才全（types.ts 的 REPORTS_TODAY）。
// 账单里没有可靠的 token 用量（计费项的单位不统一），Gemini 只算花费

const SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";
const OFFICIAL_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OFFICIAL_BIGQUERY = "https://bigquery.googleapis.com/bigquery/v2";
const TIMEOUT_MS = 30_000;
// 每次请求让 BigQuery 最多等 10 秒，最多等 6 轮：一次同步里 Gemini 最多占一分多钟
const WAIT_MS = 10_000;
const MAX_ROUNDS = 6;

// 本地开发可以指向模拟服务器（scripts/mock-providers.mjs）；正式环境一律用官方地址
function devBase(): string {
  return apiBase(process.env.GEMINI_API_BASE_URL, "");
}
function tokenUrl() {
  return devBase() ? `${devBase()}/token` : OFFICIAL_TOKEN_URL;
}
function bigqueryBase() {
  return devBase() ? `${devBase()}/bigquery/v2` : OFFICIAL_BIGQUERY;
}

// 存进数据库（加密）的就是这个对象的 JSON。只留用得到的三项；
// 用户粘贴的密钥里的 token_uri 不用，免得 Billfuse 被指去别的地址
export type GeminiCredential = {
  table: string;
  client_email: string;
  private_key: string;
};

// 项目 ID：6–30 位小写字母、数字、连字符，字母开头。数据集、表名：字母数字下划线。
// 表名会直接拼进 SQL（BigQuery 不能用参数传表名），所以只认这个格式
const TABLE =
  /^[a-z][a-z0-9-]{4,28}[a-z0-9]\.[A-Za-z0-9_]{1,1024}\.[A-Za-z0-9_]{1,1024}$/;

function fail(message: string): never {
  throw new ProviderError(message, "invalid_key");
}

// 连接时：检查用户粘贴的服务账号 JSON 和表名，拼成要保存的凭据。hint 是服务账号邮箱，显示在设置页
export function buildGeminiCredential(
  serviceAccountJson: string,
  table: string,
): { credential: string; hint: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch {
    fail(
      "That isn't a JSON key. Paste the whole file you downloaded when you created the service account key.",
    );
  }
  if (parsed?.type !== "service_account") {
    fail(
      'That JSON isn\'t a service account key. It should contain "type": "service_account".',
    );
  }
  const email = parsed.client_email;
  const key = parsed.private_key;
  if (typeof email !== "string" || !email.includes("@")) {
    fail(
      "That key has no client_email. Download a new JSON key and paste all of it.",
    );
  }
  if (typeof key !== "string" || !key.includes("PRIVATE KEY")) {
    fail(
      "That key has no private_key. Download a new JSON key and paste all of it.",
    );
  }
  const trimmedTable = table.trim().replace(/^`|`$/g, "");
  if (!TABLE.test(trimmedTable)) {
    fail(
      "Enter the billing export table as project.dataset.table, for example my-project.billing.gcp_billing_export_v1_0123AB_45CDEF_6789GH.",
    );
  }
  const credential: GeminiCredential = {
    table: trimmedTable,
    client_email: email,
    private_key: key,
  };
  return { credential: JSON.stringify(credential), hint: email };
}

export function parseGeminiCredential(raw: string): GeminiCredential {
  try {
    const value = JSON.parse(raw) as GeminiCredential;
    if (
      TABLE.test(value.table) &&
      typeof value.client_email === "string" &&
      typeof value.private_key === "string"
    ) {
      return value;
    }
  } catch {
    // 落到下面
  }
  return fail("The saved Gemini key can't be read. Connect Gemini again.");
}

const base64url = (input: string | Buffer) =>
  Buffer.from(input).toString("base64url");

// 服务账号自己签一个 JWT（RS256），拿去换一小时有效的访问令牌
export function signServiceAccountJwt(
  cred: GeminiCredential,
  audience: string,
  now = new Date(),
): string {
  const iat = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: cred.client_email,
      scope: SCOPE,
      aud: audience,
      iat,
      exp: iat + 3600,
    }),
  );
  let signature: string;
  try {
    signature = createSign("RSA-SHA256")
      .update(`${header}.${claims}`)
      .sign(cred.private_key, "base64url");
  } catch {
    return fail(
      "The private key in that JSON can't be used. Download a new JSON key and paste all of it.",
    );
  }
  return `${header}.${claims}.${signature}`;
}

type GoogleError = { error?: unknown; error_description?: unknown };

// 带超时、对 429 和 5xx 重试一次的请求。返回状态码和解析后的内容，错误信息由调用方按场景翻译
async function call(
  url: string,
  init: RequestInit,
  fetchImpl: FetchLike = fetch,
): Promise<{ status: number; body: unknown }> {
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      if (attempt < 2) continue;
      throw new ProviderError(
        "Couldn't reach Google. Billfuse will try again on the next sync.",
        "network",
      );
    }
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    return { status: res.status, body };
  }
}

// Google 的报错原文。截短：错误会存进连接的 last_error（最多 500 字），太长的话存不进去，
// 用户就看不到"同步出错"了
function googleMessage(body: unknown): string {
  const e = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof e?.message === "string" ? e.message.slice(0, 160) : "";
}

export async function googleAccessToken(
  cred: GeminiCredential,
  fetchImpl?: FetchLike,
): Promise<string> {
  const url = tokenUrl();
  const { status, body } = await call(
    url,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signServiceAccountJwt(cred, url),
      }).toString(),
    },
    fetchImpl,
  );
  const token = (body as { access_token?: unknown } | null)?.access_token;
  if (status === 200 && typeof token === "string") return token;
  if (status === 400 || status === 401) {
    // invalid_grant：密钥被删了、服务账号被停用，或者签名不对
    const detail = (body as GoogleError | null)?.error_description;
    fail(
      `Google rejected this service account key${typeof detail === "string" ? ` (${detail.slice(0, 120)})` : ""}. Create a new JSON key for the service account and connect again.`,
    );
  }
  throw new ProviderError(
    `Google's sign-in service returned an error (HTTP ${status}). Billfuse will try again on the next sync.`,
    status === 429 ? "rate_limited" : "upstream",
  );
}

type QueryResponse = {
  jobComplete?: boolean;
  rows?: { f?: { v?: unknown }[] }[];
  pageToken?: string;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
};

function bigQueryError(status: number, body: unknown, table: string): never {
  const detail = googleMessage(body);
  if (status === 401) {
    fail(
      "Google rejected the access token for this service account. Connect Gemini again.",
    );
  }
  if (status === 403) {
    throw new ProviderError(
      `This service account can't read the billing export. In Google Cloud, give it the BigQuery Data Viewer role on the dataset and the BigQuery Job User role on the project.${detail ? ` Google said: ${detail}` : ""}`,
      "forbidden",
    );
  }
  if (status === 404) {
    fail(
      `Billfuse can't find the table ${table}. Check its ID in BigQuery: it looks like project.dataset.gcp_billing_export_v1_…`,
    );
  }
  throw new ProviderError(
    `Google BigQuery returned an error (HTTP ${status})${detail ? `: ${detail}` : ""}. Billfuse will try again on the next sync.`,
    status === 429 ? "rate_limited" : "upstream",
  );
}

// 跑一条查询，取回全部行（每行是字符串数组，顺序同 SELECT）。没跑完就等一等再取，有分页就接着取
export async function runQuery(
  cred: GeminiCredential,
  query: string,
  params: Record<string, string>,
  fetchImpl?: FetchLike,
): Promise<(string | null)[][]> {
  const token = await googleAccessToken(cred, fetchImpl);
  const project = cred.table.split(".")[0];
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  let { status, body } = await call(
    `${bigqueryBase()}/projects/${encodeURIComponent(project)}/queries`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        query,
        useLegacySql: false,
        parameterMode: "NAMED",
        queryParameters: Object.entries(params).map(([name, value]) => ({
          name,
          parameterType: { type: "STRING" },
          parameterValue: { value },
        })),
        timeoutMs: WAIT_MS,
        maxResults: 10_000,
        // 同一个编号重试时，BigQuery 不会再跑一遍（每跑一遍都按扫描量算用户的钱）
        requestId: randomUUID(),
      }),
    },
    fetchImpl,
  );
  const rows: (string | null)[][] = [];
  // 最多等几轮：每小时的同步一次最长 5 分钟，不能都耗在这里
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (status !== 200) bigQueryError(status, body, cred.table);
    const page = (body ?? {}) as QueryResponse;
    if (page.jobComplete) {
      for (const row of page.rows ?? []) {
        rows.push(
          (row.f ?? []).map((cell) =>
            typeof cell?.v === "string" ? cell.v : null,
          ),
        );
      }
      if (!page.pageToken) return rows;
    }
    // 这是最后一轮：不再发一个拿回来也不会看的请求
    if (round === MAX_ROUNDS - 1) break;
    const job = page.jobReference;
    if (!job?.jobId) {
      throw new ProviderError(
        "Google BigQuery returned a response Billfuse doesn't recognize. Your earlier spend is kept, and Billfuse will try again on the next sync.",
        "upstream",
      );
    }
    const search = new URLSearchParams({
      timeoutMs: String(WAIT_MS),
      maxResults: "10000",
    });
    if (job.location) search.set("location", job.location);
    if (page.jobComplete && page.pageToken)
      search.set("pageToken", page.pageToken);
    ({ status, body } = await call(
      `${bigqueryBase()}/projects/${encodeURIComponent(job.projectId ?? project)}/queries/${encodeURIComponent(job.jobId)}?${search}`,
      { method: "GET", headers },
      fetchImpl,
    ));
  }
  throw new ProviderError(
    "Google BigQuery took too long to answer. Billfuse will try again on the next sync.",
    "upstream",
  );
}

// 哪些行算 Gemini：Gemini API（Google AI Studio 的密钥，服务名里有 Gemini 或 Generative Language），
// 加上 Vertex AI 里计费项名带 Gemini 的。Google 没写死这几个名字，所以按包含关系找，不按全等。
// 费用是扣减额度和折扣（免费试用金、预付额度、用量折扣等）之前的金额：预算提醒要看用了多少，
// 而不是这个月实际扣了多少钱。只算普通费用行，税和调整不算。
// 换成美元：美元账户直接用 cost；别的币种 cost ÷ currency_conversion_rate（见账单导出字段说明），
// 没有汇率的行算不出美元，宁可不算，也不把日元当美元。
// export_time 不早于 usage_start_time（先用掉才导出），加上这个条件不会漏行；
// 表按导出时间分区时，BigQuery 只扫最近这段，用户少付查询费。
// 只到昨天为止（@end 是今天 UTC 的日期）：今天的账单还没导完，只有一部分，
// 其余地方（月底预测、页面上的说明）都按"Gemini 只算到昨天"处理（types.ts 的 REPORTS_TODAY）
export function costsQuery(table: string): string {
  if (!TABLE.test(table)) fail("The billing export table ID isn't valid.");
  return `SELECT
  FORMAT_DATE('%F', DATE(usage_start_time)) AS day,
  service.description AS service_name,
  sku.description AS sku_name,
  SUM(IF(currency = 'USD', cost, cost / NULLIF(currency_conversion_rate, 0))) AS cost_usd
FROM \`${table}\`
WHERE usage_start_time >= TIMESTAMP(@start)
  AND usage_start_time < TIMESTAMP(@end)
  AND export_time >= TIMESTAMP(@start)
  AND IFNULL(cost_type, 'regular') = 'regular'
  AND (
    REGEXP_CONTAINS(LOWER(service.description), r'gemini|generative language')
    OR (REGEXP_CONTAINS(LOWER(service.description), r'vertex ai') AND REGEXP_CONTAINS(LOWER(sku.description), r'gemini'))
  )
GROUP BY 1, 2, 3
ORDER BY 1`;
}

// 从计费项名里认出模型："Gemini 2.5 Flash Input Tokens" → gemini-2.5-flash。认不出就归到 "Gemini (other)"
// （比如搜索接地、按次计费的项）
export function modelFromSku(sku: string): string {
  const m = sku
    .toLowerCase()
    .match(
      /gemini[\s-]*(\d+(?:\.\d+)?)?[\s-]*(flash[\s-]*lite|flash|pro|ultra|nano)?/,
    );
  if (!m || (!m[1] && !m[2])) return "Gemini (other)";
  const parts = ["gemini", m[1], m[2]?.replace(/[\s-]+/g, "-")].filter(Boolean);
  return parts.join("-");
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseGeminiRows(rows: (string | null)[][]): DailyCost[] {
  const costs: DailyCost[] = [];
  for (const [day, , sku, cost] of rows) {
    const usd = Number(cost);
    if (!day || !DAY.test(day) || !Number.isFinite(usd) || usd === 0) continue;
    const lineItem = (sku ?? "Gemini").slice(0, 200);
    costs.push({
      date: day,
      lineItem,
      model: modelFromSku(lineItem),
      costUsd: usd,
    });
  }
  return aggregateCosts(costs);
}

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

export async function fetchGeminiCosts(
  key: string,
  start: Date,
  fetchImpl?: FetchLike,
  now = new Date(),
): Promise<DailyCost[]> {
  const cred = parseGeminiCredential(key);
  const rows = await runQuery(
    cred,
    costsQuery(cred.table),
    { start: utcDay(start), end: utcDay(now) },
    fetchImpl,
  );
  return parseGeminiRows(rows);
}

export async function fetchGeminiTokens(): Promise<DailyTokens[]> {
  return [];
}

// 连接时检查：换得到令牌、表存在、服务账号查得了这张表，而且这张表有同步要用的那些字段
// （用同步时的同一条查询，只查最近一天）。不然填错一张表，连接时说"好了"，之后每小时都同步失败
export async function validateGeminiKey(
  key: string,
  fetchImpl?: FetchLike,
): Promise<void> {
  const cred = parseGeminiCredential(key);
  const now = new Date();
  await runQuery(
    cred,
    costsQuery(cred.table),
    { start: utcDay(new Date(now.getTime() - 86_400_000)), end: utcDay(now) },
    fetchImpl,
  );
}
