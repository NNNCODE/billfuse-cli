import { describe, expect, it } from "vitest";
import { numberFlag, parseArgs, watchInterval } from "./args";
import { normalizeApiUrl } from "./config";
import { alertLevel, banner, bar, renderStatus, wholePercent } from "./render";
import type { CliStatus } from "./types";

const NOW = new Date("2026-10-17T12:00:00Z");

function status(overrides: Partial<CliStatus> = {}): CliStatus {
  return {
    month: "2026-10",
    asOf: NOW.toISOString(),
    monthToDate: 330.89,
    budget: 600,
    remaining: 269.11,
    percentUsed: 0.5515,
    projectedMonthEnd: 603.38,
    providers: [
      {
        provider: "anthropic",
        name: "Anthropic",
        cost: 187.24,
        share: 0.566,
        status: "active",
        lastSyncedAt: "2026-10-17T11:55:00Z",
        error: null,
      },
      {
        provider: "openai",
        name: "OpenAI",
        cost: 143.65,
        share: 0.434,
        status: "error",
        lastSyncedAt: "2026-10-16T12:00:00Z",
        error: "OpenAI rejected this key.",
      },
    ],
    topModels: [
      {
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        cost: 174.4,
        tokens: 31_300_000,
      },
    ],
    explanation: "On Oct 12, gpt-4o spend was 5.5× its daily average.",
    dashboardUrl: "https://billfuse.test/dashboard",
    ...overrides,
  };
}

describe("parseArgs", () => {
  it("reads the command and flags", () => {
    const { command, flags } = parseArgs([
      "watch",
      "--interval",
      "10",
      "--no-color",
    ]);
    expect(command).toBe("watch");
    expect(flags.get("interval")).toBe("10");
    expect(flags.get("no-color")).toBe(true);
  });

  it("supports --flag=value and short flags", () => {
    const { command, flags } = parseArgs([
      "login",
      "--api=https://x.test",
      "-h",
    ]);
    expect(command).toBe("login");
    expect(flags.get("api")).toBe("https://x.test");
    expect(flags.get("help")).toBe(true);
  });
});

describe("normalizeApiUrl", () => {
  it("keeps http(s) origins and trims trailing slashes", () => {
    expect(normalizeApiUrl("https://billfuse.test/")).toBe(
      "https://billfuse.test",
    );
    expect(normalizeApiUrl("http://localhost:3000")).toBe(
      "http://localhost:3000",
    );
  });

  it("rejects anything else", () => {
    expect(normalizeApiUrl("ftp://x.test")).toBeNull();
    expect(normalizeApiUrl("not a url")).toBeNull();
  });

  it("refuses plain http except on this computer, so the token isn't sent in the clear", () => {
    expect(normalizeApiUrl("http://billfuse.test")).toBeNull();
    expect(normalizeApiUrl("http://127.0.0.1:3000")).toBe(
      "http://127.0.0.1:3000",
    );
  });
});

describe("numberFlag", () => {
  it("uses the default when the flag has no number", () => {
    // 以前 "--interval" 后面不跟数字会被当成 1 分钟
    expect(
      numberFlag(parseArgs(["watch", "--interval"]).flags, "interval", 5),
    ).toBe(5);
    expect(numberFlag(parseArgs(["watch"]).flags, "interval", 5)).toBe(5);
    expect(
      numberFlag(
        parseArgs(["watch", "--interval", "abc"]).flags,
        "interval",
        5,
      ),
    ).toBe(5);
    expect(
      numberFlag(parseArgs(["watch", "--interval", "15"]).flags, "interval", 5),
    ).toBe(15);
  });

  it("reads --fail-at", () => {
    expect(
      numberFlag(
        parseArgs(["status", "--fail-at", "80"]).flags,
        "fail-at",
        100,
      ),
    ).toBe(80);
  });
});

describe("alert levels", () => {
  it("follows the 50 / 80 / 100% thresholds", () => {
    expect(alertLevel(status({ percentUsed: 0.49 }))).toBe("ok");
    expect(alertLevel(status({ percentUsed: 0.5 }))).toBe("notice");
    expect(alertLevel(status({ percentUsed: 0.79 }))).toBe("notice");
    expect(alertLevel(status({ percentUsed: 0.8 }))).toBe("warning");
    expect(alertLevel(status({ percentUsed: 1 }))).toBe("over");
    expect(alertLevel(status({ budget: null, percentUsed: null }))).toBe("ok");
  });

  it("shows a banner only when it matters", () => {
    expect(banner(status({ percentUsed: 0.3 }), false)).toBeNull();
    expect(banner(status(), false)).toBe(
      " Halfway: 55% of your monthly budget is used ",
    );
    expect(banner(status({ percentUsed: 0.85 }), false)).toBe(
      " 85% of your monthly budget is used ",
    );
    expect(
      banner(
        status({ percentUsed: 1.1, monthToDate: 660, remaining: -60 }),
        false,
      ),
    ).toBe(" OVER BUDGET: $660.00 spent of $600.00 this month ");
  });
});

describe("renderStatus", () => {
  it("prints the numbers people check first", () => {
    const text = renderStatus(status(), { color: false, now: NOW });
    expect(text).toContain("Billfuse · October 2026 (UTC)");
    expect(text).toContain("Spent this month");
    expect(text).toContain("$330.89");
    expect(text).toContain("55% used · $269.11 left");
    expect(text).toContain("on pace to pass your budget");
    expect(text).toContain("synced 5 min ago");
    expect(text).toContain("sync error: OpenAI rejected this key.");
    expect(text).toContain("31.3M tok");
    expect(text).toContain("https://billfuse.test/dashboard");
  });

  it("says how far over the month will end once the budget is passed", () => {
    const text = renderStatus(
      status({
        monthToDate: 650,
        remaining: -50,
        percentUsed: 650 / 600,
        projectedMonthEnd: 1185.3,
      }),
      { color: false, now: NOW },
    );
    expect(text).toContain("$50.00 over");
    expect(text).toContain("on pace to end $585.30 over budget");
    expect(text).not.toContain("on pace to pass your budget");
  });

  it("says when no budget is set", () => {
    const text = renderStatus(
      status({ budget: null, remaining: null, percentUsed: null }),
      { color: false, now: NOW },
    );
    expect(text).toContain("no budget set");
  });

  it("adds no color codes when color is off", () => {
    expect(renderStatus(status(), { color: false, now: NOW })).not.toContain(
      "\x1b[",
    );
    expect(renderStatus(status(), { color: true, now: NOW })).toContain(
      "\x1b[",
    );
  });
});

describe("bar", () => {
  it("fills proportionally and clamps", () => {
    expect(bar(0.5, 4)).toBe("██░░");
    expect(bar(2, 4)).toBe("████");
    expect(bar(-1, 4)).toBe("░░░░");
  });
});

describe("wholePercent", () => {
  it("matches the website: 57% stays 57%, 79.6% shows 79%", () => {
    expect(wholePercent(0.57)).toBe(57);
    expect(wholePercent(0.796)).toBe(79);
    expect(banner(status({ percentUsed: 0.57 }), false)).toBe(
      " Halfway: 57% of your monthly budget is used ",
    );
  });
});

describe("watchInterval", () => {
  it("keeps the refresh between 1 minute and 1 day", () => {
    const interval = (...argv: string[]) =>
      watchInterval(parseArgs(["watch", ...argv]).flags);
    expect(interval()).toBe(5);
    expect(interval("--interval", "0")).toBe(1);
    // 40000 分钟超过了 Node 定时器的上限，以前会变成每毫秒刷新一次
    expect(interval("--interval", "40000")).toBe(1440);
  });
});
