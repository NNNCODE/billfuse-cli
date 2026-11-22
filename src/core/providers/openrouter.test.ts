import { describe, expect, it } from "vitest";
import type { FetchLike } from "./http";
import {
  fetchOpenRouterCosts,
  parseOpenRouterCosts,
  parseOpenRouterTokens,
  validateOpenRouterKey,
  type OpenRouterActivity,
} from "./openrouter";
import { ProviderError } from "./types";

const START = new Date("2026-09-18T00:00:00Z");

// 按官方文档的字段造的一份响应：同一模型经两个服务端点调用，分成两行
const ACTIVITY: OpenRouterActivity = {
  data: [
    {
      date: "2026-10-16",
      model: "anthropic/claude-sonnet-4.5",
      usage: 1.25,
      requests: 10,
      prompt_tokens: 1000,
      completion_tokens: 200,
      cached_tokens: 400,
    },
    {
      date: "2026-10-16",
      model: "anthropic/claude-sonnet-4.5",
      usage: 0.75,
      requests: 5,
      prompt_tokens: 500,
      completion_tokens: 100,
      cached_tokens: 0,
    },
    {
      date: "2026-10-17",
      model: "openai/gpt-5-mini",
      usage: 0.1,
      requests: 2,
      prompt_tokens: 50,
      completion_tokens: 20,
      // 重放响应缓存时缓存数可能比输入还多
      cached_tokens: 80,
    },
    // 早于同步起点的不要
    {
      date: "2026-09-01",
      model: "openai/gpt-5-mini",
      usage: 9,
      requests: 1,
      prompt_tokens: 1,
      completion_tokens: 1,
      cached_tokens: 0,
    },
  ],
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("OpenRouter", () => {
  it("adds up spend per model and day, from the sync start on", () => {
    const rows = parseOpenRouterCosts(ACTIVITY, START);
    expect(rows).toEqual([
      {
        date: "2026-10-16",
        lineItem: "anthropic/claude-sonnet-4.5",
        model: "anthropic/claude-sonnet-4.5",
        costUsd: 2,
      },
      {
        date: "2026-10-17",
        lineItem: "openai/gpt-5-mini",
        model: "openai/gpt-5-mini",
        costUsd: 0.1,
      },
    ]);
  });

  it("adds up tokens and requests, and never counts more cached than input tokens", () => {
    const rows = parseOpenRouterTokens(ACTIVITY, START);
    expect(rows).toEqual([
      {
        date: "2026-10-16",
        model: "anthropic/claude-sonnet-4.5",
        inputTokens: 1500,
        cachedInputTokens: 400,
        outputTokens: 300,
        requests: 15,
      },
      {
        date: "2026-10-17",
        model: "openai/gpt-5-mini",
        inputTokens: 50,
        cachedInputTokens: 50,
        outputTokens: 20,
        requests: 2,
      },
    ]);
  });

  it("skips rows without a valid date or cost", () => {
    expect(
      parseOpenRouterCosts(
        {
          data: [
            { date: "yesterday", model: "x", usage: 1 },
            { date: "2026-10-17", model: "x", usage: null },
          ],
        },
        START,
      ),
    ).toEqual([]);
    expect(parseOpenRouterCosts({ data: null }, START)).toEqual([]);
  });

  it("sends the key as a bearer token to the activity endpoint", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const impl: FetchLike = async (url, init) => {
      calls.push({ url, headers: init?.headers as Record<string, string> });
      return jsonResponse(ACTIVITY);
    };
    await fetchOpenRouterCosts("sk-or-v1-management", START, impl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://openrouter.ai/api/v1/activity");
    expect(calls[0].headers.Authorization).toBe("Bearer sk-or-v1-management");
  });

  it("explains that a regular API key isn't enough", async () => {
    const impl: FetchLike = async () =>
      jsonResponse(
        {
          error: {
            code: 403,
            message: "Only management keys can perform this operation",
          },
        },
        403,
      );
    const err = await validateOpenRouterKey("sk-or-v1-regular", impl).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("forbidden");
    expect(err.message).toMatch(/management key/);
  });

  it("checks one day when validating a key", async () => {
    let url = "";
    const impl: FetchLike = async (u) => {
      url = u;
      return jsonResponse({ data: [] });
    };
    await validateOpenRouterKey("sk-or-v1-management", impl);
    expect(url).toMatch(
      /^https:\/\/openrouter\.ai\/api\/v1\/activity\?date=\d{4}-\d{2}-\d{2}$/,
    );
  });
});

describe("an OpenRouter response Billfuse can't read", () => {
  // 当作出错而不是"没有花费"：否则同步会把已经存下的花费删掉
  it("is an error when there's no data array", async () => {
    const impl: FetchLike = async () => jsonResponse({ activity: [] });
    const err = await fetchOpenRouterCosts("sk-or-v1-m", START, impl).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.message).toMatch(/earlier spend is kept/);
  });

  it("is an error when rows come back but no date can be read", async () => {
    const impl: FetchLike = async () =>
      jsonResponse({ data: [{ day: 1760659200, model: "x", usage: 1 }] });
    await expect(
      fetchOpenRouterCosts("sk-or-v1-m", START, impl),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it("is fine when there is simply no usage", async () => {
    const impl: FetchLike = async () => jsonResponse({ data: [] });
    expect(await fetchOpenRouterCosts("sk-or-v1-m", START, impl)).toEqual([]);
  });
});
