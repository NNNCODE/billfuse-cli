#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { CliError, exchangeCode, fetchStatus, revokeToken } from "./api.js";
import { numberFlag, parseArgs, watchInterval, type Args } from "./args.js";
import {
  buildLocalStatus,
  checkExitCode,
  checkOptions,
  keysFromEnv,
  LOCAL_KEYS,
  reachedPercent,
} from "./check.js";
import {
  configPath,
  DEFAULT_API_URL,
  deleteConfig,
  loadConfig,
  normalizeApiUrl,
  saveConfig,
} from "./config.js";
import { browserLogin, pasteLogin } from "./login.js";
import {
  alertLevel,
  levelRank,
  renderStatus,
  type AlertLevel,
} from "./render.js";
import type { CliStatus, Config } from "./types.js";

// check 认的环境变量，一行一个
const KEY_NAMES = LOCAL_KEYS.map((k) => `  ${k.env}`).join("\n");

const HELP = `Billfuse CLI: your AI spend in the terminal

No account needed:
  npx billfuse check [--budget 200]  Read this month's spend straight from your providers

With a Billfuse account:
  npx billfuse login [--api <url>]   Authorize this computer in your browser
  npx billfuse status [--json]       Show this month's spend and budget
  npx billfuse watch [--interval 5]  Refresh every N minutes and flag budget alerts
  npx billfuse logout                Revoke this computer's access

check reads admin or management keys from these environment variables (set at least one):
${KEY_NAMES}
Keys go only to their own provider. Nothing is sent to Billfuse.

Options:
  --budget <usd>    Monthly budget to check against (check only; or set BILLFUSE_BUDGET)
  --api <url>       Billfuse address (or set BILLFUSE_API_URL)
  --no-browser      Sign in from a remote machine: open the link anywhere, paste the code back
  --json            Print raw JSON (status and check)
  --fail-at <pct>   Exit with code 2 when the budget is at least <pct>% used
                    (status: off unless set; check: 100 unless set)
  --interval <n>    Minutes between refreshes for watch (default 5, minimum 1)
  --no-color        Plain output (also respects NO_COLOR)
  -v, --version     Print the version
  -h, --help        Show this help`;

function version(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  return pkg.version;
}

function colorEnabled(flags: Args["flags"]): boolean {
  return (
    Boolean(process.stdout.isTTY) &&
    !process.env.NO_COLOR &&
    !flags.has("no-color")
  );
}

async function requireConfig(): Promise<Config> {
  const config = await loadConfig();
  if (!config) {
    throw new CliError(
      "This computer isn't signed in yet. Run `npx billfuse login` first.",
    );
  }
  return config;
}

async function login(flags: Args["flags"]) {
  const raw =
    (typeof flags.get("api") === "string"
      ? (flags.get("api") as string)
      : "") ||
    process.env.BILLFUSE_API_URL ||
    DEFAULT_API_URL;
  if (!raw) {
    throw new CliError(
      "Tell the CLI where Billfuse lives: npx billfuse login --api https://your-billfuse-domain",
    );
  }
  const apiUrl = normalizeApiUrl(raw);
  if (!apiUrl) {
    throw new CliError(
      `"${raw}" isn't a valid address. Use https:// (plain http:// only works for localhost).`,
    );
  }

  const code = flags.has("no-browser")
    ? await pasteLogin(apiUrl)
    : await browserLogin(apiUrl);
  const token = await exchangeCode(apiUrl, code);
  const config = { apiUrl, token };
  // 先确认令牌真的能用，再保存。用不了就马上在服务端作废：
  // 否则设置页里会多出一台"已授权"的电脑，而哪台电脑上都没有这个令牌
  let status: CliStatus;
  try {
    status = await fetchStatus(config);
  } catch (err) {
    await revokeToken(config);
    throw err;
  }
  await saveConfig(config);
  console.log(
    `Signed in. This month so far: $${status.monthToDate.toFixed(2)}. Run \`npx billfuse status\` any time.`,
  );
  console.log(`Saved to ${configPath()}`);
}

async function status(flags: Args["flags"]) {
  const result = await fetchStatus(await requireConfig());
  if (flags.has("json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderStatus(result, { color: colorEnabled(flags) }));
  }

  // 给脚本和 CI 用：预算用到指定百分比时以退出码 2 结束
  if (
    flags.has("fail-at") &&
    reachedPercent(result.percentUsed, numberFlag(flags, "fail-at", 100))
  ) {
    process.exitCode = 2;
  }
}

// 不登录：在这台电脑上直接向服务商读花费
async function check(flags: Args["flags"]) {
  // 先查参数：写错的参数要在联网之前就报出来
  const { budget, failAt } = checkOptions(flags, process.env);
  const keys = keysFromEnv(process.env);
  if (keys.length === 0) {
    throw new CliError(
      [
        "No provider keys found. Set at least one of these environment variables to that provider's admin or management key:",
        KEY_NAMES,
        "It is a different key from the one you call models with. Run `npx billfuse --help` for more.",
      ].join("\n"),
    );
  }

  const result = await buildLocalStatus(keys, budget, new Date());
  if (flags.has("json")) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      renderStatus(result, { color: colorEnabled(flags), local: true }),
    );
  }
  process.exitCode = checkExitCode(result, failAt);
}

async function watch(flags: Args["flags"]) {
  const config = await requireConfig();
  const minutes = watchInterval(flags);
  const color = colorEnabled(flags);
  let lastLevel: AlertLevel = "ok";

  const tick = async () => {
    const time = new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    let output: string;
    try {
      const result = await fetchStatus(config);
      const level = alertLevel(result);
      // 档位变严重时（50% → 80% → 100%）响一声铃
      if (levelRank(level) > levelRank(lastLevel)) process.stdout.write("\x07");
      lastLevel = level;
      output = renderStatus(result, { color });
    } catch (err) {
      output = `  ${err instanceof Error ? err.message : String(err)}`;
    }
    if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
    console.log(output);
    console.log(
      `\n  Updated ${time} · refreshing every ${minutes} min · Ctrl+C to stop`,
    );
  };

  await tick();
  setInterval(tick, minutes * 60_000);
}

async function logout() {
  const config = await loadConfig();
  if (!config) return console.log("This computer isn't signed in.");
  const revoked = await revokeToken(config);
  await deleteConfig();
  console.log(
    revoked
      ? "Signed out. This computer's access was revoked."
      : "Signed out on this computer. Billfuse couldn't be reached to revoke the token; revoke it in Settings → CLI access.",
  );
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.has("version")) return console.log(version());
  if (flags.has("help") || !command || command === "help")
    return console.log(HELP);

  switch (command) {
    case "check":
      return check(flags);
    case "login":
      return login(flags);
    case "status":
      return status(flags);
    case "watch":
      return watch(flags);
    case "logout":
      return logout();
    default:
      throw new CliError(
        `Unknown command "${command}". Run \`npx billfuse --help\`.`,
      );
  }
}

main().catch((err) => {
  console.error(err instanceof CliError ? err.message : err);
  process.exitCode = 1;
});
