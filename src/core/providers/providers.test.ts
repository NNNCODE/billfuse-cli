import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAnthropicCosts,
  fetchAnthropicTokens,
  parseAnthropicCosts,
  validateAnthropicKey,
  type AnthropicCostPage,
} from "./anthropic";
import { aggregateCosts, type FetchLike } from "./http";
import {
  fetchOpenAiCosts,
  openAiModelFromLineItem,
  parseOpenAiCosts,
  type OpenAiCostsPage,
} from "./openai";
import { ProviderError } from "./types";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// 按顺序返回预设响应，并记录每次请求
function scriptedFetch(responses: (Response | Error)[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return next;
  };
  return { impl, calls };
}

const START = new Date("2026-09-18T00:00:00Z");

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenAI", () => {
  it("derives a model name from a line item", () => {
    expect(openAiModelFromLineItem("gpt-4o-2024-08-06, input")).toBe(
      "gpt-4o-2024-08-06",
    );
    expect(
      openAiModelFromLineItem("evals | gpt-4o-mini-2024-07-18, input"),
    ).toBe("evals | gpt-4o-mini-2024-07-18");
    expect(openAiModelFromLineItem("assistants api | file search")).toBe(
      "assistants api | file search",
    );
  });

  it("parses the documented example response", () => {
    // 官方文档里的示例响应，原样照抄
    const page: OpenAiCostsPage = {
      data: [
        {
          start_time: 1730419200,
          end_time: 1730505600,
          results: [
            { amount: { value: 0.06, currency: "usd" }, line_item: null },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    };
    expect(parseOpenAiCosts(page)).toEqual([
      { date: "2024-11-01", lineItem: "Other", model: "Other", costUsd: 0.06 },
    ]);
  });

  it("follows pagination and sends the admin key", async () => {
    const { impl, calls } = scriptedFetch([
      jsonResponse({
        data: [
          {
            start_time: 1789689600, // 2026-09-18
            end_time: 1789776000,
            results: [
              {
                amount: { value: 1.25, currency: "usd" },
                line_item: "gpt-4o, input",
              },
            ],
          },
        ],
        has_more: true,
        next_page: "page_2",
      }),
      jsonResponse({
        data: [
          {
            start_time: 1789689600,
            end_time: 1789776000,
            results: [
              {
                amount: { value: 0.75, currency: "usd" },
                line_item: "gpt-4o, input",
              },
              {
                amount: { value: 2, currency: "usd" },
                line_item: "gpt-4o, output",
              },
            ],
          },
        ],
        has_more: false,
        next_page: null,
      }),
    ]);

    const rows = await fetchOpenAiCosts("sk-admin-test", START, impl);

    expect(calls).toHaveLength(2);
    expect(calls[0].headers.Authorization).toBe("Bearer sk-admin-test");
    expect(calls[0].url).toContain("start_time=1789689600");
    expect(calls[0].url).toContain("bucket_width=1d");
    expect(calls[0].url).toContain("group_by=line_item");
    expect(calls[1].url).toContain("page=page_2");
    expect(rows).toEqual([
      {
        date: "2026-09-18",
        lineItem: "gpt-4o, input",
        model: "gpt-4o",
        costUsd: 2,
      },
      {
        date: "2026-09-18",
        lineItem: "gpt-4o, output",
        model: "gpt-4o",
        costUsd: 2,
      },
    ]);
  });
});

describe("Anthropic", () => {
  it("parses the documented example response (amounts are cents)", () => {
    // 官方文档里的示例响应，原样照抄
    const page: AnthropicCostPage = {
      data: [
        {
          ending_at: "2025-08-02T00:00:00Z",
          results: [
            {
              amount: "123.78912",
              cost_type: "tokens",
              currency: "USD",
              description: "Claude Opus 5.5 Usage - Input Tokens",
              model: "claude-opus-5-5",
            },
          ],
          starting_at: "2025-08-01T00:00:00Z",
        },
      ],
      has_more: true,
      next_page: "page_MjAyNS0wNS0xNFQwMDowMDowMFo=",
    };
    const [row] = parseAnthropicCosts(page);
    expect(row.date).toBe("2025-08-01");
    expect(row.model).toBe("claude-opus-5-5");
    expect(row.lineItem).toBe("Claude Opus 5.5 Usage - Input Tokens");
    expect(row.costUsd).toBeCloseTo(1.2378912, 10);
  });

  it("labels costs that aren't tied to a model", () => {
    const rows = parseAnthropicCosts({
      data: [
        {
          starting_at: "2026-09-18T00:00:00Z",
          ending_at: "2026-09-19T00:00:00Z",
          results: [
            {
              amount: "50",
              cost_type: "web_search",
              description: null,
              model: null,
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    });
    expect(rows).toEqual([
      {
        date: "2026-09-18",
        lineItem: "Web search",
        model: "Web search",
        costUsd: 0.5,
      },
    ]);
  });

  it("sends the documented headers and query", async () => {
    const { impl, calls } = scriptedFetch([
      jsonResponse({ data: [], has_more: false, next_page: null }),
    ]);
    await fetchAnthropicCosts("sk-ant-admin01-test", START, impl);
    expect(calls[0].headers["x-api-key"]).toBe("sk-ant-admin01-test");
    expect(calls[0].headers["anthropic-version"]).toBe("2023-06-01");
    expect(calls[0].url).toContain("group_by[]=description");
    expect(calls[0].url).toContain("starting_at=2026-09-18T00%3A00%3A00.000Z");
    expect(calls[0].url).toContain("limit=31");
  });
});

describe("errors", () => {
  it("explains a rejected key without retrying", async () => {
    const { impl, calls } = scriptedFetch([jsonResponse({}, 401)]);
    const error = await fetchAnthropicCosts(
      "sk-ant-api03-x",
      START,
      impl,
    ).catch((e) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe("invalid_key");
    expect(error.message).toContain("sk-ant-admin");
    expect(calls).toHaveLength(1);
  });

  // 连接时检查、同步花费、同步 token 用量，三处请求的报错要一致
  const anthropicCalls: [string, (impl: FetchLike) => Promise<unknown>][] = [
    ["costs", (impl) => fetchAnthropicCosts("sk-ant-admin01-x", START, impl)],
    ["tokens", (impl) => fetchAnthropicTokens("sk-ant-admin01-x", START, impl)],
    ["validate", (impl) => validateAnthropicKey("sk-ant-admin01-x", impl)],
  ];

  // Anthropic 管理员密钥建时要选多久过期：过期以后同步被拒，报错得先说可能过期了
  it("says a rejected Anthropic key may have expired", async () => {
    for (const [name, call] of anthropicCalls) {
      const { impl } = scriptedFetch([jsonResponse({}, 401)]);
      const error = (await call(impl).catch((e) => e)) as ProviderError;
      expect(error.kind, name).toBe("invalid_key");
      expect(error.message, name).toBe(
        "Anthropic rejected this key. It may have expired or been deleted: create a new admin key and connect it. Billfuse needs an Anthropic Admin API key (it starts with sk-ant-admin), not a regular API key.",
      );
    }
  });

  it("doesn't blame expiry when an Anthropic key lacks permission", async () => {
    for (const [name, call] of anthropicCalls) {
      const { impl } = scriptedFetch([jsonResponse({}, 403)]);
      const error = (await call(impl).catch((e) => e)) as ProviderError;
      expect(error.kind, name).toBe("forbidden");
      expect(error.message, name).toBe(
        "This Anthropic key isn't allowed to read usage and cost data. Billfuse needs an Anthropic Admin API key (it starts with sk-ant-admin), not a regular API key.",
      );
      expect(error.message, name).not.toContain("expired");
    }
  });

  it("explains a key without permission", async () => {
    const { impl } = scriptedFetch([jsonResponse({}, 403)]);
    const error = await fetchOpenAiCosts("sk-admin-x", START, impl).catch(
      (e) => e,
    );
    expect(error.kind).toBe("forbidden");
    expect(error.message).toContain("isn't allowed to read usage");
    expect(error.message).toContain("Read only or All permissions");
  });

  // 缺权限的受限密钥，OpenAI 也可能回 401：报错得说出建密钥时该选哪项
  it("names the OpenAI key permissions when a key is rejected", async () => {
    const { impl } = scriptedFetch([jsonResponse({}, 401)]);
    const error = await fetchOpenAiCosts("sk-admin-x", START, impl).catch(
      (e) => e,
    );
    expect(error.kind).toBe("invalid_key");
    expect(error.message).toBe(
      "OpenAI rejected this key. Billfuse needs an OpenAI admin key (it starts with sk-admin-) with Read only or All permissions, created by an organization owner.",
    );
  });

  it("retries server errors, then succeeds", async () => {
    vi.useFakeTimers();
    const { impl, calls } = scriptedFetch([
      jsonResponse({}, 503),
      jsonResponse({ data: [], has_more: false, next_page: null }),
    ]);
    const promise = fetchOpenAiCosts("sk-admin-x", START, impl);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
    expect(calls).toHaveLength(2);
  });

  it("gives up after repeated network failures", async () => {
    vi.useFakeTimers();
    const { impl, calls } = scriptedFetch([
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
      new TypeError("fetch failed"),
    ]);
    const promise = fetchOpenAiCosts("sk-admin-x", START, impl).catch((e) => e);
    await vi.runAllTimersAsync();
    const error = await promise;
    expect(error.kind).toBe("network");
    expect(calls).toHaveLength(3);
  });
});

describe("aggregateCosts", () => {
  it("merges rows for the same day and line item", () => {
    expect(
      aggregateCosts([
        { date: "2026-10-01", lineItem: "a", model: "m", costUsd: 1 },
        { date: "2026-10-01", lineItem: "a", model: "m", costUsd: 2.5 },
        { date: "2026-10-02", lineItem: "a", model: "m", costUsd: 4 },
      ]),
    ).toEqual([
      { date: "2026-10-01", lineItem: "a", model: "m", costUsd: 3.5 },
      { date: "2026-10-02", lineItem: "a", model: "m", costUsd: 4 },
    ]);
  });
});
