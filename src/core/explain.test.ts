import { describe, expect, it } from "vitest";
import { explainSpend } from "./explain";
import type { SpendRow } from "./spend";

const NOW = new Date("2026-10-17T12:00:00Z");

function row(
  date: string,
  costUsd: number,
  model = "gpt-4o",
  provider: SpendRow["provider"] = "openai",
): SpendRow {
  return { date, costUsd, model, provider };
}

// 10 月 3 日到 17 日每天 gpt-4o 花 $10，claude 花 $4
function steadyDays(): SpendRow[] {
  const rows: SpendRow[] = [];
  for (let d = 3; d <= 17; d++) {
    const date = `2026-10-${String(d).padStart(2, "0")}`;
    rows.push(row(date, 10), row(date, 4, "claude-sonnet-4-5", "anthropic"));
  }
  return rows;
}

describe("explainSpend", () => {
  it("returns nothing when there is no spend", () => {
    expect(explainSpend([], NOW)).toBeNull();
  });

  it("names the spike day, the model and how many times its average", () => {
    const rows = steadyDays().map((r) =>
      r.date === "2026-10-12" && r.model === "gpt-4o"
        ? { ...r, costUsd: 50 }
        : r,
    );
    const result = explainSpend(rows, NOW)!;
    expect(result.headline).toBe(
      "On Oct 12, gpt-4o spend was 5.0× its daily average ($50.00 vs about $10.00 a day).",
    );
  });

  it("says when the top day is in line with usual spend", () => {
    const rows = steadyDays().map((r) =>
      r.date === "2026-10-12" && r.model === "gpt-4o"
        ? { ...r, costUsd: 12 }
        : r,
    );
    expect(explainSpend(rows, NOW)!.headline).toBe(
      "Your highest-spend day was Oct 12 ($16.00), in line with your usual spend. gpt-4o was the biggest cost that day.",
    );
  });

  it("doesn't show a sub-cent daily average as $0.00", () => {
    // 平时每天 $0.001，12 日花了 $1.20
    const rows: SpendRow[] = [];
    for (let d = 3; d <= 16; d++) {
      const date = `2026-10-${String(d).padStart(2, "0")}`;
      rows.push(row(date, date === "2026-10-12" ? 1.2 : 0.001));
    }
    const result = explainSpend(rows, NOW)!;
    expect(result.headline).toBe(
      "On Oct 12, gpt-4o spend was 1200× its daily average ($1.20 vs under $0.01 a day).",
    );
    expect(result.details[0]).toContain(": $1.21, 100% of spend.");
  });

  it("doesn't call a jump of a few cents a spike", () => {
    // 金额很小的账号：10 月 3 日到 16 日每天 $0.001，12 日花了 $0.06，原来写成"60 倍"
    const rows: SpendRow[] = [];
    for (let d = 3; d <= 16; d++) {
      const date = `2026-10-${String(d).padStart(2, "0")}`;
      rows.push(row(date, date === "2026-10-12" ? 0.06 : 0.001));
    }
    const result = explainSpend(rows, NOW)!;
    expect(result.headline).toBe(
      "Your highest-spend day was Oct 12 ($0.06). gpt-4o was the biggest cost that day.",
    );
    expect(result.details[0]).toContain(": $0.07, 100% of spend.");
  });

  it("doesn't show sub-cent spend as $0.00", () => {
    const result = explainSpend([row("2026-10-17", 0.003)], NOW)!;
    expect(result.headline).toBe(
      "All of your recorded spend is from Oct 17 (under $0.01), mostly gpt-4o. Check back after a few days of usage for a comparison.",
    );
  });

  it("calls out a model that only appeared on the top day", () => {
    const rows = [...steadyDays(), row("2026-10-15", 80, "o3-pro")];
    expect(explainSpend(rows, NOW)!.headline).toBe(
      "On Oct 15, o3-pro cost $80.00. It wasn't used on any other day in the last 30 days, so this is new spend.",
    );
  });

  it("reports the most expensive model and its share", () => {
    const result = explainSpend(steadyDays(), NOW)!;
    // 15 天 × $10 = $150，占总额 $210 的 71%
    expect(result.details).toEqual([
      "gpt-4o (OpenAI) is your most expensive model over the last 30 days: $150.00, 71% of spend.",
    ]);
  });

  it("handles a single day of data", () => {
    const result = explainSpend([row("2026-10-17", 3)], NOW)!;
    expect(result.headline).toBe(
      "All of your recorded spend is from Oct 17 ($3.00), mostly gpt-4o. Check back after a few days of usage for a comparison.",
    );
  });

  it("leaves today's unfinished day out of the usual average", () => {
    // 今天才过了一会儿，只花了 $1；它不该把"平时"拉低
    const rows = steadyDays().map((r) =>
      r.date === "2026-10-17" && r.model === "gpt-4o"
        ? { ...r, costUsd: 1 }
        : r.date === "2026-10-12" && r.model === "gpt-4o"
          ? { ...r, costUsd: 50 }
          : r,
    );
    expect(explainSpend(rows, NOW)!.headline).toBe(
      "On Oct 12, gpt-4o spend was 5.0× its daily average ($50.00 vs about $10.00 a day).",
    );
  });

  it("says when the spike came from more usage", () => {
    const rows = steadyDays().map((r) =>
      r.date === "2026-10-12" && r.model === "gpt-4o"
        ? { ...r, costUsd: 50 }
        : r,
    );
    const tokens = rows
      .filter((r) => r.model === "gpt-4o")
      .map((r) => ({
        provider: "openai" as const,
        date: r.date,
        model: "gpt-4o",
        tokens: r.costUsd * 100_000,
      }));
    expect(explainSpend(rows, NOW, tokens)!.details[0]).toBe(
      "Token usage for gpt-4o that day was 5.0× normal (5M tokens), so the spike came from more usage.",
    );
  });

  it("says when the spike came from pricier requests", () => {
    const rows = steadyDays().map((r) =>
      r.date === "2026-10-12" && r.model === "gpt-4o"
        ? { ...r, costUsd: 50 }
        : r,
    );
    // token 数每天一样：花得多是因为每次更贵
    const tokens = rows
      .filter((r) => r.model === "gpt-4o")
      .map((r) => ({
        provider: "openai" as const,
        date: r.date,
        model: "gpt-4o",
        tokens: 1_000_000,
      }));
    expect(explainSpend(rows, NOW, tokens)!.details[0]).toBe(
      "Token usage for gpt-4o that day was close to normal (1.0×), so each token cost more than usual. Look for fewer cache hits, more output tokens, or a pricier tier.",
    );
  });

  it("doesn't call a drop in tokens 'close to normal'", () => {
    const rows = steadyDays().map((r) =>
      r.date === "2026-10-12" && r.model === "gpt-4o"
        ? { ...r, costUsd: 50 }
        : r,
    );
    // 花费涨了 5 倍，token 却只有平时的 0.4
    const tokens = rows
      .filter((r) => r.model === "gpt-4o")
      .map((r) => ({
        provider: "openai" as const,
        date: r.date,
        model: "gpt-4o",
        tokens: r.date === "2026-10-12" ? 400_000 : 1_000_000,
      }));
    expect(explainSpend(rows, NOW, tokens)!.details[0]).toBe(
      "Token usage for gpt-4o that day was below normal (0.4×) even though spend jumped, so each token cost much more than usual. Look for fewer cache hits, more output tokens, or a pricier tier.",
    );
  });

  it("adds no token note without token data", () => {
    const rows = steadyDays().map((r) =>
      r.date === "2026-10-12" && r.model === "gpt-4o"
        ? { ...r, costUsd: 50 }
        : r,
    );
    expect(explainSpend(rows, NOW)!.details).toHaveLength(1);
  });

  it("ignores spend outside the last 30 days", () => {
    const rows = [...steadyDays(), row("2026-09-01", 9999, "old-model")];
    expect(explainSpend(rows, NOW)!.headline).not.toContain("old-model");
  });
});
