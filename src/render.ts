import { wholePercent } from "./shared.js";
import type { CliStatus } from "./types.js";

// 把服务端返回的数据排成终端里的几行字。纯函数，方便测试

// 百分比的取整和网站用同一个函数（src/lib/spend.ts）：以前这里抄了一份，两边可能改岔
export { wholePercent };

// 和网站的三档告警一致：50% 提示、80% 警告、100% 超预算
export type AlertLevel = "ok" | "notice" | "warning" | "over";

export function alertLevel(status: CliStatus): AlertLevel {
  const p = status.percentUsed;
  if (p === null) return "ok";
  if (p >= 1) return "over";
  if (p >= 0.8) return "warning";
  if (p >= 0.5) return "notice";
  return "ok";
}

export function levelRank(level: AlertLevel): number {
  return { ok: 0, notice: 1, warning: 2, over: 3 }[level];
}

type Paint = (text: string) => string;

export function painter(color: boolean) {
  const wrap =
    (open: string, close: string): Paint =>
    (text) =>
      color ? `\x1b[${open}m${text}\x1b[${close}m` : text;
  return {
    bold: wrap("1", "22"),
    dim: wrap("2", "22"),
    red: wrap("31", "39"),
    yellow: wrap("33", "39"),
    green: wrap("32", "39"),
    inverseRed: wrap("1;41;97", "0"),
    inverseYellow: wrap("1;43;30", "0"),
    inverseCyan: wrap("1;46;30", "0"),
  };
}

export function usd(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value);
}

function tokens(value: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function relative(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(Math.max(fraction, 0), 1) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// 超预算或接近预算时，放在最上面的醒目横幅
export function banner(status: CliStatus, color: boolean): string | null {
  const p = painter(color);
  const level = alertLevel(status);
  if (level === "over" && status.budget !== null) {
    return p.inverseRed(
      ` OVER BUDGET: ${usd(status.monthToDate)} spent of ${usd(status.budget)} this month `,
    );
  }
  if (level === "warning" && status.percentUsed !== null) {
    return p.inverseYellow(
      ` ${wholePercent(status.percentUsed)}% of your monthly budget is used `,
    );
  }
  if (level === "notice" && status.percentUsed !== null) {
    return p.inverseCyan(
      ` Halfway: ${wholePercent(status.percentUsed)}% of your monthly budget is used `,
    );
  }
  return null;
}

// local：数据是 check 命令在这台电脑上直接向服务商读的，不是从 Billfuse 网站来的。
// 这时没有"同步"和"控制台"，相关的几处文字要换掉
export function renderStatus(
  status: CliStatus,
  options: { color: boolean; now?: Date; local?: boolean },
): string {
  const p = painter(options.color);
  const now = options.now ?? new Date();
  const lines: string[] = [];
  const level = alertLevel(status);
  const levelPaint =
    level === "over" ? p.red : level === "warning" ? p.yellow : p.green;

  const top = banner(status, options.color);
  if (top) lines.push(top, "");

  lines.push(p.bold(`Billfuse · ${monthLabel(status.month)} (UTC)`), "");

  // check 有服务商没读到时，下面的合计是少算的。不先说清楚，"0% used"读起来像没事
  const unread = options.local
    ? status.providers.filter((provider) => provider.error)
    : [];
  if (unread.length > 0) {
    lines.push(
      p.red(
        `  Incomplete: ${unread.map((provider) => provider.name).join(", ")} couldn't be read, so the totals below leave ${unread.length === 1 ? "it" : "them"} out.`,
      ),
      "",
    );
  }

  // 先补空格再上色：颜色控制符本身不占宽度，先上色会把对齐算错
  const row = (
    label: string,
    value: string,
    note = "",
    paint: (s: string) => string = (s) => s,
  ) =>
    `  ${label.padEnd(18)}${paint(value.padStart(12))}${note ? `   ${note}` : ""}`;

  lines.push(row("Spent this month", usd(status.monthToDate), "", p.bold));
  if (status.budget === null || status.percentUsed === null) {
    lines.push(
      row(
        "Budget",
        "—",
        p.dim(
          options.local
            ? "add --budget <usd> to check against one"
            : "no budget set",
        ),
      ),
    );
  } else {
    const remaining = status.remaining ?? 0;
    lines.push(
      row(
        "Budget",
        usd(status.budget),
        levelPaint(
          remaining < 0
            ? `${wholePercent(status.percentUsed)}% used · ${usd(-remaining)} over`
            : `${wholePercent(status.percentUsed)}% used · ${usd(remaining)} left`,
        ),
      ),
    );
  }
  // 和网站控制台一样（spend.ts 的 projectionStatus）：已经超了就不说"会超"，说月底会超多少。
  // 上一行就是 "$X over"，再写"照这个速度会超"读起来像没发现已经超了
  const projectedNote =
    status.budget === null || status.projectedMonthEnd <= status.budget
      ? p.dim("at the current pace")
      : (status.remaining ?? 0) < 0
        ? p.red(
            `on pace to end ${usd(status.projectedMonthEnd - status.budget)} over budget`,
          )
        : p.yellow("on pace to pass your budget");
  lines.push(row("Projected", usd(status.projectedMonthEnd), projectedNote));

  if (status.percentUsed !== null) {
    lines.push(
      "",
      `  ${levelPaint(bar(status.percentUsed, 32))}  ${wholePercent(status.percentUsed)}%`,
    );
  }

  if (status.providers.length > 0) {
    lines.push("");
    for (const provider of status.providers) {
      const sync = options.local
        ? provider.error
          ? p.red(`not read: ${provider.error}`)
          : ""
        : provider.error
          ? p.red(`sync error: ${provider.error}`)
          : provider.lastSyncedAt
            ? p.dim(`synced ${relative(provider.lastSyncedAt, now)}`)
            : p.dim("not synced yet");
      lines.push(
        `  ${provider.name.padEnd(12)}${usd(provider.cost).padStart(12)}${`${Math.round(provider.share * 100)}%`.padStart(6)}${sync ? `   ${sync}` : ""}`,
      );
    }
  } else {
    lines.push(
      "",
      p.dim("  No providers connected yet. Connect one in the dashboard."),
    );
  }

  if (status.topModels.length > 0) {
    lines.push("", p.bold("  Top models this month"));
    for (const model of status.topModels) {
      const name =
        model.model.length > 28 ? `${model.model.slice(0, 27)}…` : model.model;
      lines.push(
        `  ${name.padEnd(30)}${usd(model.cost).padStart(12)}${model.tokens !== null ? p.dim(`   ${tokens(model.tokens)} tok`) : ""}`,
      );
    }
  }

  if (status.explanation) lines.push("", `  ${status.explanation}`);
  if (options.local) {
    lines.push(
      "",
      p.dim(
        "  Read from each provider on this computer. Nothing was sent to Billfuse.",
      ),
      p.dim("  Alerts while you're away: https://billfuse.dev"),
    );
  } else {
    lines.push("", p.dim(`  ${status.dashboardUrl}`));
  }

  return lines.join("\n");
}
