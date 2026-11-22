import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { hostname } from "node:os";
import { createInterface } from "node:readline/promises";
import { CliError } from "./api.js";
import { openBrowser } from "./open-browser.js";

const TIMEOUT_MS = 5 * 60_000;

const PAGE = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:15vh auto;padding:0 1rem;color:#18181b}h1{font-size:1.25rem}</style>
</head><body><h1>${title}</h1><p>${body}</p></body></html>`;

// 本机浏览器登录：在本机随机端口开一个只监听 127.0.0.1 的小服务器，打开授权页，
// 等网站把一次性兑换码送回 /callback（之后再用 POST 换真正的令牌，令牌不进浏览器地址栏）。
// state 是一次性随机串，防止别的网页伪造回调塞进别人的兑换码
export async function browserLogin(apiUrl: string): Promise<string> {
  const state = randomBytes(24).toString("base64url");

  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const send = (status: number, title: string, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE(title, body));
    };

    if (url.searchParams.get("state") !== state) {
      send(
        400,
        "Something's off",
        "This sign-in link doesn't match your terminal. Run <code>npx billfuse login</code> again.",
      );
      return;
    }
    if (url.searchParams.get("error")) {
      send(200, "Cancelled", "Nothing was authorized. You can close this tab.");
      rejectCode(new CliError("Authorization was cancelled in the browser."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      send(
        400,
        "Something's off",
        "No sign-in code came back. Run <code>npx billfuse login</code> again.",
      );
      return;
    }
    send(
      200,
      "Almost done",
      "Your terminal is finishing the sign-in. You can close this tab.",
    );
    resolveCode(code);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const authorizeUrl = `${apiUrl}/cli/authorize?${new URLSearchParams({
    port: String(port),
    state,
    name: hostname(),
  })}`;

  console.log("Opening your browser to authorize this computer…");
  console.log(`If it doesn't open, visit:\n\n  ${authorizeUrl}\n`);
  openBrowser(authorizeUrl);
  console.log("Waiting for you to approve…");

  const timer = setTimeout(
    () =>
      rejectCode(
        new CliError(
          "Timed out waiting for the browser. Run `npx billfuse login` again.",
        ),
      ),
    TIMEOUT_MS,
  );

  try {
    return await codePromise;
  } finally {
    clearTimeout(timer);
    server.close();
    // 给浏览器一点时间收完"Almost done"页面，再断开它保持着的连接，否则命令行要等很久才退出
    setTimeout(() => server.closeAllConnections(), 500).unref();
  }
}

// 远程机器（SSH）登录：把链接拿到任何一台已登录 Billfuse 的浏览器里打开，
// 点"授权"后页面显示一次性兑换码，再粘贴回这里
export async function pasteLogin(apiUrl: string): Promise<string> {
  const authorizeUrl = `${apiUrl}/cli/authorize?${new URLSearchParams({
    name: hostname(),
  })}`;
  console.log(
    `Open this link in any browser where you're signed in to Billfuse:\n\n  ${authorizeUrl}\n`,
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const code = (
      await rl.question("Paste the code shown after you approve: ")
    ).trim();
    if (!code)
      throw new CliError("No code entered. Run `npx billfuse login` again.");
    return code;
  } finally {
    rl.close();
  }
}
