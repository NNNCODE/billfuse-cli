import { formatDay, lastNDays, TREND_DAYS, utcDay } from "./dates";
import { PROVIDER_LABEL, type Provider } from "./providers/types";
import { formatTokens, formatUsd, type SpendRow, type TokenRow } from "./spend";

// 用一两句话说明钱花在了哪里。规则固定、可测试，不调用任何 AI 模型：
// 1. 找出最近 30 天花费最高的一天，以及那天花得最多的模型；
// 2. 把这个模型当天的花费和它在其他日子的日均花费比较，得出"是平时的几倍"（当天不到 $1 不说倍数）；
// 3. 有 token 数据时，再看用量是否同步上涨，区分"用得多了"还是"每次更贵了"；
// 4. 再补一句：30 天里最贵的模型是哪个、占多少。

export type Explanation = {
  headline: string;
  details: string[];
};

// 达到平时的这么多倍才算"异常"
export const SPIKE_RATIO = 1.5;

// 那天这个模型花得不到这么多美元，就不说"是平时的几倍"：
// 几美分的波动能算出"134 倍"，花得很少的用户看了会白担心
export const SPIKE_MIN_USD = 1;

type ModelKey = string; // `${provider}|${model}`

function keyOf(row: SpendRow): ModelKey {
  return `${row.provider}|${row.model}`;
}

function parseKey(key: ModelKey): { provider: Provider; model: string } {
  const bar = key.indexOf("|");
  return {
    provider: key.slice(0, bar) as Provider,
    model: key.slice(bar + 1),
  };
}

// "4.2×"、"12×"；突增提醒的邮件也用（email/spend-spike.ts）
export function formatRatio(ratio: number): string {
  return ratio >= 10 ? `${Math.round(ratio)}×` : `${ratio.toFixed(1)}×`;
}

// 不到半美分的花费按两位小数会显示成 $0.00，读起来像"没花钱"，
// "是 $0.00 的 54 倍"也说不通，所以写成 under $0.01
function formatAmount(value: number): string {
  return value < 0.005 ? "under $0.01" : formatUsd(value);
}

function formatDailyAverage(value: number): string {
  return value < 0.005 ? "under $0.01" : `about ${formatUsd(value)}`;
}

export function explainSpend(
  rows: SpendRow[],
  now: Date,
  tokenRows: TokenRow[] = [],
): Explanation | null {
  const window = new Set(lastNDays(now, TREND_DAYS));
  const inWindow = rows.filter((r) => window.has(r.date) && r.costUsd > 0);
  if (inWindow.length === 0) return null;

  const dayTotals = new Map<string, number>();
  const modelTotals = new Map<ModelKey, number>();
  const modelByDay = new Map<string, Map<ModelKey, number>>();
  for (const row of inWindow) {
    dayTotals.set(row.date, (dayTotals.get(row.date) ?? 0) + row.costUsd);
    modelTotals.set(
      keyOf(row),
      (modelTotals.get(keyOf(row)) ?? 0) + row.costUsd,
    );
    const perModel = modelByDay.get(row.date) ?? new Map<ModelKey, number>();
    perModel.set(keyOf(row), (perModel.get(keyOf(row)) ?? 0) + row.costUsd);
    modelByDay.set(row.date, perModel);
  }

  const total = [...dayTotals.values()].reduce((a, b) => a + b, 0);
  const [topDay, topDayTotal] = [...dayTotals.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0];
  const [driverKey, driverOnTopDay] = [
    ...(modelByDay.get(topDay)?.entries() ?? []),
  ].sort((a, b) => b[1] - a[1])[0];
  const driver = parseKey(driverKey);

  // 从有数据的第一天算起，避免把连接 Billfuse 之前的空白天也算进"平时"；
  // 今天还没过完、花费偏低，也不算进"平时"，否则倍数会被夸大
  const firstDay = [...dayTotals.keys()].sort()[0];
  const today = utcDay(now);
  const otherDays = [...window].filter(
    (d) => d >= firstDay && d < today && d !== topDay,
  );

  const details: string[] = [];
  const [topModelKey, topModelCost] = [...modelTotals.entries()].sort(
    (a, b) => b[1] - a[1],
  )[0];
  const topModel = parseKey(topModelKey);
  details.push(
    `${topModel.model} (${PROVIDER_LABEL[topModel.provider]}) is your most expensive model over the last 30 days: ${formatAmount(topModelCost)}, ${Math.round((topModelCost / total) * 100)}% of spend.`,
  );

  if (otherDays.length === 0) {
    return {
      headline: `All of your recorded spend is from ${formatDay(topDay)} (${formatAmount(topDayTotal)}), mostly ${driver.model}. Check back after a few days of usage for a comparison.`,
      details,
    };
  }

  const driverElsewhere = otherDays.reduce(
    (sum, d) => sum + (modelByDay.get(d)?.get(driverKey) ?? 0),
    0,
  );
  const baseline = driverElsewhere / otherDays.length;
  const day = formatDay(topDay);

  let headline: string;
  if (baseline <= 0) {
    headline = `On ${day}, ${driver.model} cost ${formatAmount(driverOnTopDay)}. It wasn't used on any other day in the last 30 days, so this is new spend.`;
  } else if (
    driverOnTopDay / baseline >= SPIKE_RATIO &&
    driverOnTopDay >= SPIKE_MIN_USD
  ) {
    headline = `On ${day}, ${driver.model} spend was ${formatRatio(driverOnTopDay / baseline)} its daily average (${formatAmount(driverOnTopDay)} vs ${formatDailyAverage(baseline)} a day).`;
    const tokenNote = explainTokens(tokenRows, driver, topDay, otherDays);
    if (tokenNote) details.unshift(tokenNote);
  } else if (driverOnTopDay / baseline >= SPIKE_RATIO) {
    headline = `Your highest-spend day was ${day} (${formatAmount(topDayTotal)}). ${driver.model} was the biggest cost that day.`;
  } else {
    headline = `Your highest-spend day was ${day} (${formatAmount(topDayTotal)}), in line with your usual spend. ${driver.model} was the biggest cost that day.`;
  }

  return { headline, details };
}

// 花费突增时，看 token 用量有没有同样突增：
// 一起涨 → 是用得更多了；token 没怎么涨 → 是每次请求更贵了（更长的上下文、更贵的档位等）
function explainTokens(
  tokenRows: TokenRow[],
  driver: { provider: Provider; model: string },
  topDay: string,
  otherDays: string[],
): string | null {
  const byDay = new Map<string, number>();
  for (const t of tokenRows) {
    if (t.provider !== driver.provider || t.model !== driver.model) continue;
    byDay.set(t.date, (byDay.get(t.date) ?? 0) + t.tokens);
  }
  const onTopDay = byDay.get(topDay);
  const baseline =
    otherDays.reduce((sum, d) => sum + (byDay.get(d) ?? 0), 0) /
    otherDays.length;
  if (!onTopDay || !(baseline > 0)) return null;

  const ratio = onTopDay / baseline;
  if (ratio >= SPIKE_RATIO) {
    return `Token usage for ${driver.model} that day was ${formatRatio(ratio)} normal (${formatTokens(onTopDay)} tokens), so the spike came from more usage.`;
  }
  // token 数里已经包含缓存读写，所以"提示词变长"会让 token 一起涨，不能用来解释这种情况
  const hint =
    "Look for fewer cache hits, more output tokens, or a pricier tier.";
  if (ratio <= 1 / SPIKE_RATIO) {
    return `Token usage for ${driver.model} that day was below normal (${formatRatio(ratio)}) even though spend jumped, so each token cost much more than usual. ${hint}`;
  }
  return `Token usage for ${driver.model} that day was close to normal (${formatRatio(ratio)}), so each token cost more than usual. ${hint}`;
}
