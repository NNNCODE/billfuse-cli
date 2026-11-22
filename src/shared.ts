// 命令行和 Billfuse 网站共用的代码都从这一个文件进来，别的文件不要绕过它直接引用。
// 构建时 build.mjs 会把它们一起打包进 dist/index.js。
// 只能引用不碰数据库、不依赖网站框架的文件：这里引用了什么，发布时就公开什么。
import { lockOfficialAddresses } from "./core/providers/http";

// 这台电脑上的环境变量不归我们管。管理密钥只发给服务商的官方地址，
// 哪怕设了 OPENAI_API_BASE_URL 这类变量（有些工具用同样的名字指向代理）。
// 放在这个文件里，是因为命令行要用服务商的代码只能从这里拿：拿到的时候就已经锁上了
lockOfficialAddresses();

export { parseBudget } from "./core/budget";
export { monthStart, syncStartDay } from "./core/dates";
export { explainSpend } from "./core/explain";
export { fetchDailyCosts } from "./core/providers/index";
export type { FetchLike } from "./core/providers/http";
export {
  PROVIDER_LABEL,
  ProviderError,
  type Provider,
} from "./core/providers/types";
export {
  summarizeSpend,
  wholePercent,
  type SpendRow,
} from "./core/spend";
