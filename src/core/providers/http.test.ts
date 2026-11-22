import { afterEach, describe, expect, it, vi } from "vitest";
import { apiBase, type FetchLike } from "./http";
import { fetchOpenAiCosts } from "./openai";

const OFFICIAL = "https://api.openai.com";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("apiBase", () => {
  it("uses the official address when nothing is set", () => {
    expect(apiBase(undefined, OFFICIAL)).toBe(OFFICIAL);
    expect(apiBase("", OFFICIAL)).toBe(OFFICIAL);
  });

  it("accepts an address on this computer", () => {
    expect(apiBase("http://127.0.0.1:4010", OFFICIAL)).toBe(
      "http://127.0.0.1:4010",
    );
    expect(apiBase("http://localhost:4010/", OFFICIAL)).toBe(
      "http://localhost:4010",
    );
    expect(apiBase("http://[::1]:4010", OFFICIAL)).toBe("http://[::1]:4010");
  });

  it("ignores an address on another machine", () => {
    for (const override of [
      "https://proxy.example.com/v1",
      "http://192.168.1.20:4000",
      "http://127.0.0.1.example.com",
      "http://localhost.example.com",
      "http://127.0.0.1@example.com",
      "http://example.com/127.0.0.1",
      "file://localhost/etc/hosts",
      "not a url",
    ]) {
      expect(apiBase(override, OFFICIAL), override).toBe(OFFICIAL);
    }
  });

  it("ignores every address in production, even a local one", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(apiBase("http://127.0.0.1:4010", OFFICIAL)).toBe(OFFICIAL);
  });

  it("ignores every address once locked, even a local one", async () => {
    // 锁是模块里的一个开关，重新加载一份来试，免得影响这个文件里别的测试
    vi.resetModules();
    const http = await import("./http");
    expect(http.apiBase("http://127.0.0.1:4010", OFFICIAL)).toBe(
      "http://127.0.0.1:4010",
    );
    http.lockOfficialAddresses();
    expect(http.apiBase("http://127.0.0.1:4010", OFFICIAL)).toBe(OFFICIAL);
  });
});

describe("a provider request", () => {
  // 管理员密钥跟着请求走，所以要看实际发出去的地址，不只是 apiBase 的返回值
  async function requestedUrl(): Promise<string> {
    const urls: string[] = [];
    const impl: FetchLike = async (url) => {
      urls.push(url);
      return new Response(JSON.stringify({ data: [], has_more: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    await fetchOpenAiCosts("sk-admin-test", new Date("2026-11-01"), impl);
    return urls[0];
  }

  it("goes to OpenAI when the override points at another machine", async () => {
    vi.stubEnv("OPENAI_API_BASE_URL", "https://proxy.example.com");
    expect(await requestedUrl()).toMatch(/^https:\/\/api\.openai\.com\//);
  });

  it("goes to the local mock when the override points at this computer", async () => {
    vi.stubEnv("OPENAI_API_BASE_URL", "http://127.0.0.1:4010");
    expect(await requestedUrl()).toMatch(/^http:\/\/127\.0\.0\.1:4010\//);
  });
});
