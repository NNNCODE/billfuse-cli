export type Args = { command: string; flags: Map<string, string | true> };

// 只认几个固定参数，不引入参数解析库
const TAKES_VALUE = new Set(["api", "interval", "fail-at", "budget"]);

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  let command = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h") flags.set("help", true);
    else if (arg === "-v") flags.set("version", true);
    else if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const next = argv[i + 1];
      if (eq !== -1) flags.set(name, arg.slice(eq + 1));
      else if (
        TAKES_VALUE.has(name) &&
        next !== undefined &&
        !next.startsWith("-")
      ) {
        flags.set(name, next);
        i++;
      } else flags.set(name, true);
    } else if (!command) command = arg;
  }
  return { command, flags };
}

// 读一个数字参数；没给、给了标志但没给数字、或不是数字时用默认值
export function numberFlag(
  flags: Args["flags"],
  name: string,
  fallback: number,
): number {
  const value = flags.get(name);
  if (typeof value !== "string") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

// watch 的刷新间隔（分钟）：至少 1 分钟，最多一天。
// 超过约 24.8 天的定时器 Node 会当成 1 毫秒，等于每毫秒请求一次服务器
export function watchInterval(flags: Args["flags"]): number {
  return Math.min(24 * 60, Math.max(1, numberFlag(flags, "interval", 5)));
}
