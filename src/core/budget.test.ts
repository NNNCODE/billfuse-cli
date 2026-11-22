import { describe, expect, it } from "vitest";
import { hasAnyBudget, parseBudget } from "./budget";

describe("parseBudget", () => {
  it("accepts plain and formatted dollar amounts", () => {
    expect(parseBudget("500")).toBe(500);
    expect(parseBudget(" $1,200.50 ")).toBe(1200.5);
    expect(parseBudget("0.5")).toBe(0.5);
  });

  it("rejects zero, negatives, junk and absurd amounts", () => {
    for (const raw of ["", "0", "-5", "abc", "12.345", "1e5", "10000000.01"]) {
      expect(parseBudget(raw)).toBeNull();
    }
  });
});

// 决定设置页连上密钥后要不要给"去设预算"的链接
describe("hasAnyBudget", () => {
  const noBudget = { data: null, error: null };
  const noProviderBudgets = { data: [], error: null };
  const failed = { data: null, error: { message: "connection refused" } };

  it("is false when neither kind of budget is set", () => {
    expect(hasAnyBudget(noBudget, noProviderBudgets)).toBe(false);
  });

  it("counts the overall budget", () => {
    expect(
      hasAnyBudget({ data: { user_id: "u1" }, error: null }, noProviderBudgets),
    ).toBe(true);
  });

  // 各家自己的预算也会发提醒，只设了它也不用再提示
  it("counts a provider budget on its own", () => {
    expect(
      hasAnyBudget(noBudget, {
        data: [{ provider: "anthropic" }],
        error: null,
      }),
    ).toBe(true);
  });

  // 查不出来时不提示，免得叫已经设了预算的人再去设
  it("counts a failed lookup as set", () => {
    expect(hasAnyBudget(failed, noProviderBudgets)).toBe(true);
    expect(hasAnyBudget(noBudget, failed)).toBe(true);
  });
});
