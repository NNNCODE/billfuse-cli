import type { CliStatus, Config } from "./types.js";

export class CliError extends Error {}

async function readJson(res: Response) {
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

function unreachable(apiUrl: string): CliError {
  return new CliError(
    `Couldn't reach Billfuse at ${apiUrl}. Check your connection and try again.`,
  );
}

// 读取本月花费汇总。出错时抛出用户能看懂的 CliError
export async function fetchStatus(config: Config): Promise<CliStatus> {
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}/api/cli/status`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw unreachable(config.apiUrl);
  }

  const body = await readJson(res);
  if (res.status === 401) {
    throw new CliError(
      "This computer's access was revoked. Run `npx billfuse login` again.",
    );
  }
  if (!res.ok || !body) {
    throw new CliError(
      typeof body?.error === "string"
        ? body.error
        : `Billfuse returned an error (HTTP ${res.status}). Try again in a minute.`,
    );
  }
  return body as unknown as CliStatus;
}

// 用浏览器里拿到的一次性兑换码换真正的令牌
export async function exchangeCode(
  apiUrl: string,
  code: string,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/api/cli/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw unreachable(apiUrl);
  }
  const body = await readJson(res);
  if (!res.ok || typeof body?.token !== "string") {
    throw new CliError(
      typeof body?.error === "string"
        ? body.error
        : `Billfuse returned an error (HTTP ${res.status}). Run \`npx billfuse login\` again.`,
    );
  }
  return body.token;
}

// 在服务端作废令牌。失败不要紧（比如已经在设置页撤销过），调用方照样删本机文件
export async function revokeToken(config: Config): Promise<boolean> {
  try {
    const res = await fetch(`${config.apiUrl}/api/cli/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readJson(res);
    return body?.revoked === true;
  } catch {
    return false;
  }
}
