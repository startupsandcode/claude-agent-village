// Tests for the evaluation additions: test outcomes from hooks, Quinn review events,
// the runner-owned --verify check, durations, and the CLI surface for them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHooks, createReviewState, testsOk } from "../runner/guards.ts";
import type { ReviewState } from "../runner/guards.ts";
import type { VillageEvent } from "../runner/events.ts";
import { runIssue, shellCommand } from "../runner/run-issue.ts";
import type { RunOptions } from "../runner/run-issue.ts";
import type { Exec } from "../runner/git.ts";
import { formatEvent, parseArgs } from "../runner/cli.ts";

// ---- hooks ----

type HookName = "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "SubagentStop" | "Stop";

function hooksSetup() {
  const events: VillageEvent[] = [];
  const state: ReviewState = createReviewState();
  const hooks = createHooks({
    worktree: tmpdir(),
    state,
    getHeadSha: async () => "abc1234ffff",
    emit: (e) => events.push(e),
    requireReview: true,
  })!;
  const run = (event: HookName, input: Record<string, unknown>) =>
    hooks[event]![0]!.hooks[0]!(
      { session_id: "s", transcript_path: "t", cwd: "c", hook_event_name: event, ...input } as never,
      undefined,
      { signal: new AbortController().signal },
    ) as Promise<Record<string, unknown>>;
  const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command }, tool_use_id: "1" });
  return { events, state, run, bash };
}

test("a passing test command records passed and emits test_result", async () => {
  const h = hooksSetup();
  await h.run("PreToolUse", h.bash("npm test"));
  await h.run("PostToolUse", { ...h.bash("npm test"), tool_response: { stdout: "ok", stderr: "", interrupted: false } });
  assert.equal(h.state.ranTests, true);
  assert.equal(h.state.lastTestPassed, true);
  assert.ok(testsOk(h.state));
  const r = h.events.find((e) => e.type === "test_result");
  assert.deepEqual(r, { type: "test_result", agent: "maya", command: "npm test", passed: true });
});

test("a failing test command records failed; a later pass clears it", async () => {
  const h = hooksSetup();
  await h.run("PreToolUse", { ...h.bash("npm test"), agent_type: "sam" });
  await h.run("PostToolUseFailure", { ...h.bash("npm test"), agent_type: "sam", error: "Exit code 1" });
  assert.equal(h.state.lastTestPassed, false);
  assert.equal(testsOk(h.state), false);
  const failed = h.events.find((e) => e.type === "test_result");
  assert.deepEqual(failed, { type: "test_result", agent: "sam", command: "npm test", passed: false });
  await h.run("PostToolUse", { ...h.bash("npm test"), tool_response: { stdout: "", stderr: "", interrupted: false } });
  assert.equal(h.state.lastTestPassed, true);
});

test("non-test commands and other tools do not touch the test outcome", async () => {
  const h = hooksSetup();
  await h.run("PostToolUseFailure", { ...h.bash("ls missing"), error: "Exit code 2" });
  await h.run("PostToolUse", { tool_name: "Read", tool_input: { file_path: "x" }, tool_response: {}, tool_use_id: "2" });
  await h.run("PostToolUse", { ...h.bash("echo npm test"), tool_response: {} });
  assert.equal(h.state.lastTestPassed, null);
  assert.equal(h.events.filter((e) => e.type === "test_result").length, 0);
});

test("interrupted or backgrounded test runs leave the outcome unknown", async () => {
  const h = hooksSetup();
  await h.run("PostToolUse", { ...h.bash("npm test"), tool_response: { interrupted: true } });
  assert.equal(h.state.lastTestPassed, null);
  await h.run("PostToolUse", { ...h.bash("npm test"), tool_response: { interrupted: false, backgroundTaskId: "b1" } });
  assert.equal(h.state.lastTestPassed, null);
  await h.run("PostToolUseFailure", { ...h.bash("npm test"), error: "interrupted", is_interrupt: true });
  assert.equal(h.state.lastTestPassed, null);
});

test("Stop blocks when the last test run failed, even with Quinn's approval", async () => {
  const h = hooksSetup();
  h.state.ranTests = true;
  h.state.lastTestPassed = false;
  await h.run("SubagentStop", { agent_type: "quinn", last_assistant_message: "VERDICT: APPROVE" });
  const out = await h.run("Stop", { stop_hook_active: false });
  assert.equal(out.decision, "block");
  assert.match(String(out.reason), /last test run failed/);
});

test("Quinn's review is emitted as a review event with the reviewed sha", async () => {
  const h = hooksSetup();
  await h.run("SubagentStop", { agent_type: "quinn", last_assistant_message: "bad\nVERDICT: REJECT" });
  await h.run("SubagentStop", { agent_type: "quinn", last_assistant_message: "no verdict here" });
  await h.run("SubagentStop", { agent_type: "sam", last_assistant_message: "VERDICT: APPROVE" });
  const reviews = h.events.filter((e) => e.type === "review");
  assert.deepEqual(reviews, [
    { type: "review", verdict: "REJECT", sha: "abc1234ffff" },
    { type: "review", verdict: null, sha: "abc1234ffff" },
  ]);
});

// ---- runIssue with --verify ----

const SHA = "abc1234def5678";
const GOOD_BODY = "## Outcome\nDo it.\n\n## Acceptance criteria\n- [ ] works\n";
const villageDir = join(import.meta.dirname, "..", "village");

function fakeExec(verifyCode = 0) {
  const calls: { cmd: string; args: string[]; cwd?: string }[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const key = `${cmd} ${args.join(" ")}`;
    const ok = (stdout = "") => ({ stdout, code: 0 });
    if (key.startsWith("gh issue view")) return ok(JSON.stringify({ title: "T", body: GOOD_BODY }));
    if (key === "git rev-parse --is-inside-work-tree") return ok("true");
    if (key === "git remote") return ok("origin");
    if (key.startsWith("git rev-parse --verify")) return { stdout: "", code: 1 };
    if (key === "git fetch origin") return ok();
    if (key === "git symbolic-ref --short refs/remotes/origin/HEAD") return ok("origin/main\n");
    if (key.startsWith("git worktree add")) return ok();
    if (key === "git rev-parse HEAD") return ok(`${SHA}\n`);
    if (key === "git status --porcelain") return ok("");
    if (key === "git rev-parse --abbrev-ref HEAD") return ok("village/issue-5\n");
    if (key.startsWith("git push")) return ok();
    if (key.startsWith("gh pr create")) return ok("https://github.com/o/r/pull/9\n");
    if (cmd === "sh" && args[0] === "-c") return { stdout: "", code: verifyCode, stderr: verifyCode ? "1 failing" : "" };
    return { stdout: "", code: 1, stderr: `unexpected: ${key}` };
  };
  return { exec, calls };
}

// A fake SDK query that runs the given hooks: a test run (pass or fail), then Quinn's approval.
function fakeQuery(o: { testPasses?: boolean } = {}): RunOptions["queryFn"] {
  return (async function* (params: { prompt: string; options: any }) {
    const hooks = params.options.hooks;
    const signal = new AbortController().signal;
    const base = { session_id: "s", transcript_path: "t", cwd: "c" };
    const call = (name: string, input: Record<string, unknown>) =>
      hooks[name][0].hooks[0]({ ...base, hook_event_name: name, ...input }, "x", { signal });
    const bash = { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "1" };
    yield { type: "assistant", message: { content: [] } };
    await call("PreToolUse", bash);
    if (o.testPasses === false) await call("PostToolUseFailure", { ...bash, error: "Exit code 1" });
    else await call("PostToolUse", { ...bash, tool_response: { stdout: "", stderr: "", interrupted: false } });
    await call("SubagentStop", {
      stop_hook_active: false, agent_id: "a", agent_transcript_path: "p", agent_type: "quinn",
      last_assistant_message: "ok\nVERDICT: APPROVE",
    });
    yield { type: "result", subtype: "success", result: "Maya summary", total_cost_usd: 0.3, num_turns: 9, is_error: false };
  }) as unknown as RunOptions["queryFn"];
}

function setup(over: Partial<RunOptions> = {}, verifyCode = 0) {
  const root = mkdtempSync(join(tmpdir(), "village-eval-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const fx = fakeExec(verifyCode);
  const opts: RunOptions = {
    issue: 5, repo, villageDir, maxTurns: 30, maxUsd: 5, requireReview: true,
    exec: fx.exec, queryFn: fakeQuery(), runsDir: join(root, "runs"), platform: "linux", ...over,
  };
  return { opts, calls: fx.calls, runsDir: opts.runsDir };
}

async function collect(opts: RunOptions): Promise<VillageEvent[]> {
  const out: VillageEvent[] = [];
  for await (const e of runIssue(opts)) out.push(e);
  return out;
}
type Finished = Extract<VillageEvent, { type: "finished" }>;
const last = (events: VillageEvent[]) => events[events.length - 1] as Finished;

test("shellCommand uses cmd.exe on Windows and sh elsewhere", () => {
  assert.deepEqual(shellCommand("npm test", "win32"), ["cmd.exe", ["/d", "/c", "npm test"]]);
  assert.deepEqual(shellCommand("npm test", "linux"), ["sh", ["-c", "npm test"]]);
  assert.deepEqual(shellCommand("npm test", "darwin"), ["sh", ["-c", "npm test"]]);
});

test("--verify passing: runner runs it in the worktree after review, then opens the PR with the result", async () => {
  const s = setup({ verify: "npm test" });
  const events = await collect(s.opts);
  const started = events[0] as Extract<VillageEvent, { type: "started" }>;
  assert.match(started.note ?? "", /runner check: npm test/);
  const v = events.find((e) => e.type === "verified") as Extract<VillageEvent, { type: "verified" }>;
  assert.equal(v.passed, true);
  assert.equal(v.sha, SHA);
  const shellCall = s.calls.find((c) => c.cmd === "sh")!;
  assert.deepEqual(shellCall.args, ["-c", "npm test"]);
  assert.equal(shellCall.cwd, started.worktree);
  const shellIdx = s.calls.indexOf(shellCall);
  const prIdx = s.calls.findIndex((c) => c.cmd === "gh" && c.args[0] === "pr");
  assert.ok(shellIdx < prIdx, "verify runs before the PR is opened");
  const create = s.calls[prIdx]!;
  const body = create.args[create.args.indexOf("--body") + 1]!;
  assert.match(body, /Runner check: `npm test` passed at abc1234/);
  assert.equal(last(events).verdict, "pr_opened");
});

test("--verify failing: unreviewed with a note, nothing pushed, no PR", async () => {
  const s = setup({ verify: "npm test" }, 1);
  const events = await collect(s.opts);
  const f = last(events);
  assert.equal(f.verdict, "unreviewed");
  assert.match(f.note ?? "", /runner check `npm test` failed \(exit 1\) at abc1234/);
  assert.ok(!s.calls.some((c) => c.cmd === "git" && c.args[0] === "push"));
  assert.ok(!s.calls.some((c) => c.cmd === "gh" && c.args[0] === "pr"));
});

test("no --verify: no shell call and no verified event", async () => {
  const s = setup();
  const events = await collect(s.opts);
  assert.equal(last(events).verdict, "pr_opened");
  assert.ok(!s.calls.some((c) => c.cmd === "sh" || c.cmd === "cmd.exe"));
  assert.ok(!events.some((e) => e.type === "verified"));
});

test("agents' last test run failed: unreviewed even with Quinn's approval", async () => {
  const s = setup({ queryFn: fakeQuery({ testPasses: false }) });
  const events = await collect(s.opts);
  const f = last(events);
  assert.equal(f.verdict, "unreviewed");
  assert.match(f.note ?? "", /last test run failed/);
  assert.ok(events.some((e) => e.type === "test_result" && !e.passed));
  assert.ok(events.some((e) => e.type === "review" && e.verdict === "APPROVE"));
});

test("finished carries durationMs and the log has the new events", async () => {
  const s = setup({ verify: "npm test" });
  const events = await collect(s.opts);
  const f = last(events);
  assert.equal(typeof f.durationMs, "number");
  assert.ok(f.durationMs! >= 0);
  const dir = readdirSync(s.runsDir)[0]!;
  const logged = readFileSync(join(s.runsDir, dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(logged, events);
  for (const t of ["test_result", "review", "verified"]) assert.ok(logged.some((e) => e.type === t), t);
});

// ---- CLI ----

test("--verify and report parse", () => {
  assert.deepEqual(parseArgs(["work", "4", "--verify", "npm test"]), {
    command: "work", issue: 4, repo: process.cwd(), maxTurns: 40, maxUsd: 2, requireReview: true, verify: "npm test",
  });
  assert.deepEqual(parseArgs(["report"]), { command: "report" });
  assert.deepEqual(parseArgs(["report", "--runs", "/tmp/r"]), { command: "report", runsDir: "/tmp/r" });
  assert.throws(() => parseArgs(["work", "4", "--verify"]), /Usage/);
  assert.throws(() => parseArgs(["work", "4", "--verify", "--no-review"]), /Usage/);
  assert.throws(() => parseArgs(["report", "--bogus"]), /Usage/);
  assert.throws(() => parseArgs(["report", "--runs"]), /Usage/);
});

test("formatEvent covers the new events and shows duration on finished", () => {
  assert.equal(formatEvent({ type: "test_result", agent: "sam", command: "npm test", passed: false }), "[tests] sam: FAILED (npm test)");
  assert.equal(formatEvent({ type: "review", verdict: "APPROVE", sha: "abc1234ffff" }), "[review] quinn: APPROVE on abc1234");
  assert.equal(formatEvent({ type: "review", verdict: null, sha: null }), "[review] quinn: no verdict");
  assert.equal(
    formatEvent({ type: "verified", command: "npm test", passed: true, code: 0, ms: 2500, sha: "abc1234ffff" }),
    "[verify] runner check passed: npm test at abc1234 in 2.5s",
  );
  assert.match(
    formatEvent({ type: "finished", verdict: "pr_opened", costUsd: 0.29, turns: 9, durationMs: 270000 }),
    /\(9 turns, \$0\.2900, 4\.5 min\)/,
  );
});
