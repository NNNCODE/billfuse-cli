import { spawn } from "node:child_process";

// 用系统默认浏览器打开网址。打不开也没关系，调用方会把网址打印出来让用户自己点。
// 设了 BILLFUSE_NO_OPEN=1（CI、自动化测试）就不打开，只靠打印出来的链接
export function openBrowser(url: string): void {
  if (process.env.BILLFUSE_NO_OPEN === "1") return;
  const [command, args] =
    process.platform === "win32"
      ? // 不经过 cmd，网址里的 & 不会被当成命令分隔符
        ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 忽略：网址已经打印出来了
  }
}
