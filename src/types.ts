// 和服务端 src/lib/cli-status.ts 的 CliStatus 一致。只增不改，老版本命令行还要能读
export type CliStatus = {
  month: string;
  asOf: string;
  monthToDate: number;
  budget: number | null;
  remaining: number | null;
  percentUsed: number | null;
  projectedMonthEnd: number;
  providers: {
    provider: string;
    name: string;
    cost: number;
    share: number;
    status: string | null;
    lastSyncedAt: string | null;
    error: string | null;
  }[];
  topModels: {
    model: string;
    provider: string | null;
    cost: number;
    tokens: number | null;
  }[];
  explanation: string | null;
  dashboardUrl: string;
};

export type Config = {
  apiUrl: string;
  token: string;
};
