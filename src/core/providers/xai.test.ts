import { afterEach, describe, expect, it, vi } from "vitest";
import type { FetchLike } from "./http";
import { ProviderError } from "./types";
import {
  checkUsageShape,
  fetchXaiCosts,
  parseXaiCosts,
  teamIdFromKeyInfo,
  usageQuery,
  validateXaiKey,
  type XaiUsage,
} from "./xai";

const START = new Date("2026-10-13T00:00:00Z");

// 按官方文档的字段造的一份响应：每个模型一条时间序列，每天一个点（没花的是 0）
const USAGE: XaiUsage = {
  timeSeries: [
    {
      group: ["Chat grok-4-0709"],
      groupLabels: ["Chat grok-4-0709"],
      dataPoints: [
        // 早于同步起点的不要
        { timestamp: "2026-10-12T00:00:00Z", values: [9] },
        { timestamp: "2026-10-13T00:00:00Z", values: [1.25] },
        { timestamp: "2026-10-14T00:00:00Z", values: [0] },
        { timestamp: "2026-10-15T00:00:00Z", values: [0.75973725] },
      ],
    },
    {
      group: [],
      groupLabels: ["Chat grok-4-fast"],
      dataPoints: [{ timestamp: "2026-10-13T00:00:00Z", values: [0.5] }],
    },
  ],
  limitReached: false,
};

const KEY_INFO = {
  apiKeyId: "mk-1",
  teamId: "team-old",
  scope: "SCOPE_TEAM",
  scopeId: "team-1",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Call = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

// 第一次请求是查团队，第二次是查花费
function fakeXai(usage: unknown, usageStatus = 200) {
  const calls: Call[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return url.endsWith("/auth/management-keys/validation")
      ? jsonResponse(KEY_INFO)
      : jsonResponse(usage, usageStatus);
  };
  return { calls, impl };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("xAI", () => {
  it("adds up spend per model and UTC day from the sync start on, and skips empty days", () => {
    expect(parseXaiCosts(USAGE, START)).toEqual([
      {
        date: "2026-10-13",
        lineItem: "Chat grok-4-0709",
        model: "Chat grok-4-0709",
        costUsd: 1.25,
      },
      {
        date: "2026-10-15",
        lineItem: "Chat grok-4-0709",
        model: "Chat grok-4-0709",
        costUsd: 0.75973725,
      },
      {
        date: "2026-10-13",
        lineItem: "Chat grok-4-fast",
        model: "Chat grok-4-fast",
        costUsd: 0.5,
      },
    ]);
  });

  it("finds the team from the key, preferring scopeId over the deprecated teamId", () => {
    expect(teamIdFromKeyInfo(KEY_INFO)).toBe("team-1");
    expect(teamIdFromKeyInfo({ teamId: "team-old" })).toBe("team-old");
    const err = (() => {
      try {
        return teamIdFromKeyInfo({ scope: "SCOPE_USER", scopeId: "u-1" });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe("forbidden");
  });

  it("asks for daily USD per model, with an end time that excludes the end day", () => {
    expect(
      usageQuery(START, new Date("2026-11-13T05:00:00Z")).analyticsRequest,
    ).toEqual({
      timeRange: {
        startTime: "2026-10-13 00:00:00",
        endTime: "2026-11-13 00:00:00",
        timezone: "Etc/GMT",
      },
      timeUnit: "TIME_UNIT_DAY",
      values: [{ name: "usd", aggregation: "AGGREGATION_SUM" }],
      groupBy: ["description"],
      filters: [],
    });
  });

  it("treats an unreadable or partial answer as an error, not as no spend", () => {
    for (const body of [
      null,
      [],
      { code: 13, error: "internal" },
      { timeSeries: [{ dataPoints: null }] },
      { timeSeries: [{ dataPoints: [{ timestamp: "x", values: [1] }] }] },
      {
        timeSeries: [
          { dataPoints: [{ timestamp: "2026-10-13T00:00:00Z", values: [] }] },
        ],
      },
      { ...USAGE, limitReached: true },
      // 空数组被省掉、只剩 limitReached 时也是"只给了一部分"
      { limitReached: true },
    ]) {
      expect(() => checkUsageShape(body)).toThrow(ProviderError);
    }
    expect(checkUsageShape({ timeSeries: [] })).toEqual({ timeSeries: [] });
  });

  it("reads an empty object as no spend: JSON from xAI may leave out empty lists", () => {
    expect(checkUsageShape({})).toEqual({ timeSeries: [] });
    expect(parseXaiCosts(checkUsageShape({}), START)).toEqual([]);
  });

  it("looks up the team, then posts the usage query with the key as a bearer token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const { calls, impl } = fakeXai(USAGE);
    const rows = await fetchXaiCosts("xai-management", START, impl);
    expect(rows).toHaveLength(3);
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ["GET", "https://management-api.x.ai/auth/management-keys/validation"],
      ["POST", "https://management-api.x.ai/v1/billing/teams/team-1/usage"],
    ]);
    expect(calls[1].headers.Authorization).toBe("Bearer xai-management");
    expect(
      (calls[1].body as ReturnType<typeof usageQuery>).analyticsRequest
        .timeRange,
    ).toEqual({
      startTime: "2026-10-13 00:00:00",
      endTime: "2026-11-13 00:00:00",
      timezone: "Etc/GMT",
    });
  });

  it("says no team was found when xAI answers 404", async () => {
    const { impl } = fakeXai({ code: 5, error: "not found" }, 404);
    const err = await fetchXaiCosts("xai-management", START, impl).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("forbidden");
    expect(err.message).toMatch(/team/);
  });

  it("explains that a regular API key isn't enough", async () => {
    const impl: FetchLike = async () => jsonResponse({ code: 7 }, 403);
    const err = await validateXaiKey("xai-regular", impl).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("forbidden");
    expect(err.message).toMatch(/management key/);
  });

  it("checks yesterday and today when validating a key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-12T10:00:00Z"));
    const { calls, impl } = fakeXai({ timeSeries: [], limitReached: false });
    await validateXaiKey("xai-management", impl);
    expect(
      (calls[1].body as ReturnType<typeof usageQuery>).analyticsRequest
        .timeRange,
    ).toEqual({
      startTime: "2026-11-11 00:00:00",
      endTime: "2026-11-13 00:00:00",
      timezone: "Etc/GMT",
    });
  });
});
