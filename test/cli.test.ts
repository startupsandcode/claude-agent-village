import { test } from "node:test";
import assert from "node:assert/strict";
import { finalLine, formatEvent, parseArgs } from "../runner/cli.ts";

test("work <n> gives defaults", () => {
  assert.deepEqual(parseArgs(["work", "12"]), {
    command: "work",
    issue: 12,
    repo: process.cwd(),
    maxTurns: 40,
    maxUsd: 2,
    requireReview: true,
  });
});

test("all flags parse", () => {
  const a = parseArgs(["work", "3", "--repo", "/tmp/x", "--max-turns", "10", "--max-usd", "0.5", "--no-review"]);
  assert.deepEqual(a, { command: "work", issue: 3, repo: "/tmp/x", maxTurns: 10, maxUsd: 0.5, requireReview: false });
});

test("bad input throws usage", () => {
  assert.throws(() => parseArgs(["work"]), /Usage/);
  assert.throws(() => parseArgs(["work", "abc"]), /Usage/);
  assert.throws(() => parseArgs(["wrk", "1"]), /Usage/);
  assert.throws(() => parseArgs(["work", "1", "--max-usd", "x"]), /Usage/);
  assert.throws(() => parseArgs(["work", "1", "--bogus"]), /Usage/);
  assert.throws(() => parseArgs(["work", "1", "--repo"]), /Usage/);
});

test("final line prints the verdict and the log path", () => {
  assert.equal(finalLine("pr_opened", "/r/runs/5-x/events.jsonl"), "verdict: pr_opened; run log: /r/runs/5-x/events.jsonl");
  assert.equal(finalLine("error", undefined), "verdict: error; no run log");
});

test("formatEvent finished shows the worktree and log path when present", () => {
  const line = formatEvent({ type: "finished", verdict: "unreviewed", costUsd: 1, turns: 2, worktree: "/w", logPath: "/l" });
  assert.match(line, /worktree \/w/);
  assert.match(line, /log \/l/);
});
