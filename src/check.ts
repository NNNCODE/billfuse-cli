import { CliError } from "./api.js";
import type { Args } from "./args.js";
import {
  explainSpend,
  fetchDailyCosts,
  monthStart,
  parseBudget,
  PROVIDER_LABEL,
  ProviderError,
  summarizeSpend,
  syncStartDay,
  type FetchLike,
  type Provider,
  type SpendRow,
} from "./shared.js";
import type { CliStatus } from "./types.js";

// check 命令：不登录 Billfuse，直接在这台电脑上向各家服务商读花费。
// 密钥从环境变量来，只发给它自己那家的官方地址（见 shared.ts 开头的 lockOfficialAddresses）。
// Gemini 不在这里：它要一份服务账号 JSON 加一个账单导出表名，一个环境变量放不下

// 四家都只认管理密钥，平时调模型用的普通密钥读不了花费，所以变量名不用 OPENAI_API_KEY 这类常见的名字
export const LOCAL_KEYS: { provider: Provider; env: string }[] = [
  { provider: "openai", env: "OPENAI_ADMIN_KEY" },
  { provider: "anthropic", env: "ANTHROPIC_ADMIN_KEY" },
  { provider: "openrouter", env: "OPENROUTER_MANAGEMENT_KEY" },
  { provider: "xai", env: "XAI_MANAGEMENT_KEY" },
];

export type LocalKey = { provider: Provider; key: string };

export function keysFromEnv(
  env: Record<string, string | undefined>,
): LocalKey[] {
  const keys: LocalKey[] = [];
  for (const { provider, env: name } of LOCAL_KEYS) {
    const key = env[name]?.trim();
    if (key) keys.push({ provider, key });
  }
  return keys;
}

// check 认的参数。别的一律报错：写错的参数（--budjet 200）如果被悄悄忽略，
// 就成了"没设预算、退出码 0"，用它把关的脚本会一直以为没超
const CHECK_FLAGS = new Set(["budget", "fail-at", "json", "no-color"]);

export type CheckOptions = { budget: number | null; failAt: number };

export function checkOptions(
  flags: Args["flags"],
  env: Record<string, string | undefined>,
): CheckOptions {
  for (const name of flags.keys()) {
    if (!CHECK_FLAGS.has(name)) {
      throw new CliError(
        `check doesn't have a --${name} option. Run \`npx billfuse --help\` to see the ones it has.`,
      );
    }
  }

  // 命令行上写了 --budget 就用它（没带数字也算写了，下面会报错），否则看环境变量
  const flag = flags.get("budget");
  const rawBudget =
    typeof flag === "string"
      ? flag
      : flag === true
        ? ""
        : env.BILLFUSE_BUDGET?.trim() || null;
  let budget: number | null = null;
  if (rawBudget !== null) {
    budget = parseBudget(rawBudget);
    if (budget === null) {
      throw new CliError(
        `"${rawBudget}" isn't a budget. Use a dollar amount above zero, for example --budget 200.`,
      );
    }
  }

  let failAt = 100;
  if (flags.has("fail-at")) {
    if (budget === null) {
      throw new CliError(
        "--fail-at needs a budget to measure against. Add --budget <usd>.",
      );
    }
    // 和预算一样严格："80%"、"eighty" 以前会被悄悄当成 100
    const raw = flags.get("fail-at");
    failAt =
      typeof raw === "string" && /^\d+(\.\d+)?$/.test(raw) ? Number(raw) : NaN;
    if (!(failAt > 0)) {
      throw new CliError(
        `"${raw === true ? "" : raw}" isn't a percentage. Use a number above zero without the % sign, for example --fail-at 80.`,
      );
    }
  }
  return { budget, failAt };
}

// 服务商出错时的提示是给网站写的：结尾说"下次同步再试"，Anthropic 那句还让人去"连接"新密钥。
// 这里没有同步也没有连接，把这几处去掉
const HOSTED_ENDINGS = [
  " Your earlier spend is kept, and Billfuse will try again on the next sync.",
  " Billfuse will try again on the next sync.",
];

export function localMessage(message: string): string {
  let text = message.replace(
    "create a new admin key and connect it.",
    "create a new admin key.",
  );
  for (const ending of HOSTED_ENDINGS) {
    if (text.endsWith(ending)) text = text.slice(0, -ending.length);
  }
  return text;
}

function envName(provider: Provider): string {
  return LOCAL_KEYS.find((k) => k.provider === provider)?.env ?? "";
}

// 一家服务商没读到时给用户看的话。密钥的问题要说清是哪个变量里的密钥
function unreadMessage(provider: Provider, err: unknown): string {
  if (err instanceof ProviderError) {
    const text = localMessage(err.message);
    return err.kind === "invalid_key" || err.kind === "forbidden"
      ? `${text} The key came from ${envName(provider)}.`
      : text;
  }
  // 不是服务商正常的报错：比如公司代理或上网认证页用 200 回了一页 HTML，解析不了。
  // 不能让它把整个命令带崩，别家已经读到的结果还要显示
  return `${PROVIDER_LABEL[provider]} sent back something that isn't usage data. A proxy or a sign-in page may be answering in its place.`;
}

// 输出和 status 命令同一个格式（CliStatus），显示和 --json 都能照用
export async function buildLocalStatus(
  keys: LocalKey[],
  budget: number | null,
  now: Date,
  fetchImpl?: FetchLike,
): Promise<CliStatus> {
  // 和网站每次同步取的范围一样：本月 1 号和最近 30 天里更早的那个，"和平常比"的那句话要用
  const start = new Date(`${syncStartDay(now)}T00:00:00Z`);

  const results = await Promise.all(
    keys.map(async ({ provider, key }) => {
      try {
        const costs = await fetchDailyCosts(provider, key, start, fetchImpl);
        const rows: SpendRow[] = costs.map((cost) => ({
          provider,
          date: cost.date,
          model: cost.model || "Other",
          costUsd: cost.costUsd,
        }));
        return { provider, rows, error: null };
      } catch (err) {
        return { provider, rows: [], error: unreadMessage(provider, err) };
      }
    }),
  );

  const rows = results.flatMap((r) => r.rows);
  const summary = summarizeSpend(rows, budget, now);
  const explanation = explainSpend(rows, now);

  // 给了密钥但本月还没花费的服务商也列出来，显示 $0
  const providers = results
    .map((r) => {
      const spend = summary.byProvider.find((p) => p.provider === r.provider);
      return {
        provider: r.provider,
        name: PROVIDER_LABEL[r.provider],
        cost: spend?.cost ?? 0,
        share: spend?.share ?? 0,
        status: r.error ? "error" : "active",
        lastSyncedAt: r.error ? null : now.toISOString(),
        error: r.error,
      };
    })
    .sort((a, b) => b.cost - a.cost);

  return {
    month: monthStart(now).slice(0, 7),
    asOf: now.toISOString(),
    monthToDate: summary.monthToDate,
    budget: summary.budget,
    remaining: summary.remaining,
    percentUsed: summary.percentUsed,
    projectedMonthEnd: summary.projectedMonthEnd,
    providers,
    topModels: summary.byModel.slice(0, 5),
    explanation: explanation?.headline ?? null,
    dashboardUrl: "https://billfuse.dev",
  };
}

// 预算是不是用到了这个百分比。先去掉浮点误差再比：0.57 * 100 在 JS 里是 56.99999999999999，
// 直接比的话屏幕上写着"57% used"，--fail-at 57 却不算到
export function reachedPercent(
  percentUsed: number | null,
  threshold: number,
): boolean {
  return (
    percentUsed !== null && Math.round(percentUsed * 1e8) / 1e6 >= threshold
  );
}

// 退出码：2 = 预算用到了指定的百分比；1 = 有服务商没读到（合计不全，不能当作没超）；0 = 都读到了且没到
export function checkExitCode(
  status: CliStatus,
  failAtPercent: number,
): number {
  if (reachedPercent(status.percentUsed, failAtPercent)) return 2;
  return status.providers.some((p) => p.error) ? 1 : 0;
}
