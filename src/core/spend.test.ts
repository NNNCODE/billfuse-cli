import { describe, expect, it } from "vitest";
import {
  formatUsd,
  projectionStatus,
  spendAxisTicks,
  summarizeSpend,
  TOP_MODELS,
  wholePercent,
  type SpendRow,
} from "./spend";

const NOW = new Date("2026-10-10T15:00:00Z"); // 10 月第 10 天，10 月共 31 天

function row(
  date: string,
  costUsd: number,
  provider: SpendRow["provider"] = "openai",
  model = "gpt-4o",
): SpendRow {
  return { date, costUsd, provider, model };
}

describe("summarizeSpend", () => {
  it("adds up only this month for the month-to-date total", () => {
    const s = summarizeSpend(
      [row("2026-09-30", 100), row("2026-10-01", 10), row("2026-10-10", 5)],
      null,
      NOW,
    );
    expect(s.monthToDate).toBe(15);
  });

  it("rounds totals to the cent the same way the database does", () => {
    // 330.885 用浮点数直接 ×100 会得到 33088.4999…，旧写法会少算一分钱
    const s = summarizeSpend(
      [row("2026-10-01", 200.5), row("2026-10-02", 130.385)],
      null,
      NOW,
    );
    expect(s.monthToDate).toBe(330.89);
    expect(
      summarizeSpend([row("2026-10-01", 1.005)], null, NOW).monthToDate,
    ).toBe(1.01);
  });

  it("rounds an over-budget amount away from zero, matching the total", () => {
    const s = summarizeSpend([row("2026-10-01", 330.885)], 300, NOW);
    expect(s.monthToDate).toBe(330.89);
    expect(s.remaining).toBe(-30.89);
  });

  it("makes spent + remaining add up to the budget exactly", () => {
    const s = summarizeSpend([row("2026-10-01", 330.885)], 600, NOW);
    expect(s.monthToDate).toBe(330.89);
    // 不是 269.12：两个数分别取整会多出一分钱
    expect(s.remaining).toBe(269.11);
  });

  it("projects month-end spend from the daily average so far", () => {
    // 10 日 15:00：前 9 天花了 100，日均 11.11；本月还剩今天的 0.375 天加后面 21 天，再花 237.50
    const s = summarizeSpend([row("2026-10-03", 100)], null, NOW);
    expect(s.projectedMonthEnd).toBe(337.5);
  });

  it("projects OpenRouter from the days it has reported, which ends yesterday", () => {
    // 10 月 2 日：OpenAI 有 2 天的数据，OpenRouter 只有 1 天（今天的要明天才有）
    const oct2 = new Date("2026-10-02T12:00:00Z");
    const s = summarizeSpend(
      [
        row("2026-10-01", 50),
        row("2026-10-02", 50),
        row("2026-10-01", 100, "openrouter", "anthropic/claude-sonnet-4.5"),
      ],
      null,
      oct2,
    );
    // OpenRouter 100 / 1 天 × 31 = 3100。OpenAI 1 号花了 50，今天到中午也花了 50，
    // 已经够一天的日均，今天不再往上加；后面 29 天每天 50，一共 1550
    expect(
      s.byProvider.find((p) => p.provider === "openrouter")?.projected,
    ).toBe(3100);
    expect(s.projectedMonthEnd).toBe(4650);
  });

  it("can't project OpenRouter on the 1st, before it has reported a day", () => {
    const oct1 = new Date("2026-10-01T12:00:00Z");
    const s = summarizeSpend([row("2026-10-01", 20)], null, oct1);
    expect(s.projectedMonthEnd).toBe(620);
  });

  it("computes budget remaining and percent used", () => {
    const s = summarizeSpend([row("2026-10-02", 80)], 100, NOW);
    expect(s.remaining).toBe(20);
    expect(s.percentUsed).toBeCloseTo(0.8);
  });

  it("reports a negative remaining amount when over budget", () => {
    const s = summarizeSpend([row("2026-10-02", 130)], 100, NOW);
    expect(s.remaining).toBe(-30);
    expect(s.percentUsed).toBeCloseTo(1.3);
  });

  it("leaves budget fields empty when no budget is set", () => {
    const s = summarizeSpend([row("2026-10-02", 1)], null, NOW);
    expect(s.remaining).toBeNull();
    expect(s.percentUsed).toBeNull();
  });

  it("splits this month by provider, largest first, with shares", () => {
    const s = summarizeSpend(
      [
        row("2026-10-02", 30, "openai"),
        row("2026-10-02", 70, "anthropic", "claude-sonnet-4-5"),
      ],
      null,
      NOW,
    );
    // projected：已花的，加上前 9 天的日均乘本月还剩的 21.375 天
    expect(s.byProvider).toEqual([
      { provider: "anthropic", cost: 70, share: 0.7, projected: 236.25 },
      { provider: "openai", cost: 30, share: 0.3, projected: 101.25 },
    ]);
  });

  it("keeps the top models and folds the rest into one bar", () => {
    const rows = Array.from({ length: TOP_MODELS + 3 }, (_, i) =>
      row("2026-10-05", 100 - i, "openai", `model-${i}`),
    );
    const s = summarizeSpend(rows, null, NOW);
    expect(s.byModel).toHaveLength(TOP_MODELS + 1);
    expect(s.byModel[0]).toEqual({
      model: "model-0",
      provider: "openai",
      cost: 100,
      tokens: null,
    });
    expect(s.byModel.at(-1)).toEqual({
      model: "Other models",
      provider: null,
      cost: 100 - 8 + (100 - 9) + (100 - 10),
      tokens: null,
    });
  });

  it("leaves out models whose cost rounds to $0.00", () => {
    // 金额很小的账号：本月只有两个转写模型，各花了不到半美分，
    // "By model" 列出两行 $0.00，"By provider" 却写本月还没有花费
    const s = summarizeSpend(
      [
        row("2026-10-05", 0.002, "openai", "gpt-4o-mini-transcribe audio"),
        row("2026-10-05", 0.001, "openai", "gpt-4o-mini-transcribe text"),
      ],
      null,
      NOW,
    );
    expect(s.monthToDate).toBe(0);
    expect(s.byModel).toEqual([]);
  });

  it("keeps a model that reaches a cent once its days are added up", () => {
    const s = summarizeSpend(
      [row("2026-10-04", 0.003), row("2026-10-05", 0.003)],
      null,
      NOW,
    );
    expect(s.byModel).toEqual([
      { model: "gpt-4o", provider: "openai", cost: 0.01, tokens: null },
    ]);
  });

  it("attaches this month's tokens to each model", () => {
    const s = summarizeSpend(
      [row("2026-10-05", 10, "openai", "gpt-4o")],
      null,
      NOW,
      [
        {
          provider: "openai",
          date: "2026-10-05",
          model: "gpt-4o",
          tokens: 1000,
        },
        {
          provider: "openai",
          date: "2026-10-06",
          model: "gpt-4o",
          tokens: 500,
        },
        // 上个月的不算
        {
          provider: "openai",
          date: "2026-09-30",
          model: "gpt-4o",
          tokens: 9999,
        },
        // 同名模型但属于另一家，不能算到 OpenAI 头上
        {
          provider: "anthropic",
          date: "2026-10-05",
          model: "gpt-4o",
          tokens: 7,
        },
      ],
    );
    expect(s.byModel[0].tokens).toBe(1500);
  });

  it("fills 30 days of daily totals, including empty days", () => {
    const s = summarizeSpend(
      [
        row("2026-10-10", 4, "openai"),
        row("2026-10-10", 6, "anthropic", "claude"),
        row("2026-09-11", 2),
        row("2026-09-10", 999), // 超出 30 天窗口
      ],
      null,
      NOW,
    );
    expect(s.daily).toHaveLength(30);
    expect(s.daily[0]).toEqual({
      date: "2026-09-11",
      total: 2,
      openai: 2,
      anthropic: 0,
      openrouter: 0,
      gemini: 0,
      xai: 0,
    });
    expect(s.daily[29]).toEqual({
      date: "2026-10-10",
      total: 10,
      openai: 4,
      anthropic: 6,
      openrouter: 0,
      gemini: 0,
      xai: 0,
    });
    expect(s.daily[15].total).toBe(0);
  });

  it("knows when there is no data at all", () => {
    expect(summarizeSpend([], 100, NOW).hasData).toBe(false);
  });
});

describe("projecting providers that report today's spend", () => {
  // OpenAI 和 Anthropic 连今天还没过完的那天也报。11 月有 30 天
  const claude = (date: string, costUsd: number) =>
    row(date, costUsd, "anthropic", "claude-sonnet-4-5");
  // 11 月 1 日起每天 $10，一共 days 天
  const tenADay = (days: number) =>
    Array.from({ length: days }, (_, i) =>
      claude(`2026-11-${String(i + 1).padStart(2, "0")}`, 10),
    );
  const projected = (rows: SpendRow[], now: string) =>
    summarizeSpend(rows, null, new Date(now)).projectedMonthEnd;

  it("follows a steady pace from the 2nd, while today is still running", () => {
    // 2 号 06:00，今天已经花了 $2.50。原来把今天当成整天：12.50 / 2 × 30 = 187.50
    expect(
      projected(
        [...tenADay(1), claude("2026-11-02", 2.5)],
        "2026-11-02T06:00:00Z",
      ),
    ).toBe(300);
  });

  it("doesn't drop at midnight, or while today's spend hasn't come in", () => {
    // 原来 6 号零点一过就变成 50 / 6 × 30 = 250，前一秒还是 300
    expect(projected(tenADay(5), "2026-11-05T23:59:59Z")).toBe(300);
    expect(projected(tenADay(5), "2026-11-06T00:00:01Z")).toBe(300);
    // 2 号 06:00，今天的花费还没报上来：按 1 号的 $10 一天算，10 + 10 × 28.75
    expect(projected(tenADay(1), "2026-11-02T06:00:00Z")).toBe(297.5);
    // 今天过去的时间按分钟算，不是按整点：06:30 还剩 28.729 天
    expect(projected(tenADay(1), "2026-11-02T06:30:00Z")).toBe(297.29);
  });

  it("keeps up with a surge that started today", () => {
    // 10 号 06:00：前 9 天每天 $10，今天已经花了 $300（比如 agent 卡在循环里）。
    // 今天已经比平常一整天多，就把今天当成整天：日均 $39，390 + 39 × 20 = 1170，和原来一样。
    // 只看前 9 天的日均是 597.50，看不出今天在猛涨
    expect(
      projected(
        [...tenADay(9), claude("2026-11-10", 300)],
        "2026-11-10T06:00:00Z",
      ),
    ).toBe(1170);
  });

  it("doesn't count today twice when its spend comes in early", () => {
    // 每天 UTC 零点跑一次、花 $10 的任务。2 号 01:00 今天的 $10 已经到了：
    // 再按今天剩下的 23 小时加一份会是 309.58，按"2 号才过了 1 小时"去算速度更是 576
    expect(projected(tenADay(2), "2026-11-02T01:00:00Z")).toBe(300);
    // 亚太的上班时间：5 号 06:00 今天已经花了 $8，比平均的速度快，但还不到一天的 $10
    expect(
      projected(
        [...tenADay(4), claude("2026-11-05", 8)],
        "2026-11-05T06:00:00Z",
      ),
    ).toBe(300);
  });

  it("ends at the month's total in the last millisecond of the month", () => {
    // 每周摘要报上个月的合计时用的就是这一刻（见 digest.ts），不能多出今天剩下的那一点
    const s = summarizeSpend(
      [
        row("2026-10-01", 100),
        row("2026-10-31", 20.37),
        claude("2026-10-15", 33.33),
        claude("2026-10-31", 250),
      ],
      null,
      new Date("2026-10-31T23:59:59.999Z"),
    );
    expect(s.projectedMonthEnd).toBe(s.monthToDate);
    // 最后一天比平常花得少，也不按"今天至少花一天的日均"往上补
    expect(
      projected(
        [...tenADay(29), claude("2026-11-30", 2)],
        "2026-11-30T23:59:59.999Z",
      ),
    ).toBe(292);
  });
});

describe("projecting Gemini, whose billing export runs about a day behind", () => {
  // 10 月有 31 天。每天 $10，到月底一共 $310
  const gemini = (date: string, costUsd: number) =>
    row(date, costUsd, "gemini", "gemini-2.5-flash");
  // 10 月 1 日起每天 $10，一共 days 整天，再加上导出了一部分的下一天
  const exported = (days: number, partial: number) => [
    ...Array.from({ length: days }, (_, i) =>
      gemini(`2026-10-${String(i + 1).padStart(2, "0")}`, 10),
    ),
    gemini(`2026-10-${String(days + 1).padStart(2, "0")}`, partial),
  ];
  const projected = (rows: SpendRow[], now: string) =>
    summarizeSpend(rows, null, new Date(now)).projectedMonthEnd;

  it("fills in yesterday's spend that hasn't been exported yet", () => {
    // 晚 24 小时：3 号 06:00 只有 1 号整天和 2 号前 6 小时。原来 12.50 / 2 × 31 = 193.75
    expect(projected(exported(1, 2.5), "2026-10-03T06:00:00Z")).toBe(310);
    // 21 号 06:00：原来 192.50 / 20 × 31 = 298.38
    expect(projected(exported(19, 2.5), "2026-10-21T06:00:00Z")).toBe(310);
  });

  it("stays close when the export is more than a day behind", () => {
    // 晚 36 小时：21 号 06:00 只到 19 号 18:00，19 号也不全，按整天算会低一点。原来 187.50 / 20 × 31 = 290.63
    expect(projected(exported(18, 7.5), "2026-10-21T06:00:00Z")).toBe(303.45);
  });

  it("tops up a quiet yesterday less as the day goes on", () => {
    // 1–19 号每天 $10，20 号真的一分钱没花（不是没导出），之后每天 $10，实际 $300。
    // 06:00 补 0.75 天的日均，20:00 只补 1/6 天；不按时间缩小的话一整天都是 $310
    const quiet = exported(18, 10);
    expect(projected(quiet, "2026-10-21T06:00:00Z")).toBe(307.5);
    expect(projected(quiet, "2026-10-21T20:00:00Z")).toBe(301.67);
  });

  it("doesn't add more once yesterday is fully exported", () => {
    expect(projected(exported(19, 10), "2026-10-21T20:00:00Z")).toBe(310);
    // 昨天花了 $52（比如 agent 卡在循环里）：把昨天当成整天，日均 $12.10，242 + 12.10 × 11
    expect(projected(exported(19, 52), "2026-10-21T20:00:00Z")).toBe(375.1);
  });

  it("can only use the one day it has on the 2nd, and nothing on the 1st", () => {
    expect(projected([gemini("2026-10-01", 10)], "2026-10-02T06:00:00Z")).toBe(
      310,
    );
    expect(projected([], "2026-10-01T06:00:00Z")).toBe(0);
  });
});

describe("projectionStatus", () => {
  // 只看预算、剩余和预计月底；其余字段用一份 $420 预算的空汇总补上
  const base = summarizeSpend([], 420, NOW);

  it("has nothing to say without a budget", () => {
    const s = summarizeSpend([row("2026-10-02", 100)], null, NOW);
    expect(projectionStatus(s)).toEqual({ kind: "none", overBy: 0 });
  });

  it("stays quiet when the pace keeps the month under budget", () => {
    expect(
      projectionStatus({
        ...base,
        monthToDate: 100,
        remaining: 320,
        projectedMonthEnd: 310,
      }),
    ).toEqual({ kind: "ok", overBy: -110 });
  });

  it("warns that the month will pass the budget before it has", () => {
    expect(
      projectionStatus({
        ...base,
        monthToDate: 300,
        remaining: 120,
        projectedMonthEnd: 540,
      }),
    ).toEqual({ kind: "passing", overBy: 120 });
  });

  it("says how far over the month will end once spend is past the budget", () => {
    // 演示页 10 月 25 日的数：已经超了 $12.99，再说"照这个速度会超"就像没发现。
    // 540.03 - 420 直接相减是 120.02999…
    expect(
      projectionStatus({
        ...base,
        monthToDate: 432.99,
        remaining: -12.99,
        projectedMonthEnd: 540.03,
      }),
    ).toEqual({ kind: "over", overBy: 120.03 });
  });
});

describe("formatUsd", () => {
  it("formats dollars", () => {
    expect(formatUsd(1234.5)).toBe("$1,234.50");
    expect(formatUsd(-30)).toBe("-$30.00");
  });

  it("can shorten large axis labels", () => {
    expect(formatUsd(25_000, { compact: true })).toBe("$25K");
    expect(formatUsd(40, { compact: true })).toBe("$40");
  });
});

describe("spendAxisTicks", () => {
  it("scales the axis to small spend instead of whole dollars", () => {
    // 金额很小的账号最高一天是 $0.06，原来的纵轴是 $0–$4
    expect(spendAxisTicks(0.06)).toEqual([0, 0.02, 0.04, 0.06]);
    expect(spendAxisTicks(0.003)).toEqual([0, 0.01]);
    expect(spendAxisTicks(0)).toEqual([0, 0.01]);
  });

  it("keeps round steps for larger spend", () => {
    expect(spendAxisTicks(4.2)).toEqual([0, 2, 4, 6]);
    expect(spendAxisTicks(37)).toEqual([0, 10, 20, 30, 40]);
    expect(spendAxisTicks(25_000)).toEqual([0, 10_000, 20_000, 30_000]);
  });
});

describe("wholePercent", () => {
  it("rounds down without floating-point noise", () => {
    // 0.57 * 100 在 JS 里是 56.99999999999999
    expect(wholePercent(0.57)).toBe(57);
    expect(wholePercent(0.29)).toBe(29);
    expect(wholePercent(0.796)).toBe(79);
    expect(wholePercent(0.8)).toBe(80);
    expect(wholePercent(1.1)).toBe(110);
    expect(wholePercent(0)).toBe(0);
  });
});
