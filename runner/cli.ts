import { resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { VillageEvent } from "./events.ts";
import { realExec } from "./git.ts";
import { runIssue } from "./run-issue.ts";

const USAGE =
  "Usage: village work <issue-number> [--repo <path>] [--max-turns <n>] [--max-usd <n>] [--no-review]";

export type CliArgs = {
  command: "work";
  issue: number;
  repo: string;
  maxTurns: number;
  maxUsd: number;
  requireReview: boolean;
};

const positive = (raw: string | undefined): number => {
  const n = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(n) || n <= 0) throw new Error(USAGE);
  return n;
};

export function parseArgs(argv: string[]): CliArgs {
  const [command, issueRaw, ...rest] = argv;
  if (command !== "work" || issueRaw === undefined || !/^\d+$/.test(issueRaw) || Number(issueRaw) < 1) {
    throw new Error(USAGE);
  }
  const args: CliArgs = {
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
    case "cost":
      return `[cost] $${e.usd.toFixed(4)}`;
    case "finished":
      return `[finished] ${e.verdict}${e.pr ? ` ${e.pr}` : ""} (${e.turns} turns, $${e.costUsd.toFixed(4)})${e.note ? ` - ${e.note}` : ""}`;
  }
}

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Copy .env.example to .env and fill it in.");
    return 2;
  }
  if (!args.requireReview) console.log("[warning] review gate disabled (--no-review)");

  const root = resolve(import.meta.dirname, "..");
  const runsDir = resolve(root, "runs");
  let verdict = "error";
  for await (const e of runIssue({
    issue: args.issue,
    repo: resolve(args.repo),
    villageDir: resolve(root, "village"),
    maxTurns: args.maxTurns,
    maxUsd: args.maxUsd,
    requireReview: args.requireReview,
    exec: realExec,
    queryFn: query,
    runsDir,
  })) {
    console.log(formatEvent(e));
    if (e.type === "finished") verdict = e.verdict;
  }
  // runIssue does not expose the per-run log path, so name the runs directory.
  console.log(`verdict: ${verdict}; run logs under ${runsDir}`);
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
