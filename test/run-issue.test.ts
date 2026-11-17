import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIssue } from "../runner/run-issue.ts";
import type { RunOptions } from "../runner/run-issue.ts";
import type { VillageEvent } from "../runner/events.ts";
import type { Exec } from "../runner/git.ts";

type Call = { cmd: string; args: string[]; cwd?: string };

const SHA = "abc1234def5678";
const GOOD_BODY = "## Outcome\nDo it.\n\n## Acceptance criteria\n- [ ] works\n";
const villageDir = join(import.meta.dirname, "..", "village");

function fakeExec(o: { repo?: string; body?: string; dirty?: boolean; branchExists?: boolean; sha?: () => string } = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const key = `${cmd} ${args.join(" ")}`;
    const ok = (stdout = "") => ({ stdout, code: 0 });
    if (key.startsWith("gh issue view")) {
      assert.equal(opts?.cwd, o.repo ?? opts?.cwd);
      assert.ok(!args.includes("--repo"));
    }
    if (key.startsWith("gh issue view")) return ok(JSON.stringify({ title: "T", body: o.body ?? GOOD_BODY }));
    if (key === "git rev-parse --is-inside-work-tree") return ok("true");
    if (key === "git remote") return ok("origin");
    if (key.startsWith("git rev-parse --verify")) return { stdout: "", code: o.branchExists ? 0 : 1 };
    if (key.startsWith("git worktree add")) return ok();
    if (key === "git rev-parse HEAD") return ok(`${o.sha ? o.sha() : SHA}\n`);
    if (key === "git status --porcelain") return ok(o.dirty ? " M file.ts\n" : "");
    if (key === "git rev-parse --abbrev-ref HEAD") return ok("village/issue-5\n");
    if (key.startsWith("git push")) return ok();
    if (key.startsWith("gh pr create")) return ok("https://github.com/o/r/pull/9\n");
    return { stdout: "", code: 1, stderr: `unexpected: ${key}` };
  };
  return { exec, calls };
}

type Script = { isError?: boolean; test?: boolean; quinn?: boolean; subtype?: string };
type Seen = { options?: any; prompt?: string };

// Like the real SDK, the fake runs the hooks it was given.
function fakeQuery(script: Script, seen: Seen = {}): RunOptions["queryFn"] {
  return (async function* (params: { prompt: string; options: any }) {
    seen.options = params.options;
    seen.prompt = params.prompt;
    const hooks = params.options.hooks;
    const signal = new AbortController().signal;
    const base = { session_id: "s", transcript_path: "t", cwd: "c" };
    yield { type: "assistant", message: { content: [] } };
    if (script.test !== false) {
      await hooks.PreToolUse[0].hooks[0](
        { ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "1" },
        "1",
        { signal },
      );
    }
    if (script.quinn) {
      await hooks.SubagentStart[0].hooks[0](
        { ...base, hook_event_name: "SubagentStart", agent_id: "a", agent_type: "quinn" },
        "2",
        { signal },
      );
      await hooks.SubagentStop[0].hooks[0](
        {
          ...base, hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: "a",
          agent_transcript_path: "p", agent_type: "quinn", last_assistant_message: "ok\nVERDICT: APPROVE",
        },
        "3",
        { signal },
      );
    }
    const subtype = script.subtype ?? "success";
    yield subtype === "success" && script.isError
      ? { type: "result", subtype, result: "API Error: 500", total_cost_usd: 0.5, num_turns: 4, is_error: true }
      : subtype === "success"
      ? { type: "result", subtype, result: "Maya summary", total_cost_usd: 0.5, num_turns: 4, is_error: false }
      : { type: "result", subtype, total_cost_usd: 1.25, num_turns: 7, is_error: true };
  }) as unknown as RunOptions["queryFn"];
}

function setup(over: Partial<RunOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "village-run-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const runsDir = join(root, "runs");
  const fx = fakeExec();
  const opts: RunOptions = {
    issue: 5, repo, villageDir, maxTurns: 30, maxUsd: 5, requireReview: true,
    exec: fx.exec, queryFn: fakeQuery({ quinn: true }), runsDir, ...over,
  };
  return { opts, repo, runsDir, calls: fx.calls };
}

async function collect(opts: RunOptions): Promise<VillageEvent[]> {
  const out: VillageEvent[] = [];
  for await (const e of runIssue(opts)) out.push(e);
  return out;
}

type Finished = Extract<VillageEvent, { type: "finished" }>;
const last = (events: VillageEvent[]) => events[events.length - 1] as Finished;
const prCreates = (calls: Call[]) => calls.filter((c) => c.cmd === "gh" && c.args[0] === "pr");

function logLines(runsDir: string): unknown[] {
  const dir = readdirSync(runsDir)[0]!;
  return readFileSync(join(runsDir, dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

test("no criteria yields one not_ready and creates no worktree", async () => {
  const fx = fakeExec({ body: "## Outcome\nnothing\n" });
  const s = setup({ exec: fx.exec });
  const events = await collect(s.opts);
  assert.equal(events.length, 1);
  assert.equal(last(events).verdict, "not_ready");
  assert.ok(!fx.calls.some((c) => c.args[0] === "worktree"));
  assert.ok(existsSync(s.runsDir), "run log dir still created");
  assert.deepEqual(logLines(s.runsDir), events);
});

test("happy path opens a draft PR once", async () => {
  const s = setup();
  const events = await collect(s.opts);
  assert.equal(events[0]!.type, "started");
  const f = last(events);
  assert.equal(f.verdict, "pr_opened");
  assert.equal(f.pr, "https://github.com/o/r/pull/9");
  assert.equal(f.costUsd, 0.5);
  assert.equal(f.turns, 4);
  const creates = prCreates(s.calls);
  assert.equal(creates.length, 1);
  const body = creates[0]!.args[creates[0]!.args.indexOf("--body") + 1]!;
  assert.match(body, /Maya summary/);
  assert.match(body, /Verified: tests run, Quinn approved abc1234/);
  const types = events.map((e) => e.type);
  for (const t of ["tool_call", "agent_started", "agent_finished", "cost"]) assert.ok(types.includes(t as never), t);
});

test("queryFn receives the prompt and configured options", async () => {
  const s = setup();
  const seen: Seen = {};
  const events = await collect({ ...s.opts, queryFn: fakeQuery({ quinn: true }, seen) });
  const started = events[0] as Extract<VillageEvent, { type: "started" }>;
  assert.equal(seen.options.cwd, started.worktree);
  assert.equal(seen.options.maxTurns, 30);
  assert.equal(seen.options.maxBudgetUsd, 5);
  assert.ok(seen.options.settingSources.includes("project"));
  assert.deepEqual(Object.keys(seen.options.agents).sort(), ["quinn", "sam", "susie", "theo"]);
  assert.ok(seen.options.hooks.PreToolUse && seen.options.hooks.Stop);
  assert.equal(seen.options.systemPrompt.preset, "claude_code");
  assert.equal(
    seen.prompt,
    "Work GitHub issue #5 in this repository: T\n\n" + GOOD_BODY +
      "\n\nCommit your work on the current branch. Do not push, open a pull request, or merge: the runner does that after Quinn approves.",
  );
  assert.equal(started.note, undefined);
});

test("budget cap yields capped, no PR, and the log keeps events so far", async () => {
  const s = setup({ queryFn: fakeQuery({ subtype: "error_max_budget_usd" }) });
  const events = await collect(s.opts);
  assert.equal(last(events).verdict, "capped");
  assert.equal(last(events).costUsd, 1.25);
  assert.equal(prCreates(s.calls).length, 0);
  assert.deepEqual(logLines(s.runsDir), events);
  assert.ok(logLines(s.runsDir).length >= 3);
});

test("turn cap yields capped; other result errors yield error", async () => {
  const a = setup({ queryFn: fakeQuery({ subtype: "error_max_turns" }) });
  assert.equal(last(await collect(a.opts)).verdict, "capped");
  const b = setup({ queryFn: fakeQuery({ subtype: "error_during_execution" }) });
  assert.equal(last(await collect(b.opts)).verdict, "error");
});

test("success without Quinn yields unreviewed and no PR", async () => {
  const s = setup({ queryFn: fakeQuery({ quinn: false }) });
  const events = await collect(s.opts);
  assert.equal(last(events).verdict, "unreviewed");
  assert.equal(prCreates(s.calls).length, 0);
});

test("approval of a stale commit yields unreviewed", async () => {
  let n = 0;
  const fx = fakeExec({ sha: () => (n++ === 0 ? "1111111aaaa" : "2222222bbbb") });
  const s = setup({ exec: fx.exec });
  const events = await collect(s.opts);
  assert.equal(last(events).verdict, "unreviewed");
  assert.equal(prCreates(fx.calls).length, 0);
});

test("requireReview false opens the PR on a clean success", async () => {
  const s = setup({ requireReview: false, queryFn: fakeQuery({ quinn: false, test: false }) });
  const events = await collect(s.opts);
  assert.equal(last(events).verdict, "pr_opened");
  assert.equal(prCreates(s.calls).length, 1);
});

test("R8: dirty worktree yields unreviewed with a note and no PR", async () => {
  const fx = fakeExec({ dirty: true });
  const s = setup({ exec: fx.exec });
  const events = await collect(s.opts);
  const f = last(events);
  assert.equal(f.verdict, "unreviewed");
  assert.match(f.note ?? "", /uncommitted/);
  assert.equal(prCreates(fx.calls).length, 0);
  assert.ok(fx.calls.some((c) => c.cmd === "git" && c.args.join(" ") === "status --porcelain" && c.cwd?.includes("issue-5")));
});

test("target repo quinn overrides the village quinn and is noted", async () => {
  const s = setup();
  mkdirSync(join(s.repo, ".claude", "agents"), { recursive: true });
  writeFileSync(join(s.repo, ".claude", "agents", "quinn.md"), "---\ndescription: Target quinn\n---\nTARGET QUINN PROMPT\n");
  const seen: Seen = {};
  const events = await collect({ ...s.opts, queryFn: fakeQuery({ quinn: true }, seen) });
  assert.equal(seen.options.agents.quinn.prompt, "TARGET QUINN PROMPT");
  const started = events[0] as Extract<VillageEvent, { type: "started" }>;
  assert.equal(started.note, "overridden by target repo: quinn");
});

test("R10: malformed target agent file yields finished error, not a throw", async () => {
  const fx = fakeExec();
  const s = setup({ exec: fx.exec });
  mkdirSync(join(s.repo, ".claude", "agents"), { recursive: true });
  writeFileSync(join(s.repo, ".claude", "agents", "bad.md"), "no frontmatter here");
  const events = await collect(s.opts);
  assert.equal(events.length, 1);
  assert.equal(last(events).verdict, "error");
  assert.match(last(events).note ?? "", /frontmatter/);
  assert.ok(!fx.calls.some((c) => c.args[0] === "worktree"));
  assert.deepEqual(logLines(s.runsDir), events);
});

test("R10: createWorktree failing because the branch exists yields finished error", async () => {
  const fx = fakeExec({ branchExists: true });
  const s = setup({ exec: fx.exec });
  const events = await collect(s.opts);
  assert.equal(events.length, 1);
  assert.equal(last(events).verdict, "error");
  assert.match(last(events).note ?? "", /already exists/);
});

test("R10: openDraftPr failure yields finished error with cost so far", async () => {
  const base = fakeExec();
  const exec: Exec = async (cmd, args, opts) =>
    cmd === "gh" && args[0] === "pr" ? { stdout: "", code: 1, stderr: "boom" } : base.exec(cmd, args, opts);
  const s = setup({ exec });
  const events = await collect(s.opts);
  assert.equal(last(events).verdict, "error");
  assert.equal(last(events).costUsd, 0.5);
  assert.match(last(events).note ?? "", /boom/);
});

test("run log has one JSON line per yielded event", async () => {
  const s = setup();
  const events = await collect(s.opts);
  assert.deepEqual(logLines(s.runsDir), events);
});

test("success result with is_error maps to error, even after Quinn approved; no PR", async () => {
  const s = setup({ queryFn: fakeQuery({ quinn: true, isError: true }) });
  const events = await collect(s.opts);
  assert.equal(last(events).verdict, "error");
  assert.match(last(events).note ?? "", /API Error/);
  assert.equal(prCreates(s.calls).length, 0);
});

test("permission mode and allowed tools are pinned; gh issue view runs in the repo", async () => {
  const s = setup();
  const fx = fakeExec({ repo: s.repo });
  const seen: Seen = {};
  await collect({ ...s.opts, exec: fx.exec, queryFn: fakeQuery({ quinn: true }, seen) });
  assert.equal(seen.options.permissionMode, "acceptEdits");
  assert.deepEqual(seen.options.allowedTools, ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "Agent"]);
  assert.equal(seen.options.allowDangerouslySkipPermissions, undefined);
  const view = fx.calls.find((c) => c.cmd === "gh" && c.args[0] === "issue")!;
  assert.equal(view.cwd, s.repo);
});
