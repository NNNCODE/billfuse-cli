export const MAX_BUDGET = 10_000_000;

// 接受 "500"、"$1,200.50" 这类写法，返回金额（最多两位小数）；不合法返回 null
export function parseBudget(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const amount = Number(cleaned);
  if (!(amount > 0) || amount > MAX_BUDGET) return null;
  return amount;
}

// 有没有设预算（参数是总预算、各家预算两次查询的结果）。各家自己的预算也会发提醒（budget-alerts.ts），设了哪个都算。
// 查询出错时当作设了：设置页只是少一个"去设预算"的链接，不能因为它出错
export function hasAnyBudget(
  overall: { data: unknown; error: unknown },
  perProvider: { data: unknown[] | null; error: unknown },
): boolean {
  if (overall.error || perProvider.error) return true;
  return overall.data != null || (perProvider.data?.length ?? 0) > 0;
}
