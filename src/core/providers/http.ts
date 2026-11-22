import { PROVIDER_LABEL, ProviderError, type Provider } from "./types";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 这些请求都带着管理员密钥，所以改地址只认本机（localhost、127.0.0.1、::1）。
// 别的机器一律不认：有些工具也用 OPENAI_API_BASE_URL 这类变量名指向代理，密钥不能跟着被发过去
function isLocalAddress(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
}

// 命令行跑在用户自己的电脑上，那里的环境变量不归我们管，也没有 NODE_ENV=production 兜底。
// 所以命令行一加载共用代码就调这个（cli/src/shared.ts）：之后改地址的变量全部不认，本机地址也不认
let officialOnly = false;
export function lockOfficialAddresses() {
  officialOnly = true;
}

// 本地开发时可以把服务商地址指向本机的模拟服务器（scripts/mock-providers.mjs）测试。
// 生产环境一律用官方地址；不是本机的地址在哪儿都不认，照样用官方地址
export function apiBase(
  override: string | undefined,
  official: string,
): string {
  if (officialOnly) return official;
  if (process.env.NODE_ENV === "production" || !override) return official;
  if (!isLocalAddress(override)) return official;
  return override.replace(/\/$/, "");
}

// 按 HTTP 状态码给出用户看得懂的错误信息
export function errorForStatus(
  provider: Provider,
  status: number,
  keyHintText: string,
  forbidden?: string,
): ProviderError {
  const name = PROVIDER_LABEL[provider];
  if (status === 401) {
    return new ProviderError(
      `${name} rejected this key. ${keyHintText}`,
      "invalid_key",
    );
  }
  if (status === 403) {
    return new ProviderError(
      forbidden ??
        `This ${name} key isn't allowed to read usage and cost data. ${keyHintText}`,
      "forbidden",
    );
  }
  if (status === 429) {
    return new ProviderError(
      `${name} is rate limiting requests right now. Billfuse will try again on the next sync.`,
      "rate_limited",
    );
  }
  return new ProviderError(
    `${name}'s usage API returned an error (HTTP ${status}). Billfuse will try again on the next sync.`,
    "upstream",
  );
}

// 带超时和有限次重试的 GET：只对 429 和 5xx 重试，401/403 这种重试也没用
export async function getJson<T>(
  provider: Provider,
  url: string,
  headers: Record<string, string>,
  keyHintText: string,
  fetchImpl: FetchLike = fetch,
  forbidden?: string,
): Promise<T> {
  return (await requestJson<T>(provider, url, headers, keyHintText, {
    fetchImpl,
    forbidden,
  })) as T;
}

export type RequestOptions = {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  // 为 true 时 404 不算错，返回 null（比如"这个项目还没设花费上限"）
  allow404?: boolean;
  // 403 时给用户看的话，默认是"读不了用量和成本"
  forbidden?: string;
  fetchImpl?: FetchLike;
};

// 通用请求：GET / POST / DELETE。重试规则同上；这里的写操作都是"设成某个值"，重复执行结果一样，可以安全重试
export async function requestJson<T>(
  provider: Provider,
  url: string,
  headers: Record<string, string>,
  keyHintText: string,
  options: RequestOptions = {},
): Promise<T | null> {
  const { method = "GET", body, allow404, forbidden } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  let lastError: ProviderError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers:
          body === undefined
            ? headers
            : { ...headers, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
    } catch {
      lastError = new ProviderError(
        `Couldn't reach ${PROVIDER_LABEL[provider]}. Billfuse will try again on the next sync.`,
        "network",
      );
      if (attempt < MAX_ATTEMPTS) await sleep(500 * attempt);
      continue;
    }

    if (res.ok) {
      const text = await res.text();
      return (text ? JSON.parse(text) : null) as T | null;
    }
    if (res.status === 404 && allow404) return null;

    lastError = errorForStatus(provider, res.status, keyHintText, forbidden);
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) break;

    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : 1000 * attempt;
    await sleep(waitMs);
  }

  throw lastError ?? errorForStatus(provider, 500, keyHintText);
}

// 同一天同一计费项可能分散在多条结果里（分页或分组），合并成一条，保证写库时不重复
export function aggregateCosts<
  T extends { date: string; lineItem: string; model: string; costUsd: number },
>(rows: T[]): T[] {
  const merged = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.date}|${row.lineItem}`;
    const existing = merged.get(key);
    if (existing) {
      existing.costUsd += row.costUsd;
    } else {
      merged.set(key, { ...row });
    }
  }
  return [...merged.values()];
}
