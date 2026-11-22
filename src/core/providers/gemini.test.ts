import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildGeminiCredential,
  costsQuery,
  fetchGeminiCosts,
  modelFromSku,
  parseGeminiCredential,
  parseGeminiRows,
  signServiceAccountJwt,
  validateGeminiKey,
} from "./gemini";
import type { FetchLike } from "./http";
import { ProviderError } from "./types";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TABLE = "my-project.billing.gcp_billing_export_v1_0123AB_45CDEF_6789GH";
const serviceAccount = {
  type: "service_account",
  project_id: "my-project",
  private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  client_email: "reader@my-project.iam.gserviceaccount.com",
  token_uri: "https://evil.example/token",
};
const credential = buildGeminiCredential(
  JSON.stringify(serviceAccount, null, 2),
  TABLE,
).credential;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });

function expectProviderError(fn: () => unknown, kind: string, text: RegExp) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).kind).toBe(kind);
    expect((err as Error).message).toMatch(text);
    return;
  }
  throw new Error("expected a ProviderError");
}

describe("connecting Gemini", () => {
  it("keeps only the table, email and private key, and shows the email", () => {
    const { credential: saved, hint } = buildGeminiCredential(
      JSON.stringify(serviceAccount),
      ` \`${TABLE}\` `,
    );
    expect(hint).toBe("reader@my-project.iam.gserviceaccount.com");
    expect(JSON.parse(saved)).toEqual({
      table: TABLE,
      client_email: serviceAccount.client_email,
      private_key: serviceAccount.private_key,
    });
    // 用户密钥里的 token_uri 不保存、不使用
    expect(saved).not.toContain("evil.example");
    expect(parseGeminiCredential(saved).table).toBe(TABLE);
  });

  it("says what's wrong with the pasted key or table", () => {
    expectProviderError(
      () => buildGeminiCredential("not json", TABLE),
      "invalid_key",
      /isn't a JSON key/,
    );
    expectProviderError(
      () => buildGeminiCredential(JSON.stringify({ type: "user" }), TABLE),
      "invalid_key",
      /isn't a service account key/,
    );
    expectProviderError(
      () =>
        buildGeminiCredential(
          JSON.stringify({ ...serviceAccount, private_key: undefined }),
          TABLE,
        ),
      "invalid_key",
      /no private_key/,
    );
    // 表名会拼进 SQL，带别的字符一律拒绝
    for (const bad of [
      "billing.gcp_billing_export_v1_X",
      "my-project.billing.x`; DROP TABLE t; --",
      "My-Project.billing.t",
    ]) {
      expectProviderError(
        () => buildGeminiCredential(JSON.stringify(serviceAccount), bad),
        "invalid_key",
        /project\.dataset\.table/,
      );
    }
  });
});

describe("signing in as the service account", () => {
  it("signs an RS256 JWT for read-only BigQuery access", () => {
    const now = new Date("2026-10-20T10:00:00Z");
    const jwt = signServiceAccountJwt(
      parseGeminiCredential(credential),
      "https://oauth2.googleapis.com/token",
      now,
    );
    const [header, claims, signature] = jwt.split(".");
    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${claims}`);
    expect(
      verify.verify(keys.publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/bigquery.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: 1792490400,
      exp: 1792494000,
    });
  });
});

describe("reading Gemini rows from the billing export", () => {
  it("names the model from the billing item", () => {
    expect(modelFromSku("Gemini 2.5 Flash Input Tokens")).toBe(
      "gemini-2.5-flash",
    );
    expect(
      modelFromSku("Generate content output token count Gemini 2.5 Pro"),
    ).toBe("gemini-2.5-pro");
    expect(modelFromSku("Gemini 2.5 Flash-Lite Text Input")).toBe(
      "gemini-2.5-flash-lite",
    );
    expect(modelFromSku("Gemini 3 Pro Output")).toBe("gemini-3-pro");
    expect(modelFromSku("Search Grounding requests")).toBe("Gemini (other)");
  });

  it("keeps real costs per day and billing item, and skips what it can't read", () => {
    expect(
      parseGeminiRows([
        ["2026-10-19", "Gemini API", "Gemini 2.5 Flash Input Tokens", "0.40"],
        ["2026-10-19", "Gemini API", "Gemini 2.5 Flash Input Tokens", "0.10"],
        ["2026-10-19", "Gemini API", "Gemini 2.5 Pro Output Tokens", "0"],
        ["not a day", "Gemini API", "Gemini 2.5 Pro Output Tokens", "3"],
        ["2026-10-18", "Gemini API", null, "abc"],
      ]),
    ).toEqual([
      {
        date: "2026-10-19",
        lineItem: "Gemini 2.5 Flash Input Tokens",
        model: "gemini-2.5-flash",
        costUsd: 0.5,
      },
    ]);
  });

  it("only puts a valid table into the SQL", () => {
    expect(costsQuery(TABLE)).toContain(`FROM \`${TABLE}\``);
    // 美元账户直接用；别的币种按汇率换算，没有汇率就不算（不把日元当美元）
    expect(costsQuery(TABLE)).toContain(
      "IF(currency = 'USD', cost, cost / NULLIF(currency_conversion_rate, 0))",
    );
    // 按导出时间也过滤一遍，表按它分区时只扫最近这段
    expect(costsQuery(TABLE)).toContain("export_time >= TIMESTAMP(@start)");
    // 只到昨天：今天的账单只导出了一部分
    expect(costsQuery(TABLE)).toContain("usage_start_time < TIMESTAMP(@end)");
    expect(() => costsQuery("a.b.c`; --")).toThrow(ProviderError);
  });
});

describe("talking to Google", () => {
  // 假的 Google：换令牌一次；查询第一次没跑完，等一次后有两页
  function fakeGoogle(
    options: { tokenStatus?: number; queryStatus?: number } = {},
  ) {
    const calls: string[] = [];
    const impl: FetchLike = async (url, init) => {
      const u = new URL(url);
      calls.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
      if (u.pathname === "/token") {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe(
          "urn:ietf:params:oauth:grant-type:jwt-bearer",
        );
        return options.tokenStatus
          ? json(
              {
                error: "invalid_grant",
                error_description: "Invalid JWT Signature.",
              },
              options.tokenStatus,
            )
          : json({ access_token: "tok" });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer tok",
      );
      if (options.queryStatus) {
        return json(
          { error: { message: "Access Denied" } },
          options.queryStatus,
        );
      }
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body));
        expect(body.useLegacySql).toBe(false);
        return json({
          jobComplete: false,
          jobReference: {
            projectId: "my-project",
            jobId: "j1",
            location: "EU",
          },
        });
      }
      if (!u.searchParams.get("pageToken")) {
        return json({
          jobComplete: true,
          pageToken: "p2",
          jobReference: {
            projectId: "my-project",
            jobId: "j1",
            location: "EU",
          },
          rows: [
            {
              f: [
                { v: "2026-10-18" },
                { v: "Gemini API" },
                { v: "Gemini 2.5 Flash Input Tokens" },
                { v: "1.5" },
              ],
            },
          ],
        });
      }
      return json({
        jobComplete: true,
        jobReference: { projectId: "my-project", jobId: "j1", location: "EU" },
        rows: [
          {
            f: [
              { v: "2026-10-19" },
              { v: "Vertex AI" },
              { v: "Gemini 2.5 Pro Output Tokens" },
              { v: "2.25" },
            ],
          },
        ],
      });
    };
    return { impl, calls };
  }

  it("waits for the query and reads every page", async () => {
    const google = fakeGoogle();
    const costs = await fetchGeminiCosts(
      credential,
      new Date("2026-09-20T00:00:00Z"),
      google.impl,
    );
    expect(costs.map((c) => [c.date, c.model, c.costUsd])).toEqual([
      ["2026-10-18", "gemini-2.5-flash", 1.5],
      ["2026-10-19", "gemini-2.5-pro", 2.25],
    ]);
    expect(google.calls).toEqual([
      "POST /token",
      "POST /bigquery/v2/projects/my-project/queries",
      "GET /bigquery/v2/projects/my-project/queries/j1?timeoutMs=10000&maxResults=10000&location=EU",
      "GET /bigquery/v2/projects/my-project/queries/j1?timeoutMs=10000&maxResults=10000&location=EU&pageToken=p2",
    ]);
  });

  it("asks for spend up to yesterday only (UTC)", async () => {
    let params: { name: string; parameterValue: { value: string } }[] = [];
    const capture: FetchLike = async (url, init) => {
      if (new URL(url).pathname === "/token")
        return json({ access_token: "tok" });
      params = JSON.parse(String(init?.body)).queryParameters;
      return json({ jobComplete: true, rows: [] });
    };
    await fetchGeminiCosts(
      credential,
      new Date("2026-09-22T00:00:00Z"),
      capture,
      new Date("2026-10-22T23:30:00Z"),
    );
    const value = (name: string) =>
      params.find((p) => p.name === name)?.parameterValue.value;
    expect(value("start")).toBe("2026-09-22");
    // @end 不含：今天 2026-10-22 的部分账单不拿
    expect(value("end")).toBe("2026-10-22");
  });

  it("sends a request ID so a retried query isn't run (and billed) twice, and gives up after a few waits", async () => {
    const posted: { requestId?: string }[] = [];
    let gets = 0;
    const slow: FetchLike = async (url, init) => {
      if (new URL(url).pathname === "/token")
        return json({ access_token: "tok" });
      if ((init?.method ?? "GET") === "POST") {
        posted.push(JSON.parse(String(init?.body)));
      } else {
        gets++;
      }
      return json({
        jobComplete: false,
        jobReference: { projectId: "my-project", jobId: "j1" },
      });
    };
    await expect(
      fetchGeminiCosts(credential, new Date("2026-10-01T00:00:00Z"), slow),
    ).rejects.toThrow(/took too long/);
    expect(posted).toHaveLength(1);
    expect(posted[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
    // 一次提交，最多再等 5 轮（共 6 轮），不会耗满整次同步
    expect(gets).toBe(5);
  });

  it("explains a rejected key, a missing permission and a missing table", async () => {
    await expect(
      validateGeminiKey(credential, fakeGoogle({ tokenStatus: 400 }).impl),
    ).rejects.toThrow(
      /Google rejected this service account key \(Invalid JWT Signature\.\)/,
    );
    await expect(
      validateGeminiKey(credential, fakeGoogle({ queryStatus: 403 }).impl),
    ).rejects.toThrow(
      /BigQuery Data Viewer role on the dataset and the BigQuery Job User role/,
    );
    await expect(
      validateGeminiKey(credential, fakeGoogle({ queryStatus: 404 }).impl),
    ).rejects.toThrow(`Billfuse can't find the table ${TABLE}`);
  });
});
