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

function fakeExec(o: { repo?: string; body?: string; labels?: string[]; changed?: string[]; diffFails?: boolean; dirty?: boolean; branchExists?: boolean; sha?: () => string; worktreeAgents?: Record<string, string | null>; head?: string } = {}) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const key = `${cmd} ${args.join(" ")}`;
    const ok = (stdout = "") => ({ stdout, code: 0 });
    if (key.startsWith("gh issue view")) {
      assert.equal(opts?.cwd, o.repo ?? opts?.cwd);
      assert.ok(!args.includes("--repo"));
    }
    if (key.startsWith("gh issue view")) {
      return ok(JSON.stringify({ title: "T", body: o.body ?? GOOD_BODY, labels: (o.labels ?? []).map((name) => ({ name })) }));
    }
    if (key === "git rev-parse --is-inside-work-tree") return ok("true");
    if (key === "git remote") return ok("origin");
    if (key.startsWith("git rev-parse --verify")) return { stdout: "", code: o.branchExists ? 0 : 1 };
    if (key === "git fetch origin") return ok();
    if (key === "git symbolic-ref --short refs/remotes/origin/HEAD") return ok("origin/main\n");
    if (key.startsWith("git worktree add")) {
      if (o.worktreeAgents) {
        const dir = join(args[4]!, ".claude", "agents");
        mkdirSync(dir, { recursive: true });
        for (const [f, text] of Object.entries(o.worktreeAgents)) {
          if (text === null) mkdirSync(join(dir, f));
          else writeFileSync(join(dir, f), text);
        }
      }
      return ok();
    }
    if (key === "git rev-parse HEAD") return ok(`${o.sha ? o.sha() : SHA}\n`);
    if (key === "git status --porcelain") return ok(o.dirty ? " M file.ts\n" : "");
    if (key === "git rev-parse --abbrev-ref HEAD") return ok(`${o.head ?? "village/issue-5"}\n`);
    if (key === "git diff --name-only origin/main...HEAD") {
      return o.diffFails ? { stdout: "", code: 128, stderr: "bad revision" } : ok((o.changed ?? ["src/app.ts"]).join("\n"));
    }
    if (key.startsWith("git push")) return ok();
    if (key.startsWith("gh pr create")) return ok("https://github.com/o/r/pull/9\n");
    return { stdout: "", code: 1, stderr: `unexpected: ${key}` };
  };
  return { exec, calls };
}

type Script = { isError?: boolean; test?: boolean; quinn?: boolean; susie?: boolean; quinnFirst?: boolean; subtype?: string };
type Seen = { options?: any; prompt?: string; quinnDenied?: boolean };

// Like the real SDK, the fake runs every hook it was given for an event, in order.
function fakeQuery(script: Script, seen: Seen = {}): RunOptions["queryFn"] {
  return (async function* (params: { prompt: string; options: any }) {
    seen.options = params.options;
    seen.prompt = params.prompt;
    const hooks = params.options.hooks;
    const signal = new AbortController().signal;
    const base = { session_id: "s", transcript_path: "t", cwd: "c" };
    const call = async (name: string, input: Record<string, unknown>) => {
      const outs: any[] = [];
      for (const m of hooks[name] ?? []) for (const h of m.hooks) outs.push(await h({ ...base, hook_event_name: name, ...input }, "x", { signal }));
      return outs;
    };
    const subagent = async (agent: string, last = "done") => {
      await call("SubagentStart", { agent_id: agent, agent_type: agent });
      await call("SubagentStop", {
        stop_hook_active: false, agent_id: agent, agent_transcript_path: "p", agent_type: agent, last_assistant_message: last,
      });
    };
    const handTo = async (agent: string) => {
      const outs = await call("PreToolUse", { tool_name: "Agent", tool_input: { subagent_type: agent, description: "d", prompt: "p" }, tool_use_id: agent });
      return !outs.some((o) => o?.hookSpecificOutput?.permissionDecision === "deny");
    };
    yield { type: "assistant", message: { content: [] } };
    if (script.test !== false) {
      await call("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "1" });
    }
    if (script.quinnFirst) seen.quinnDenied = !(await handTo("quinn"));
    if (script.susie && (await handTo("susie"))) await subagent("susie");
    if (script.quinn && (await handTo("quinn"))) await subagent("quinn", "ok\nVERDICT: APPROVE");
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

test("target quinn in the worktree removes the village quinn from agents and is noted", async () => {
  const fx = fakeExec({
    worktreeAgents: { "quinn.md": "---\nname: quinn\ndescription: Target quinn\ntools:\n  - Read\n---\nTARGET QUINN PROMPT\n" },
  });
  const s = setup({ exec: fx.exec });
  const seen: Seen = {};
  const events = await collect({ ...s.opts, queryFn: fakeQuery({ quinn: true }, seen) });
  assert.deepEqual(Object.keys(seen.options.agents).sort(), ["sam", "susie", "theo"]);
  assert.ok(seen.options.settingSources.includes("project"));
  const started = events[0] as Extract<VillageEvent, { type: "started" }>;
  assert.equal(started.note, "overridden by target repo: quinn");
});

test("a target agent file without frontmatter is noted and the run continues", async () => {
  const fx = fakeExec({ worktreeAgents: { "README.md": "no frontmatter here" } });
  const s = setup({ exec: fx.exec });
  const events = await collect(s.opts);
  const started = events[0] as Extract<VillageEvent, { type: "started" }>;
  assert.match(started.note ?? "", /README\.md/);
  assert.equal(last(events).verdict, "pr_opened");
});

test("an unreadable target agent entry yields finished error with worktree set", async () => {
  const fx = fakeExec({ worktreeAgents: { "broken.md": null } });
  const s = setup({ exec: fx.exec });
  const events = await collect(s.opts);
  assert.equal(events.length, 1);
  assert.equal(last(events).verdict, "error");
  assert.ok(last(events).worktree, "worktree reported");
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
  assert.deepEqual(seen.options.allowedTools, ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "PowerShell", "Agent"]);
  assert.equal(seen.options.allowDangerouslySkipPermissions, undefined);
  // Subagents must run in the foreground, or Maya ends the session before Quinn reviews.
  assert.equal(seen.options.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  const view = fx.calls.find((c) => c.cmd === "gh" && c.args[0] === "issue")!;
  assert.equal(view.cwd, s.repo);
});

test("finished carries the worktree path once it was created (pr_opened, unreviewed, error)", async () => {
  const ok = await collect(setup().opts);
  const started = ok[0] as Extract<VillageEvent, { type: "started" }>;
  assert.equal(last(ok).verdict, "pr_opened");
  assert.equal(last(ok).worktree, started.worktree);

  const unrev = await collect(setup({ queryFn: fakeQuery({ quinn: false }) }).opts);
  assert.equal(last(unrev).verdict, "unreviewed");
  assert.equal(last(unrev).worktree, (unrev[0] as typeof started).worktree);

  const base = fakeExec();
  const exec: Exec = async (cmd, args, opts) =>
    cmd === "gh" && args[0] === "pr" ? { stdout: "", code: 1, stderr: "boom" } : base.exec(cmd, args, opts);
  const err = await collect(setup({ exec }).opts);
  assert.equal(last(err).verdict, "error");
  assert.equal(last(err).worktree, (err[0] as typeof started).worktree);
});

test("finished has no worktree when none was created", async () => {
  const nr = await collect(setup({ exec: fakeExec({ body: "## Outcome\nx\n" }).exec }).opts);
  assert.equal(last(nr).verdict, "not_ready");
  assert.equal(last(nr).worktree, undefined);
  const exists = await collect(setup({ exec: fakeExec({ branchExists: true }).exec }).opts);
  assert.equal(last(exists).worktree, undefined);
  assert.match(last(exists).note ?? "", /git worktree remove --force/);
});

test("R19: PR is pushed by explicit branch name", async () => {
  const s = setup();
  await collect(s.opts);
  const push = s.calls.find((c) => c.cmd === "git" && c.args[0] === "push")!;
  assert.deepEqual(push.args, ["push", "-u", "origin", "village/issue-5"]);
});

test("R19: HEAD on another branch or detached yields unreviewed with a note; nothing pushed", async () => {
  for (const head of ["main", "HEAD"]) {
    const fx = fakeExec({ head });
    const events = await collect(setup({ exec: fx.exec }).opts);
    const f = last(events);
    assert.equal(f.verdict, "unreviewed", head);
    assert.match(f.note ?? "", /village\/issue-5/);
    assert.equal(prCreates(fx.calls).length, 0);
    assert.ok(!fx.calls.some((c) => c.args[0] === "push"));
  }
});

test("every finished event carries logPath, the events.jsonl that holds it", async () => {
  const cases = [
    setup().opts, // pr_opened
    setup({ exec: fakeExec({ body: "## Outcome\nx\n" }).exec }).opts, // not_ready
    setup({ exec: fakeExec({ branchExists: true }).exec }).opts, // error
  ];
  for (const opts of cases) {
    const events = await collect(opts);
    const f = last(events);
    assert.ok(f.logPath, f.verdict);
    assert.equal(f.logPath, join(opts.runsDir, readdirSync(opts.runsDir)[0]!, "events.jsonl"));
    assert.ok(existsSync(f.logPath!));
    assert.deepEqual(logLines(opts.runsDir), events);
  }
});

test("empty or whitespace outcome yields not_ready naming the outcome, with no worktree", async () => {
  for (const body of ["## Outcome\n   \n\n## Acceptance criteria\n- [ ] works\n", "## Acceptance criteria\n- [ ] works\n"]) {
    const fx = fakeExec({ body });
    const events = await collect(setup({ exec: fx.exec }).opts);
    assert.equal(events.length, 1);
    assert.equal(last(events).verdict, "not_ready");
    assert.match(last(events).note ?? "", /outcome/i);
    assert.doesNotMatch(last(events).note ?? "", /acceptance criteria/i);
    assert.ok(!fx.calls.some((c) => c.args[0] === "worktree"));
  }
});

test("not_ready note names what is missing: criteria, or both", async () => {
  const noCrit = last(await collect(setup({ exec: fakeExec({ body: "## Outcome\nDo it.\n" }).exec }).opts));
  assert.match(noCrit.note ?? "", /acceptance criteria/i);
  assert.doesNotMatch(noCrit.note ?? "", /outcome/i);
  const both = last(await collect(setup({ exec: fakeExec({ body: "nothing" }).exec }).opts));
  assert.match(both.note ?? "", /outcome/i);
  assert.match(both.note ?? "", /acceptance criteria/i);
});

// ---- designer handoff (runner/design.ts) ----

const prBody = (calls: Call[]) => {
  const c = prCreates(calls)[0]!;
  return c.args[c.args.indexOf("--body") + 1]!;
};

test("design: a design-labeled issue is design work from the start and the prompt says so", async () => {
  const fx = fakeExec({ labels: ["bug", "UI"] });
  const s = setup({ exec: fx.exec });
  const seen: Seen = {};
  const events = await collect({ ...s.opts, queryFn: fakeQuery({ quinn: true, susie: true }, seen) });
  assert.equal(events[0]!.type, "started");
  assert.deepEqual(events[1], { type: "design_required", reason: 'issue labeled "UI"' });
  assert.match(seen.prompt!, /This issue is design work \(issue labeled "UI"\)\. Bring in susie for the design before Quinn reviews/);
  assert.equal(last(events).verdict, "pr_opened");
  assert.match(prBody(fx.calls), /Design: susie reviewed \(issue labeled "UI"\)/);
});

test("design: handing to Quinn before Susie is denied, and the run still finishes once Susie runs", async () => {
  const fx = fakeExec({ labels: ["design"] });
  const s = setup({ exec: fx.exec });
  const seen: Seen = {};
  const events = await collect({ ...s.opts, queryFn: fakeQuery({ quinnFirst: true, susie: true, quinn: true }, seen) });
  assert.equal(seen.quinnDenied, true);
  assert.ok(events.some((e) => e.type === "blocked" && e.tool === "Agent" && /quinn before susie/.test(e.reason)));
  const order = events.filter((e) => e.type === "agent_started").map((e) => (e as { agent: string }).agent);
  assert.deepEqual(order, ["susie", "quinn"]);
  assert.equal(last(events).verdict, "pr_opened");
});

test("design: a labeled issue whose run skips Susie (and so Quinn) opens no PR", async () => {
  const fx = fakeExec({ labels: ["design"] });
  const s = setup({ exec: fx.exec });
  const events = await collect({ ...s.opts, queryFn: fakeQuery({ quinn: true }) });
  assert.equal(last(events).verdict, "unreviewed");
  assert.ok(!events.some((e) => e.type === "agent_started" && (e as { agent: string }).agent === "quinn"), "quinn was never let in");
  assert.equal(prCreates(fx.calls).length, 0);
});

test("design: a committed UI file the hooks never saw still requires Susie before any PR", async () => {
  const fx = fakeExec({ changed: ["src/app.ts", "src/components/Header.tsx"] });
  const s = setup({ exec: fx.exec });
  const events = await collect(s.opts);
  const f = last(events);
  assert.equal(f.verdict, "unreviewed");
  assert.equal(f.note, "design work (changes UI file src/components/Header.tsx) but susie never reviewed it; no PR opened");
  assert.ok(events.some((e) => e.type === "design_required"));
  assert.equal(prCreates(fx.calls).length, 0);
  assert.ok(!fx.calls.some((c) => c.args[0] === "push"));
  assert.deepEqual(logLines(s.runsDir), events);
});

test("design: a committed UI file with Susie's review opens the PR and says so", async () => {
  const fx = fakeExec({ changed: ["src/styles/site.css"] });
  const s = setup({ exec: fx.exec, queryFn: fakeQuery({ quinn: true, susie: true }) });
  const events = await collect(s.opts);
  assert.equal(last(events).verdict, "pr_opened");
  assert.match(prBody(fx.calls), /Design: susie reviewed \(changes UI file src\/styles\/site\.css\)/);
});

test("design: non-UI work is unchanged: no design event, no design line, no Susie needed", async () => {
  const fx = fakeExec({ changed: ["src/triage.js", "test/triage.test.js", "src/Button.test.tsx"] });
  const s = setup({ exec: fx.exec });
  const seen: Seen = {};
  const events = await collect({ ...s.opts, queryFn: fakeQuery({ quinn: true }, seen) });
  assert.equal(last(events).verdict, "pr_opened");
  assert.ok(!events.some((e) => e.type === "design_required"));
  assert.doesNotMatch(prBody(fx.calls), /Design:/);
  assert.doesNotMatch(seen.prompt!, /design work/);
});

test("design: the diff is taken against the base branch the worktree came from", async () => {
  const fx = fakeExec();
  const s = setup({ exec: fx.exec });
  await collect(s.opts);
  const diff = fx.calls.find((c) => c.cmd === "git" && c.args[0] === "diff")!;
  assert.deepEqual(diff.args, ["diff", "--name-only", "origin/main...HEAD"]);
  assert.ok(diff.cwd?.includes(".village-worktrees"), "runs in the worktree");
});

test("design: a failing git diff fails closed (error, nothing pushed)", async () => {
  const fx = fakeExec({ diffFails: true });
  const s = setup({ exec: fx.exec });
  const events = await collect(s.opts);
  const f = last(events);
  assert.equal(f.verdict, "error");
  assert.match(f.note!, /git diff failed: bad revision/);
  assert.ok(!fx.calls.some((c) => c.args[0] === "push"));
});

test("design: --no-review skips the design gate like the review gate", async () => {
  const fx = fakeExec({ labels: ["design"], changed: ["src/App.vue"] });
  const s = setup({ exec: fx.exec, requireReview: false, queryFn: fakeQuery({}) });
  const seen: Seen = {};
  const events = await collect({ ...s.opts, queryFn: fakeQuery({ quinnFirst: true }, seen) });
  assert.equal(seen.quinnDenied, false);
  assert.equal(last(events).verdict, "pr_opened");
  assert.doesNotMatch(prBody(fx.calls), /Design:/);
});
