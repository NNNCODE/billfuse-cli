// 全站日期统一用 UTC：各家服务商的成本数据都按 UTC 自然日分桶

const DAY_MS = 86_400_000;

// YYYY-MM-DD 写成类型，给只收这种写法的地方用（LegalPage 的 updated、指南清单里的日期）：
// 写成 "November 12, 2026" 过不了类型检查。只看样子，是不是真有这一天，guides.test.ts 另外查
export type IsoDay = `${number}-${number}-${number}`;

// YYYY-MM-DD
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, n: number): string {
  return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));
}

// 当月 1 号，YYYY-MM-01
export function monthStart(date: Date): string {
  return `${utcDay(date).slice(0, 7)}-01`;
}

export function daysInMonth(date: Date): number {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
}

// 含今天在内的最近 n 天，从早到晚
export function lastNDays(now: Date, n: number): string[] {
  const today = utcDay(now);
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}

export const TREND_DAYS = 30;

// 每次同步要覆盖的起点：本月 1 号和"最近 30 天"的第一天，取更早的那个
export function syncStartDay(now: Date): string {
  const trendStart = lastNDays(now, TREND_DAYS)[0];
  const month = monthStart(now);
  return trendStart < month ? trendStart : month;
}

// "just now" / "5 min ago" / "3 h ago" / "2 days ago"
export function formatRelative(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// "Oct 12"
export function formatDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// "November 12, 2026"：指南、隐私政策和服务条款页上 "Last updated" 的写法
export function formatLongDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
