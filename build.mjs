// 把命令行打包成一个文件 dist/index.js。
// 打包而不是逐个文件编译，是因为 src/shared.ts 引用了和 Billfuse 网站共用的代码，
// 发到 npm 的包里只有 dist，必须把那些代码一起装进去。
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

// 先清空：以前逐个文件编译留下的 api.js、render.js 等不能跟着发出去
await rm(here("./dist/"), { recursive: true, force: true });

await build({
  entryPoints: [here("./src/index.ts")],
  outfile: here("./dist/index.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  // 和 package.json 的 engines 一致
  target: "node18.17",
  legalComments: "none",
  logLevel: "warning",
});
