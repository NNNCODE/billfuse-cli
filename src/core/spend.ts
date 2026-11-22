import {
  addDays,
  daysInMonth,
  lastNDays,
  monthStart,
  TREND_DAYS,
  utcDay,
} from "./dates";
import { PROVIDERS, REPORTS_TODAY, type Provider } from "./providers/types";

// 控制台用到的所有数字都从这里算出来；纯函数，方便测试

export type SpendRow = {
  provider: Provider;
  date: string;
  model: string;
  costUsd: number;
};

// 一天一个模型的 token 总数（输入 + 输出）
export type TokenRow = {
  provider: Provider;
  date: string;
  model: string;
  tokens: number;
};

export type DailyPoint = { date: string; total: number } & Record<
  Provider,
  number
>;

export type SpendSummary = {
  monthStart: string;
  dayOfMonth: number;
  daysInMonth: number;
  monthToDate: number;
  // 照现在的速度推算到月底：每家分别推算再相加（见 projectMicros）
  projectedMonthEnd: number;
  budget: number | null;
  remaining: number | null;
  percentUsed: number | null;
  // projected：这家照现在的速度到月底会花多少
  byProvider: {
    provider: Provider;
    cost: number;
    share: number;
    projected: number;
  }[];
  // tokens：本月这个模型的输入 + 输出 token；没拿到用量数据时为 null
  byModel: {
    model: string;
    provider: Provider | null;
    cost: number;
    tokens: number | null;
  }[];
  daily: DailyPoint[];
  hasData: boolean;
};

export const TOP_MODELS = 8;

// 金额先换成"百万分之一美元"的整数再相加，最后才四舍五入到分。
// 直接用小数相加会出现 330.885 × 100 = 33088.4999… 这种误差，导致和数据库的合计差一分钱
export function toMicros(usd: number) {
  return Math.round(usd * 1_000_000);
}

// 报上来的最后一天是不是还缺数据：OpenAI 和 Anthropic 报到今天，今天还没过完；
// Gemini 报到昨天，但账单导出"通常一天内到"，06:00 时昨天往往只导出了前几个小时。
// OpenRouter 只报过完的日子，昨天是全的。xAI 和 OpenAI 一样报到今天
const LAST_DAY_PARTIAL: Record<Provider, boolean> = {
  openai: true,
  anthropic: true,
  openrouter: false,
  gemini: true,
  xai: true,
};

// 这家报到了哪天（UTC 日期）：今天，或者昨天
function lastReportedDay(provider: Provider, now: Date): string {
  return REPORTS_TODAY[provider] ? utcDay(now) : addDays(utcDay(now), -1);
}

// 推算这家服务商到月底一共会花多少（微美元）。monthMicros 是本月到现在的花费，
// beforeLastDayMicros 是其中日期在报上来的最后一天（lastReportedDay）之前的部分。
// OpenRouter 只有到昨天的数据、昨天是全的：按报上来的天数算日均，再乘整月天数。
// 用"今天是几号"去除会把它的日均算低；1 号它还一天都没有，只能算 0。
// 其余三家最后一天不全，当成整天去除会算低（OpenAI 2 号零点刚过时只有实际的一半；
// Gemini 的导出晚一天时整个月都低，3 号低 38%），每过 UTC 零点还往下掉一截。
// 所以按"已花 + 最后一天还会来的 + 日均 × 后面的整天"算。
// 日均取两个里大的：最后一天之前的整天日均，和把最后一天当成整天的日均（那天已经比平常一整天花得多时跟着涨）。
// 最后一天还会来的：补到一天的日均为止，已经超过的就不再加；再按今天剩下的时间算，不超过它。
// OpenAI 的今天还没过完，剩下的时间还会花；Gemini 的昨天已经过完，缺的是还没导出的部分，
// 导出晚 24 小时时，今天过去多少，昨天就导出了多少，按同样的比例补正好。
// 一天的花费集中在 UTC 早上时（零点跑的任务、亚太的上班时间），今天的量早早就到齐了，
// 再按剩下的时间加一份会偏高，提示就会时有时无。Gemini 昨天本来就花得少时（周末），
// 补的那份会偏高，但越到晚上补得越少。
// 反过来，最后一天的花费还没来时（集中在 UTC 晚上，或者数据晚到）会偏低：之前的数据都到齐时，最多低一天的日均。
// 数据晚到跨过 UTC 零点时前一天也不全，少掉的部分拉低日均、再乘上后面的每一天，
// 月初会低好几天的量，零点也会往下掉一截（OpenAI 每天 $10、晚 12 小时，11 月 2 日 06:00 只有 $223.13，实际 $300；
// Gemini 晚 36 小时时，10 月 21 日 06:00 是 $303.45，实际 $310）。
// 只报了一天时，只能把这一天当成整天，会偏低
function projectMicros(
  provider: Provider,
  monthMicros: number,
  beforeLastDayMicros: number,
  now: Date,
): number {
  const dayOfMonth = now.getUTCDate();
  const monthDays = daysInMonth(now);
  // 报到了本月第几天
  const lastDay = REPORTS_TODAY[provider] ? dayOfMonth : dayOfMonth - 1;
  if (lastDay === 0) return 0;
  if (!LAST_DAY_PARTIAL[provider]) return (monthMicros / lastDay) * monthDays;
  if (lastDay === 1) return monthMicros * monthDays;
  const perDay = Math.max(
    beforeLastDayMicros / (lastDay - 1),
    monthMicros / lastDay,
  );
  // 今天（UTC）已经过去的比例，按毫秒算：06:00 是 0.25
  const elapsed =
    (now.getTime() - Date.parse(`${utcDay(now)}T00:00:00Z`)) / 86_400_000;
  const restOfLastDay = Math.min(
    perDay * (1 - elapsed),
    Math.max(0, perDay - (monthMicros - beforeLastDayMicros)),
  );
  return monthMicros + restOfLastDay + perDay * (monthDays - lastDay);
}

// 和数据库一样"远离零"取整：Math.round(-3088.5) 会得到 -3088，超支金额就会少一分钱
export function microsToUsd(micros: number) {
  return (Math.sign(micros) * Math.round(Math.abs(micros) / 10_000)) / 100;
}

export function summarizeSpend(
  rows: SpendRow[],
  budget: number | null,
  now: Date,
  tokenRows: TokenRow[] = [],
): SpendSummary {
  const start = monthStart(now);
  const today = utcDay(now);
  const dayOfMonth = now.getUTCDate();
  const monthDays = daysInMonth(now);

  const thisMonth = rows.filter((r) => r.date >= start && r.date <= today);
  const monthToDate = thisMonth.reduce(
    (sum, r) => sum + toMicros(r.costUsd),
    0,
  );

  const providerTotals = new Map<Provider, number>();
  // 每家本月日期在它报上来的最后一天之前的花费，推算月底时用
  const providerBeforeLastDay = new Map<Provider, number>();
  const modelTotals = new Map<
    string,
    { model: string; provider: Provider; cost: number }
  >();
  for (const row of thisMonth) {
    const micros = toMicros(row.costUsd);
    providerTotals.set(
      row.provider,
      (providerTotals.get(row.provider) ?? 0) + micros,
    );
    if (row.date < lastReportedDay(row.provider, now)) {
      providerBeforeLastDay.set(
        row.provider,
        (providerBeforeLastDay.get(row.provider) ?? 0) + micros,
      );
    }
    const key = `${row.provider}|${row.model}`;
    const entry = modelTotals.get(key) ?? {
      model: row.model,
      provider: row.provider,
      cost: 0,
    };
    entry.cost += micros;
    modelTotals.set(key, entry);
  }

  // 每家推算到月底的花费（微美元），先不取整：总的预计月底用它们相加
  const projections = new Map<Provider, number>();
  for (const [provider, micros] of providerTotals) {
    projections.set(
      provider,
      projectMicros(
        provider,
        micros,
        providerBeforeLastDay.get(provider) ?? 0,
        now,
      ),
    );
  }

  const byProvider = PROVIDERS.filter((p) => providerTotals.has(p))
    .map((provider) => {
      const cost = providerTotals.get(provider) ?? 0;
      return {
        provider,
        cost: microsToUsd(cost),
        share: monthToDate > 0 ? cost / monthToDate : 0,
        projected: microsToUsd(projections.get(provider) ?? 0),
      };
    })
    .sort((a, b) => b.cost - a.cost);

  // 本月每个模型的 token 数，按 服务商|模型 对上花费
  const tokenTotals = new Map<string, number>();
  for (const t of tokenRows) {
    if (t.date < start || t.date > today) continue;
    const key = `${t.provider}|${t.model}`;
    tokenTotals.set(key, (tokenTotals.get(key) ?? 0) + t.tokens);
  }
  const tokensFor = (provider: Provider, model: string) =>
    tokenTotals.get(`${provider}|${model}`) ?? null;

  // 取整到分后是 $0.00 的模型不列：本月总额和服务商占比都按分算，
  // 总额显示 $0.00、写着"本月还没有花费"时，旁边再列一排 $0.00 的模型就互相矛盾
  const models = [...modelTotals.values()]
    .filter((m) => microsToUsd(m.cost) !== 0)
    .sort((a, b) => b.cost - a.cost);
  const byModel: SpendSummary["byModel"] = models
    .slice(0, TOP_MODELS)
    .map((m) => ({
      ...m,
      cost: microsToUsd(m.cost),
      tokens: tokensFor(m.provider, m.model),
    }));
  const restModels = models.slice(TOP_MODELS);
  const rest = restModels.reduce((sum, m) => sum + m.cost, 0);
  if (rest > 0) {
    const restTokens = restModels
      .map((m) => tokensFor(m.provider, m.model))
      .filter((t): t is number => t !== null);
    byModel.push({
      model: "Other models",
      provider: null,
      cost: microsToUsd(rest),
      tokens: restTokens.length ? restTokens.reduce((a, b) => a + b, 0) : null,
    });
  }

  const days = lastNDays(now, TREND_DAYS);
  const zeroByProvider = () =>
    Object.fromEntries(PROVIDERS.map((p) => [p, 0])) as Record<
      Provider,
      number
    >;
  const dailyMap = new Map<string, DailyPoint>(
    days.map((date) => [date, { date, total: 0, ...zeroByProvider() }]),
  );
  for (const row of rows) {
    const point = dailyMap.get(row.date);
    if (!point) continue;
    const micros = toMicros(row.costUsd);
    point[row.provider] += micros;
    point.total += micros;
  }
  const daily = days.map((date) => {
    const p = dailyMap.get(date)!;
    return {
      date,
      total: microsToUsd(p.total),
      ...(Object.fromEntries(
        PROVIDERS.map((provider) => [provider, microsToUsd(p[provider])]),
      ) as Record<Provider, number>),
    };
  });

  const budgetMicros = budget === null ? null : toMicros(budget);
  // "剩余"用已经取整到分的"已花"来算，界面上"已花 + 剩余"才正好等于预算。
  // 分别取整的话，$330.885 显示成 $330.89、剩余 $269.115 显示成 $269.12，加起来多出一分钱
  const monthToDateUsd = microsToUsd(monthToDate);

  return {
    monthStart: start,
    dayOfMonth,
    daysInMonth: monthDays,
    monthToDate: monthToDateUsd,
    projectedMonthEnd: microsToUsd(
      [...projections.values()].reduce((sum, micros) => sum + micros, 0),
    ),
    budget,
    remaining:
      budgetMicros === null
        ? null
        : microsToUsd(budgetMicros - toMicros(monthToDateUsd)),
    // 和"剩余"一样用取整到分的"已花"来算：提醒是按这个数触发的，
    // 否则 $79.995 显示成 $80.00、触发了 80% 提醒，邮件标题却写 79%
    percentUsed:
      budgetMicros === null ? null : toMicros(monthToDateUsd) / budgetMicros,
    byProvider,
    byModel,
    daily,
    hasData: rows.length > 0,
  };
}

// "预计月底"那一格写哪句提示：none 没设预算，ok 照这个速度不会超，passing 还没超但月底会超，
// over 已经超了。overBy 是预计月底比预算多出的金额（不会超时是 0 或负数），
// 按微美元相减，不会算出 120.02999 这种数
export function projectionStatus(summary: SpendSummary): {
  kind: "none" | "ok" | "passing" | "over";
  overBy: number;
} {
  if (summary.budget === null) return { kind: "none", overBy: 0 };
  const overBy = microsToUsd(
    toMicros(summary.projectedMonthEnd) - toMicros(summary.budget),
  );
  // 预计数是从已花往后推的，不会比已花少，所以已经超了的也满足"会超"，要先判断。
  // 已经超了还写"照这个速度会超"，旁边就是"Over budget by"，读起来像没发现已经超了
  if (summary.remaining !== null && summary.remaining < 0) {
    return { kind: "over", overBy };
  }
  if (summary.projectedMonthEnd > summary.budget) {
    return { kind: "passing", overBy };
  }
  return { kind: "ok", overBy };
}

export function formatUsd(value: number, options?: { compact?: boolean }) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation:
      options?.compact && Math.abs(value) >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 2,
    minimumFractionDigits: options?.compact ? 0 : 2,
  }).format(value);
}

// 每日图纵轴的刻度：从 0 起最多 4 格，每格是 1、2 或 5 乘以 10 的幂，最小一格 1 美分。
// 不用 Recharts 的整数刻度：一天只花几美分时它画成 $0–$4，柱子贴着底线看不见
export function spendAxisTicks(max: number): number[] {
  let step = 0;
  for (let exp = -2; !step; exp++) {
    step = [1, 2, 5].map((m) => m * 10 ** exp).find((s) => max <= s * 4) ?? 0;
  }
  const count = Math.max(1, Math.ceil(max / step - 1e-9));
  return Array.from(
    { length: count + 1 },
    (_, i) => Math.round(i * step * 100) / 100,
  );
}

// 预算用掉的百分比，向下取整：79.6% 显示 79%，不会在真正的 80% 提醒之前就说到了 80%。
// 先去掉浮点误差再取整：0.57 * 100 在 JS 里是 56.99999999999999，直接取整会显示 56%
export function wholePercent(fraction: number): number {
  return Math.floor(Math.round(fraction * 1e8) / 1e6);
}

// "42.2M" / "980K" / "512"
export function formatTokens(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
