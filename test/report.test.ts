import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatReport, loadRuns, summarize } from "../runner/report.ts";
import type { Run } from "../runner/report.ts";
import type { VillageEvent } from "../runner/events.ts";

const started: VillageEvent = { type: "started", issue: 1, repo: "/r", branch: "village/issue-1", worktree: "/w" };

const runs: Run[] = [
  {
    id: "1-a",
    events: [
      started,
      { type: "blocked", tool: "Bash", reason: "git push is not allowed: the runner pushes the issue branch itself" },
      { type: "test_result", agent: "sam", command: "npm test", passed: false },
      { type: "test_result", agent: "sam", command: "npm test", passed: true },
      { type: "review", verdict: "REJECT", sha: "a" },
      { type: "review", verdict: "APPROVE", sha: "b" },
      { type: "verified", command: "npm test", passed: true, code: 0, ms: 1000, sha: "b" },
      { type: "finished", verdict: "pr_opened", pr: "u", costUsd: 0.4, turns: 12, durationMs: 300000 },
    ],
  },
  {
    id: "2-a",
    events: [
      started,
      { type: "test_result", agent: "sam", command: "npm test", passed: true },
      { type: "review", verdict: "APPROVE", sha: "c" },
      { type: "finished", verdict: "pr_opened", pr: "u2", costUsd: 0.2, turns: 8, durationMs: 180000 },
    ],
  },
  { id: "3-a", events: [{ type: "finished", verdict: "not_ready", costUsd: 0, turns: 0 }] },
  {
    id: "4-a",
    events: [
      started,
      { type: "blocked", tool: "Bash", reason: "git push is not allowed: the runner pushes the issue branch itself" },
      { type: "blocked", tool: "Bash", reason: "merging pull requests is not allowed" },
      { type: "verified", command: "npm test", passed: false, code: 1, ms: 900, sha: "d" },
      { type: "finished", verdict: "unreviewed", costUsd: 0.6, turns: 20 },
    ],
  },
  { id: "5-a", events: [started] }, // killed before finishing
];

test("summarize counts outcomes, costs, checks and blocks", () => {
  const c = summarize(runs);
  assert.equal(c.runs, 5);
  assert.equal(c.finished, 4);
  assert.equal(c.attempted, 3);
  assert.deepEqual(c.verdicts, { pr_opened: 2, not_ready: 1, unreviewed: 1, capped: 0, error: 0 });
  assert.equal(c.prsOpened, 2);
  assert.ok(Math.abs(c.totalCostUsd - 1.2) < 1e-9);
  assert.equal(c.medianCostUsd, 0.4);
  assert.ok(Math.abs(c.medianCostPerPrUsd! - 0.3) < 1e-9);
  assert.equal(c.medianTurns, 12);
  assert.equal(c.medianMinutes, 4);
  assert.equal(c.blocked, 3);
  assert.deepEqual(c.topBlockReasons[0], { reason: "git push is not allowed: the runner pushes the issue branch itself", count: 2 });
  assert.equal(c.reviews, 3);
  assert.equal(c.rejects, 1);
  assert.equal(c.runsWithReject, 1);
  assert.equal(c.firstPassApprovals, 1);
  assert.equal(c.agentTestRuns, 3);
  assert.equal(c.agentTestFailures, 1);
  assert.equal(c.runsWithTestFailure, 1);
  assert.equal(c.runnerChecks, 2);
  assert.equal(c.runnerCheckFailures, 1);
});

test("formatReport prints a readable scorecard, and a hint when empty", () => {
  const text = formatReport(summarize(runs));
  assert.match(text, /Runs: 5 \(3 attempted, 1 stopped at the input gate as not_ready\)/);
  assert.match(text, /Draft PRs opened: 2 of 3 attempted \(67%\)/);
  assert.match(text, /Cost: \$1\.20 total; median \$0\.40 per run, \$0\.30 per PR/);
  assert.match(text, /median wall time: 4\.0 min/);
  assert.match(text, /2 x git push is not allowed/);
  assert.match(formatReport(summarize([])), /No runs yet/);
});

test("loadRuns reads each run's events.jsonl, skipping partial lines and stray files", () => {
  const dir = mkdtempSync(join(tmpdir(), "village-report-"));
  mkdirSync(join(dir, "1-x"));
  writeFileSync(
    join(dir, "1-x", "events.jsonl"),
    `${JSON.stringify(started)}\n${JSON.stringify({ type: "finished", verdict: "capped", costUsd: 2, turns: 40 })}\n{"type":"fini`,
  );
  mkdirSync(join(dir, "2-empty"));
  writeFileSync(join(dir, "notes.txt"), "ignore me");
  const loaded = loadRuns(dir);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.events.length, 2);
  assert.deepEqual(loadRuns(join(dir, "missing")), []);
});
