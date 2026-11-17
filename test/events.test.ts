import { test } from "node:test";
import assert from "node:assert/strict";
import { isTerminal } from "../runner/events.ts";

test("isTerminal is true for a finished event", () => {
  assert.equal(
    isTerminal({ type: "finished", verdict: "pr_opened", costUsd: 0.1, turns: 3 }),
    true,
  );
});

test("isTerminal is false for a cost event", () => {
  assert.equal(isTerminal({ type: "cost", usd: 1 }), false);
});
