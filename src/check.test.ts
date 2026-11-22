import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "./api";
import { parseArgs } from "./args";
import {
  buildLocalStatus,
  checkExitCode,
  checkOptions,
  keysFromEnv,
  localMessage,
  reachedPercent,
} from "./check";
import { renderStatus } from "./render";
import type { FetchLike } from "./shared";

const NOW = new Date("2026-11-20T12:00:00Z");
const DAY = 86_400;
const NOV_10 = Date.parse("2026-11-10T00:00:00Z") / 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// OpenAI 返回 11 月 10 日的两笔花费；Anthropic 拒绝密钥。记录每个请求去了哪儿、带了什么密钥
function fakeProviders() {
  const calls: { url: string; auth: string }[] = [];
  const impl: FetchLike = async (url, init) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      auth: headers.Authorization ?? headers["x-api-key"] ?? "",
    });
    const host = new URL(url).host;
    if (host === "api.openai.com") {
      return json({
        data: [
          {
            start_time: NOV_10,
            end_time: NOV_10 + DAY,
            results: [
              {
                amount: { value: 30, currency: "usd" },
                line_item: "gpt-4o, input",
              },
              {
                amount: { value: 12.5, currency: "usd" },
                line_item: "gpt-4o, output",
              },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      });
    }
    return json({ error: "nope" }, 401);
  };
  return { impl, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("keysFromEnv", () => {
  it("reads only the admin key variables that are set", () => {
    expect(
      keysFromEnv({
        OPENAI_ADMIN_KEY: " sk-admin-1 ",
        ANTHROPIC_ADMIN_KEY: "",
        XAI_MANAGEMENT_KEY: "xai-mgmt",
        // 平时调模型用的密钥读不了花费，不能拿来用
        OPENAI_API_KEY: "sk-proj-regular",
        ANTHROPIC_API_KEY: "sk-ant-api-regular",
      }),
    ).toEqual([
      { provider: "openai", key: "sk-admin-1" },
      { provider: "xai", key: "xai-mgmt" },
    ]);
  });
});

describe("localMessage", () => {
  it("drops the part about the next sync", () => {
    expect(
      localMessage(
        "OpenAI is rate limiting requests right now. Billfuse will try again on the next sync.",
      ),
    ).toBe("OpenAI is rate limiting requests right now.");
    expect(
      localMessage(
        "xAI returned only part of your usage this time. Your earlier spend is kept, and Billfuse will try again on the next sync.",
      ),
    ).toBe("xAI returned only part of your usage this time.");
  });

  it("drops the part about connecting a key", () => {
    expect(
      localMessage(
        "Anthropic rejected this key. It may have expired or been deleted: create a new admin key and connect it. Billfuse needs an Anthropic Admin API key.",
      ),
    ).toBe(
      "Anthropic rejected this key. It may have expired or been deleted: create a new admin key. Billfuse needs an Anthropic Admin API key.",
    );
  });

  it("leaves other messages alone", () => {
    expect(localMessage("OpenAI rejected this key.")).toBe(
      "OpenAI rejected this key.",
    );
  });
});

describe("buildLocalStatus", () => {
  it("adds up this month's spend and measures it against the budget", async () => {
    const { impl } = fakeProviders();
    const status = await buildLocalStatus(
      [{ provider: "openai", key: "sk-admin-1" }],
      100,
      NOW,
      impl,
    );
    expect(status.month).toBe("2026-11");
    expect(status.monthToDate).toBe(42.5);
    expect(status.budget).toBe(100);
    expect(status.remaining).toBe(57.5);
    expect(status.percentUsed).toBeCloseTo(0.425);
    expect(status.providers).toEqual([
      {
        provider: "openai",
        name: "OpenAI",
        cost: 42.5,
        share: 1,
        status: "active",
        lastSyncedAt: NOW.toISOString(),
        error: null,
      },
    ]);
    expect(status.topModels).toEqual([
      { model: "gpt-4o", provider: "openai", cost: 42.5, tokens: null },
    ]);
  });

  it("keeps going when one provider rejects its key, and says which", async () => {
    const { impl } = fakeProviders();
    const status = await buildLocalStatus(
      [
        { provider: "openai", key: "sk-admin-1" },
        { provider: "anthropic", key: "sk-ant-admin-bad" },
      ],
      null,
      NOW,
      impl,
    );
    expect(status.monthToDate).toBe(42.5);
    expect(status.budget).toBeNull();
    const anthropic = status.providers.find((p) => p.provider === "anthropic");
    expect(anthropic?.cost).toBe(0);
    expect(anthropic?.status).toBe("error");
    expect(anthropic?.error).toMatch(/^Anthropic rejected this key\./);
    // 网站上的那句"去连接新密钥"在这里没有意义；要说清是哪个变量里的密钥
    expect(anthropic?.error).not.toContain("connect");
    expect(anthropic?.error).toMatch(
      /The key came from ANTHROPIC_ADMIN_KEY\.$/,
    );
  });

  it("keeps the other providers when one answers with something that isn't JSON", async () => {
    // 公司代理或上网认证页会用 200 回一页 HTML
    const { impl } = fakeProviders();
    const withPortal: FetchLike = async (url, init) =>
      new URL(url).host === "api.anthropic.com"
        ? new Response("<html>Sign in to the network</html>", { status: 200 })
        : impl(url, init);
    const status = await buildLocalStatus(
      [
        { provider: "openai", key: "sk-admin-1" },
        { provider: "anthropic", key: "sk-ant-admin-2" },
      ],
      100,
      NOW,
      withPortal,
    );
    expect(status.monthToDate).toBe(42.5);
    const anthropic = status.providers.find((p) => p.provider === "anthropic");
    expect(anthropic?.error).toBe(
      "Anthropic sent back something that isn't usage data. A proxy or a sign-in page may be answering in its place.",
    );
    expect(checkExitCode(status, 100)).toBe(1);
  });

  it("sends each key only to its own provider's official address", async () => {
    // 有些工具用同样的变量名指向代理；本机地址在网站的开发环境里是认的，命令行里也不认
    // 四家都指向本机：只有锁住了，请求才会去官方地址
    vi.stubEnv("OPENAI_API_BASE_URL", "http://127.0.0.1:4010");
    vi.stubEnv("ANTHROPIC_API_BASE_URL", "http://127.0.0.1:4010");
    vi.stubEnv("OPENROUTER_API_BASE_URL", "http://localhost:4010");
    vi.stubEnv("XAI_API_BASE_URL", "http://127.0.0.1:4010");
    const official: Record<string, string> = {
      "sk-admin-1": "api.openai.com",
      "sk-ant-admin-2": "api.anthropic.com",
      "sk-or-mgmt-3": "openrouter.ai",
      "xai-mgmt-4": "management-api.x.ai",
    };
    const { impl, calls } = fakeProviders();
    await buildLocalStatus(
      [
        { provider: "openai", key: "sk-admin-1" },
        { provider: "anthropic", key: "sk-ant-admin-2" },
        { provider: "openrouter", key: "sk-or-mgmt-3" },
        { provider: "xai", key: "xai-mgmt-4" },
      ],
      null,
      NOW,
      impl,
    );
    const seen = new Set<string>();
    for (const call of calls) {
      const key = Object.keys(official).find((k) => call.auth.includes(k));
      expect(key, "a request carried no known key: " + call.url).toBeDefined();
      expect(new URL(call.url).host).toBe(official[key as string]);
      seen.add(key as string);
    }
    // 四家都真的发了请求，不是因为没发才没出错
    expect([...seen].sort()).toEqual(Object.keys(official).sort());
  });
});

describe("checkOptions", () => {
  const options = (argv: string[], env: Record<string, string> = {}) =>
    checkOptions(parseArgs(["check", ...argv]).flags, env);

  it("has no budget and a 100% threshold by default", () => {
    expect(options([])).toEqual({ budget: null, failAt: 100 });
  });

  it("reads the budget from the flag, then from BILLFUSE_BUDGET", () => {
    expect(options(["--budget", "200"])).toEqual({ budget: 200, failAt: 100 });
    expect(options([], { BILLFUSE_BUDGET: "350" }).budget).toBe(350);
    expect(options(["--budget=200"], { BILLFUSE_BUDGET: "350" }).budget).toBe(
      200,
    );
    expect(options([], { BILLFUSE_BUDGET: "  " }).budget).toBeNull();
  });

  it("reads --fail-at", () => {
    expect(options(["--budget", "200", "--fail-at", "80"]).failAt).toBe(80);
    expect(options(["--budget", "200", "--fail-at=62.5"]).failAt).toBe(62.5);
  });

  // 写错的参数如果被悄悄忽略，用 check 把关的脚本会一直以为没超
  it.each([
    [["--budjet", "200"], /doesn't have a --budjet option/],
    [["--budget", "200", "--fail-at", "80%"], /isn't a percentage/],
    [["--budget", "200", "--fail-at", "eighty"], /isn't a percentage/],
    [["--budget", "200", "--fail-at", "0"], /isn't a percentage/],
    [["--budget", "200", "--fail-at"], /isn't a percentage/],
    [["--fail-at", "80"], /needs a budget/],
    [["--budget", "abc"], /isn't a budget/],
    [["--budget"], /isn't a budget/],
    [["--budget", "0"], /isn't a budget/],
    [["--interval", "5"], /doesn't have a --interval option/],
  ])("rejects %j", (argv, message) => {
    expect(() => options(argv)).toThrow(CliError);
    expect(() => options(argv)).toThrow(message);
  });
});

describe("reachedPercent", () => {
  it("counts an exact hit even when floating point lands just under", () => {
    // 0.57 * 100 在 JS 里是 56.99999999999999
    expect(0.57 * 100 >= 57).toBe(false);
    expect(reachedPercent(0.57, 57)).toBe(true);
    expect(reachedPercent(0.29, 29)).toBe(true);
    expect(reachedPercent(1.13, 113)).toBe(true);
  });

  it("is false below the threshold and when there is no budget", () => {
    expect(reachedPercent(0.5699, 57)).toBe(false);
    expect(reachedPercent(null, 0)).toBe(false);
  });
});

describe("checkExitCode", () => {
  async function statusWith(budget: number | null, withBadKey = false) {
    const { impl } = fakeProviders();
    return buildLocalStatus(
      [
        { provider: "openai" as const, key: "sk-admin-1" },
        ...(withBadKey
          ? [{ provider: "anthropic" as const, key: "sk-ant-admin-bad" }]
          : []),
      ],
      budget,
      NOW,
      impl,
    );
  }

  it("is 0 under the threshold", async () => {
    expect(checkExitCode(await statusWith(100), 100)).toBe(0);
    expect(checkExitCode(await statusWith(null), 100)).toBe(0);
  });

  it("is 2 once the threshold is reached", async () => {
    expect(checkExitCode(await statusWith(100), 40)).toBe(2);
    expect(checkExitCode(await statusWith(42.5), 100)).toBe(2);
    expect(checkExitCode(await statusWith(40), 100)).toBe(2);
  });

  it("is 1 when a provider couldn't be read: the total is incomplete", async () => {
    expect(checkExitCode(await statusWith(100, true), 100)).toBe(1);
  });

  it("is still 2 when the part that was read is already over", async () => {
    expect(checkExitCode(await statusWith(40, true), 100)).toBe(2);
  });
});

describe("renderStatus for check", () => {
  it("talks about this computer, not about syncing or the dashboard", async () => {
    const { impl } = fakeProviders();
    const status = await buildLocalStatus(
      [
        { provider: "openai", key: "sk-admin-1" },
        { provider: "anthropic", key: "sk-ant-admin-bad" },
      ],
      100,
      NOW,
      impl,
    );
    const text = renderStatus(status, { color: false, now: NOW, local: true });
    expect(text).toMatch(/Spent this month\s+\$42\.50\n/);
    expect(text).toContain("42% used · $57.50 left");
    expect(text).toContain("not read: Anthropic rejected this key.");
    expect(text).toContain(
      "Incomplete: Anthropic couldn't be read, so the totals below leave it out.",
    );
    expect(text).toContain(
      "Read from each provider on this computer. Nothing was sent to Billfuse.",
    );
    expect(text).not.toMatch(/sync/i);
    expect(text).not.toContain("/dashboard");
    // 密钥不能出现在输出里
    expect(text).not.toContain("sk-admin-1");
    expect(JSON.stringify(status)).not.toContain("sk-admin-1");
  });

  it("says how to add a budget when there is none", async () => {
    const { impl } = fakeProviders();
    const status = await buildLocalStatus(
      [{ provider: "openai", key: "sk-admin-1" }],
      null,
      NOW,
      impl,
    );
    const text = renderStatus(status, { color: false, now: NOW, local: true });
    expect(text).toContain("add --budget <usd> to check against one");
    expect(text).not.toContain("Incomplete");
  });
});
