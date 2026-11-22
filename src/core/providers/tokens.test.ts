import { describe, expect, it } from "vitest";
import {
  fetchAnthropicTokens,
  parseAnthropicUsage,
  type AnthropicUsagePage,
} from "./anthropic";
import type { FetchLike } from "./http";
import { parseOpenAiUsage, type OpenAiUsagePage } from "./openai";
import { aggregateTokens } from "./types";

describe("OpenAI completions usage", () => {
  it("parses the documented example response", () => {
    // 官方文档示例里与我们相关的字段，原样照抄（其余拆分字段省略）
    const page: OpenAiUsagePage = {
      data: [
        {
          start_time: 1730419200,
          results: [
            {
              input_tokens: 1000,
              input_cached_tokens: 400,
              output_tokens: 500,
              num_model_requests: 5,
              model: null,
            },
          ],
        },
      ],
      has_more: true,
      next_page: "page_AAAAAGdGxdEiJdKOAAAAAGcqsYA=",
    };
    expect(parseOpenAiUsage(page)).toEqual([
      {
        date: "2024-11-01",
        model: "Other",
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 500,
        requests: 5,
      },
    ]);
  });
});

describe("Anthropic usage report", () => {
  it("parses the documented example and counts cache reads and writes as input", () => {
    // 官方文档里的示例响应（只保留用到的字段）
    const page: AnthropicUsagePage = {
      data: [
        {
          starting_at: "2025-08-01T00:00:00Z",
          results: [
            {
              cache_creation: {
                ephemeral_1h_input_tokens: 0,
                ephemeral_5m_input_tokens: 0,
              },
              cache_read_input_tokens: 200,
              model: "claude-opus-5-5",
              output_tokens: 500,
              uncached_input_tokens: 1500,
            },
          ],
        },
      ],
      has_more: true,
      next_page: "page_MjAyNS0wNS0xNFQwMDowMDowMFo=",
    };
    expect(parseAnthropicUsage(page)).toEqual([
      {
        date: "2025-08-01",
        model: "claude-opus-5-5",
        inputTokens: 1700,
        cachedInputTokens: 200,
        outputTokens: 500,
        requests: null,
      },
    ]);
  });

  it("groups by model in the query", async () => {
    const urls: string[] = [];
    const impl: FetchLike = async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ data: [], has_more: false, next_page: null }),
      );
    };
    await fetchAnthropicTokens(
      "sk-ant-admin01-x",
      new Date("2026-09-18T00:00:00Z"),
      impl,
    );
    expect(urls[0]).toContain("/v1/organizations/usage_report/messages?");
    expect(urls[0]).toContain("group_by[]=model");
  });
});

describe("aggregateTokens", () => {
  it("merges rows for the same day and model", () => {
    expect(
      aggregateTokens([
        {
          date: "d",
          model: "m",
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 2,
          requests: null,
        },
        {
          date: "d",
          model: "m",
          inputTokens: 3,
          cachedInputTokens: 1,
          outputTokens: 4,
          requests: null,
        },
      ]),
    ).toEqual([
      {
        date: "d",
        model: "m",
        inputTokens: 4,
        cachedInputTokens: 1,
        outputTokens: 6,
        requests: null,
      },
    ]);
  });
});
