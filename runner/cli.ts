import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { VillageEvent } from "./events.ts";
import { realExec } from "./git.ts";
import { formatReport, loadRuns, summarize } from "./report.ts";
import { runIssue } from "./run-issue.ts";

const USAGE =
  "Usage: village work <issue-number> [--repo <path>] [--max-turns <n>] [--max-usd <n>] [--no-review] [--verify <command>]\n" +
  "       village report [--runs <dir>]";

export type WorkArgs = {
  command: "work";
  issue: number;
  repo: string;
  maxTurns: number;
  maxUsd: number;
  requireReview: boolean;
  verify?: string;
};
export type ReportArgs = { command: "report"; runsDir?: string };
export type CliArgs = WorkArgs | ReportArgs;

const positive = (raw: string | undefined): number => {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n) || n <= 0) throw new Error(USAGE);
  return n;
};

const value = (raw: string | undefined): string => {
  if (raw === undefined || raw.trim() === "" || raw.startsWith("--")) throw new Error(USAGE);
  return raw;
};

export function parseArgs(argv: string[]): CliArgs {
  if (argv[0] === "report") {
    const flags = argv.slice(1);
    const args: ReportArgs = { command: "report" };
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--runs") args.runsDir = value(flags[++i]);
      else throw new Error(USAGE);
    }
    return args;
  }
  const [command, issueRaw, ...rest] = argv;
  if (command !== "work" || issueRaw === undefined || !/^\d+$/.test(issueRaw) || Number(issueRaw) < 1) {
    throw new Error(USAGE);
  }
  const args: WorkArgs = {
    command: "work",
    issue: Number(issueRaw),
    repo: process.cwd(),
    maxTurns: 40,
    maxUsd: 2,
    requireReview: true,
  };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--no-review") args.requireReview = false;
    else if (flag === "--repo") {
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(USAGE);
      args.repo = v;
    } else if (flag === "--max-turns") {
      const n = positive(rest[++i]);
      if (!Number.isInteger(n)) throw new Error(USAGE);
      args.maxTurns = n;
    } else if (flag === "--max-usd") args.maxUsd = positive(rest[++i]);
    else if (flag === "--verify") args.verify = value(rest[++i]);
    else throw new Error(USAGE);
  }
  return args;
}

export function formatEvent(e: VillageEvent): string {
  switch (e.type) {
    case "started":
      return `[started] issue #${e.issue} on ${e.branch} (${e.worktree})${e.note ? ` - ${e.note}` : ""}`;
    case "agent_started":
      return `[agent] ${e.agent} started`;
    case "tool_call":
      return `[tool] ${e.agent}: ${e.tool} ${e.summary}`;
    case "blocked":
      return `[blocked] ${e.tool}: ${e.reason}`;
    case "agent_finished":
      return `[agent] ${e.agent} finished`;
    case "test_result":
      return `[tests] ${e.agent}: ${e.passed ? "passed" : "FAILED"} (${e.command})`;
    case "review":
      return `[review] quinn: ${e.verdict ?? "no verdict"}${e.sha ? ` on ${e.sha.slice(0, 7)}` : ""}`;
    case "design_required":
      return `[design] susie required: ${e.reason}`;
    case "verified":
      return `[verify] runner check ${e.passed ? "passed" : `FAILED (exit ${e.code})`}: ${e.command} at ${e.sha.slice(0, 7)} in ${(e.ms / 1000).toFixed(1)}s`;
    case "cost":
      return `[cost] $${e.usd.toFixed(4)}`;
    case "finished":
      return `[finished] ${e.verdict}${e.pr ? ` ${e.pr}` : ""} (${e.turns} turns, $${e.costUsd.toFixed(4)}${typeof e.durationMs === "number" ? `, ${(e.durationMs / 60000).toFixed(1)} min` : ""})${e.note ? ` - ${e.note}` : ""}${e.worktree ? ` [worktree ${e.worktree}]` : ""}${e.logPath ? ` [log ${e.logPath}]` : ""}`;
  }
}

export function finalLine(verdict: string, logPath: string | undefined): string {
  return `verdict: ${verdict}; ${logPath ? `run log: ${logPath}` : "no run log"}`;
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  const root = resolve(import.meta.dirname, "..");
  if (args.command === "report") {
    console.log(formatReport(summarize(loadRuns(resolve(args.runsDir ?? resolve(root, "runs"))))));
    return 0;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
    return 2;
  }
  if (!args.requireReview) console.log("[warning] review gate disabled (--no-review)");

  const runsDir = resolve(root, "runs");
  let verdict = "error";
  let logPath: string | undefined;
  for await (const e of runIssue({
    issue: args.issue,
    repo: resolve(args.repo),
    villageDir: resolve(root, "village"),
    maxTurns: args.maxTurns,
    maxUsd: args.maxUsd,
    requireReview: args.requireReview,
    ...(args.verify ? { verify: args.verify } : {}),
    exec: realExec,
    queryFn: query,
    runsDir,
  })) {
    console.log(formatEvent(e));
    if (e.type === "finished") {
      verdict = e.verdict;
      logPath = e.logPath;
    }
  }
  console.log(finalLine(verdict, logPath));
  return verdict === "pr_opened" ? 0 : 1;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
