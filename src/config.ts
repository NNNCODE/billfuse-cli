import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "./types.js";

// Billfuse 正式网址。连自己部署的、或本机开发的网站时，用 --api 或 BILLFUSE_API_URL 指定
export const DEFAULT_API_URL = "https://billfuse.dev";

export function configPath(): string {
  if (process.env.BILLFUSE_CONFIG_DIR) {
    return join(process.env.BILLFUSE_CONFIG_DIR, "config.json");
  }
  const base =
    process.platform === "win32"
      ? (process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"))
      : (process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "billfuse", "config.json");
}

export async function loadConfig(): Promise<Config | null> {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8"));
    if (typeof parsed.apiUrl === "string" && typeof parsed.token === "string") {
      return { apiUrl: parsed.apiUrl, token: parsed.token };
    }
    return null;
  } catch {
    return null;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true });
  // 只有本人可读写（Windows 上这个权限位会被忽略，文件在用户自己的目录里）
  await writeFile(path, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export async function deleteConfig(): Promise<void> {
  await rm(configPath(), { force: true });
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// 去掉结尾的斜杠。只接受 https；本机开发时允许 http://localhost，
// 否则令牌会在网络上明文传输
export function normalizeApiUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const ok =
      url.protocol === "https:" ||
      (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname));
    if (!ok) return null;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {
    return null;
  }
}
