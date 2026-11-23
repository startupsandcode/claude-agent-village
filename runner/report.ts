/**
 * Scorecard over past runs: reads runs/<issue>-<timestamp>/events.jsonl and summarises what the
 * village did, what it cost, and how often each check caught something. No API calls.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { VillageEvent, Verdict } from "./events.ts";

export type Run = { id: string; events: VillageEvent[] };

export function loadRuns(runsDir: string): Run[] {
  if (!existsSync(runsDir)) return [];
  const runs: Run[] = [];
  for (const id of readdirSync(runsDir).sort()) {
    const file = join(runsDir, id, "events.jsonl");
    if (!existsSync(file) || !statSync(file).isFile()) continue;
    const events: VillageEvent[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      try {
        events.push(JSON.parse(line) as VillageEvent);
      } catch {
        // A run killed mid-write can leave a partial last line; skip it.
      }
    }
    runs.push({ id, events });
  }
  return runs;
}

export type Scorecard = {
  runs: number;
  finished: number;
  verdicts: Record<Verdict, number>;
  attempted: number; // finished runs that got past the input gate (not not_ready)
  prsOpened: number;
  totalCostUsd: number;
  medianCostUsd: number | null; // over attempted runs
  medianCostPerPrUsd: number | null;
  medianTurns: number | null; // over attempted runs
  medianMinutes: number | null; // over attempted runs that recorded a duration
  blocked: number;
  topBlockReasons: { reason: string; count: number }[];
  reviews: number;
  rejects: number;
  runsWithReject: number;
  firstPassApprovals: number; // runs whose first review was APPROVE
  agentTestRuns: number;
  agentTestFailures: number;
  runsWithTestFailure: number;
  runnerChecks: number;
  runnerCheckFailures: number;
};

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function summarize(runs: Run[]): Scorecard {
  const verdicts: Record<Verdict, number> = { pr_opened: 0, not_ready: 0, unreviewed: 0, capped: 0, error: 0 };
  const costs: number[] = [];
  const prCosts: number[] = [];
  const turns: number[] = [];
  const minutes: number[] = [];
  const reasons = new Map<string, number>();
  const card = {
    runs: runs.length, finished: 0, attempted: 0, prsOpened: 0, totalCostUsd: 0, blocked: 0,
    reviews: 0, rejects: 0, runsWithReject: 0, firstPassApprovals: 0,
    agentTestRuns: 0, agentTestFailures: 0, runsWithTestFailure: 0, runnerChecks: 0, runnerCheckFailures: 0,
  };

  for (const run of runs) {
    let firstReview: string | null | undefined;
    let rejected = false;
    let testFailed = false;
    for (const e of run.events) {
      if (e.type === "blocked") {
        card.blocked++;
        reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
      } else if (e.type === "review") {
        card.reviews++;
        if (firstReview === undefined) firstReview = e.verdict;
        if (e.verdict === "REJECT") {
          card.rejects++;
          rejected = true;
        }
      } else if (e.type === "test_result") {
        card.agentTestRuns++;
        if (!e.passed) {
          card.agentTestFailures++;
          testFailed = true;
        }
      } else if (e.type === "verified") {
        card.runnerChecks++;
        if (!e.passed) card.runnerCheckFailures++;
      }
    }
    if (rejected) card.runsWithReject++;
    if (testFailed) card.runsWithTestFailure++;
    if (firstReview === "APPROVE") card.firstPassApprovals++;

    const fin = [...run.events].reverse().find((e) => e.type === "finished") as
      | Extract<VillageEvent, { type: "finished" }>
      | undefined;
    if (!fin) continue;
    card.finished++;
    verdicts[fin.verdict]++;
    card.totalCostUsd += fin.costUsd;
    if (fin.verdict === "not_ready") continue;
    card.attempted++;
    costs.push(fin.costUsd);
    turns.push(fin.turns);
    if (typeof fin.durationMs === "number") minutes.push(fin.durationMs / 60000);
    if (fin.verdict === "pr_opened") {
      card.prsOpened++;
      prCosts.push(fin.costUsd);
    }
  }

  return {
    ...card,
    verdicts,
    medianCostUsd: median(costs),
    medianCostPerPrUsd: median(prCosts),
    medianTurns: median(turns),
    medianMinutes: median(minutes),
    topBlockReasons: [...reasons.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 3),
  };
}

const usd = (n: number | null) => (n === null ? "n/a" : `$${n.toFixed(2)}`);
const num = (n: number | null, digits = 0) => (n === null ? "n/a" : n.toFixed(digits));
const pct = (a: number, b: number) => (b === 0 ? "n/a" : `${Math.round((100 * a) / b)}%`);

export function formatReport(c: Scorecard): string {
  if (c.runs === 0) return "No runs yet. Run `npm run village -- work <issue> --repo <path>` first.";
  const v = c.verdicts;
  const lines = [
    `Runs: ${c.runs} (${c.attempted} attempted, ${v.not_ready} stopped at the input gate as not_ready)`,
    `Draft PRs opened: ${c.prsOpened} of ${c.attempted} attempted (${pct(c.prsOpened, c.attempted)})`,
    `Other outcomes: ${v.unreviewed} unreviewed, ${v.capped} capped, ${v.error} error`,
    `Cost: ${usd(c.totalCostUsd)} total; median ${usd(c.medianCostUsd)} per run, ${usd(c.medianCostPerPrUsd)} per PR`,
    `Median turns: ${num(c.medianTurns)}; median wall time: ${c.medianMinutes === null ? "n/a" : `${num(c.medianMinutes, 1)} min`}`,
    `Reviews: ${c.reviews} (${c.rejects} rejected); runs with a Quinn rejection: ${c.runsWithReject}; first-pass approvals: ${c.firstPassApprovals}`,
    `Agent test runs: ${c.agentTestRuns} (${c.agentTestFailures} failed); runs where tests caught a failure: ${c.runsWithTestFailure}`,
    `Runner checks (--verify): ${c.runnerChecks} (${c.runnerCheckFailures} failed)`,
    `Blocked actions: ${c.blocked}`,
    ...c.topBlockReasons.map((r) => `  ${r.count} x ${r.reason}`),
  ];
  return lines.join("\n");
}
