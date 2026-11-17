import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../runner/cli.ts";

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
