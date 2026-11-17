import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import {
  checkBash,
  checkPath,
  createHooks,
  createReviewState,
  TEST_COMMAND,
} from "../runner/guards.ts";
import type { ReviewState } from "../runner/guards.ts";
import type { VillageEvent } from "../runner/events.ts";

const DENIED_BASH = [
  "gh pr merge 5",
  "cd x && gh pr merge --squash",
  "git push --force origin main",
  "git push -f",
  "git push --force-with-lease",
  "git push origin main",
  "git push origin HEAD:master",
  "git push origin +village/issue-5",
  "git push origin village/issue-5 --force",
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "rm -rf /*",
  "rm -rf C:\\",
  "Remove-Item -Recurse -Force C:\\",
  "Remove-Item -Recurse -Force $env:USERPROFILE",
  "echo hi; gh pr merge 5",
  "npm test | gh pr merge 5",
  "echo hi\ngh pr merge 5",
  "GH PR MERGE 5",
  "git reset --hard origin/main",
  "gh -R o/r pr merge 5",
  "gh pr 'merge' 5",
  'gh pr "merge" 5',
  "g''h pr merge 5",
  "echo $(gh pr merge 5)",
  'echo "$(gh pr merge 5)"',
  "echo `gh pr merge 5`",
  "sudo gh pr merge 5",
  "gh api -X PUT repos/o/r/pulls/5/merge",
  // full paths to gh/git
  '"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 5',
  '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 5',
  "C:\\tools\\gh.exe pr merge 5",
  '"C:\\Program Files\\Git\\cmd\\git.exe" push --force origin x',
  "gh.exe pr merge 5",
  "GH.EXE PR MERGE 5",
  "/usr/bin/gh pr merge 5",
  // flags between gh pr and merge
  "gh pr -R o/r merge 5",
  "gh pr --repo o/r merge 5",
  "gh  pr   -R x merge",
  "gh --repo o/r pr merge 5",
  // wrappers
  'bash -c "gh pr merge 5"',
  "sh -c 'cd x && gh pr merge 5'",
  'powershell -Command "gh pr merge 5"',
  'powershell -NoProfile -Command "git push --force"',
  'pwsh -c "Remove-Item -Recurse -Force C:\\"',
  'cmd /c "gh pr merge 5"',
  'bash -c "bash -c \\"gh pr merge 5\\""',
  "bash -c 'rm -rf /'",
  "powershell -enc ZwBoAA==",
  "find . -exec gh pr merge {} +",
  "python -c \"import os; os.system('gh pr merge 5')\"",
  // R17: any push, PR creation/ready, merge endpoints
  "git push origin village/issue-5",
  "git push -u origin village/issue-5",
  "git push",
  "git -C /x push origin HEAD",
  '"C:\\Program Files\\Git\\cmd\\git.exe" push origin village/issue-5',
  "/usr/bin/git push origin x",
  'bash -c "git push origin village/issue-5"',
  'powershell -Command "git push"',
  "cd x && git push",
  "gh pr create --title x --body y",
  'gh pr create --title "Fix merge"',
  "gh pr -R o/r create",
  "gh.exe pr create",
  '"C:\\Program Files\\GitHub CLI\\gh.exe" pr create',
  'bash -c "gh pr create"',
  "gh pr ready 5",
  "gh pr -R o/r ready 5",
  "gh api repos/o/r/merges -f base=main -f head=x",
  "gh api -X PUT repos/o/r/pulls/5/merge",
  "gh api repos/o/r/pulls/5/merge -X PUT",
  'bash -c "gh api repos/o/r/merges -f base=main"',
];

for (const cmd of DENIED_BASH) {
  test(`checkBash denies: ${JSON.stringify(cmd)}`, () => {
    assert.equal(checkBash(cmd).allowed, false);
  });
}

const ALLOWED_BASH = [
  "gh pr list --state merged",
  "gh pr -R o/r view 5",
  '"C:\\Program Files\\GitHub CLI\\gh.exe" pr view 5',
  "npm test",
  "git status",
  'git commit -m "merge fix"',
  "git commit -m 'gh pr merge is blocked'",
  "gh pr view 5",
  "git clean -fdx",
  "rm -rf node_modules",
  "rm -rf ./build",
  "Remove-Item -Recurse -Force .\\dist",
  'bash -c "npm test && git status"',
  'powershell -Command "Get-ChildItem"',
  "git merge main",
  'git commit -m "push fix"',
  "git commit -m push",
  "git log --oneline",
  "gh issue view 5",
  "gh pr checks 5",
  "gh api repos/o/r/pulls/5",
  "gh api repos/o/r/issues",
];

for (const cmd of ALLOWED_BASH) {
  test(`checkBash allows: ${JSON.stringify(cmd)}`, () => {
    assert.deepEqual(checkBash(cmd), { allowed: true });
  });
}

test("checkBash gives a reason", () => {
  const r = checkBash("gh pr merge 5");
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.match(r.reason, /merg/i);
});

const TEST_COMMANDS = [
  "npm test", "npm run test", "pnpm test", "pnpm run test", "yarn test", "yarn run test",
  "pytest -q", "python -m pytest", "python3 -m pytest -x", "uv run pytest", "poetry run pytest tests/",
  "npx jest", "npx vitest run", "npx mocha", "pnpm exec vitest", "pnpm exec jest", "bunx jest", "bunx vitest",
  "jest", "vitest run", "mocha test/",
  "go test ./...", "cargo test", "node --test", "dotnet test", "mvn test", "./gradlew test", "gradle test",
  "make test", "bun test", "deno test", "rspec", "bundle exec rspec", "phpunit", "vendor/bin/phpunit",
];

for (const c of TEST_COMMANDS) {
  test(`TEST_COMMAND accepts ${JSON.stringify(c)}, also as a hook-detected test run`, async () => {
    assert.ok(TEST_COMMAND.test(c), c);
    const { state, run } = setup();
    await run("PreToolUse", { tool_name: "Bash", tool_input: { command: `cd x && ${c}` } });
    assert.equal(state.ranTests, true, c);
  });
}

test("TEST_COMMAND rejects non-test commands", () => {
  for (const c of ["npm install", "git status", "echo hello", "npm run build", "make build", "dotnet build", "cargo build"]) {
    assert.ok(!TEST_COMMAND.test(c), c);
  }
});

test("Stop block message lists the accepted test commands", async () => {
  const { run } = setup();
  const out = await run("Stop", { stop_hook_active: false });
  const reason = String(out.reason);
  for (const form of ["npm/pnpm/yarn", "pytest", "python -m pytest", "go test", "cargo test", "vitest", "dotnet test", "mvn test", "make test"]) {
    assert.ok(reason.includes(form), form);
  }
});

const root = resolve("work", "wt");

test("checkPath allows relative paths inside root", () => {
  assert.deepEqual(checkPath(root, "src/a.ts"), { allowed: true });
  assert.deepEqual(checkPath(root, "src\\a.ts"), { allowed: true });
});

test("checkPath allows an absolute path inside root, denies outside", () => {
  assert.deepEqual(checkPath(root, join(root, "src", "a.ts")), { allowed: true });
  assert.equal(checkPath(root, resolve("work", "wt-evil", "a.ts")).allowed, false);
  assert.equal(checkPath(root, resolve("work", "other", "a.ts")).allowed, false);
  assert.equal(checkPath(root, root).allowed, false);
});

if (process.platform === "win32") {
  test("checkPath compares case-insensitively on win32", () => {
    assert.deepEqual(checkPath(root, join(root, "SRC", "a.ts").toUpperCase()), { allowed: true });
  });
}

for (const bad of [
  "../x",
  "..\\x",
  "C:\\Windows\\win.ini",
  "\\\\host\\share\\x",
  "//host/share/x",
  "src/../../x",
  "notes.txt/../../x",
  "",
  "a\0b",
  "/etc/passwd",
]) {
  test(`checkPath denies: ${JSON.stringify(bad)}`, () => {
    assert.equal(checkPath(root, bad).allowed, false);
  });
}

test("checkPath denies non-string input", () => {
  assert.equal(checkPath(root, undefined as unknown as string).allowed, false);
});

// ---- hooks ----

function setup(opts: { requireReview?: boolean; head?: () => string } = {}) {
  const events: VillageEvent[] = [];
  const state: ReviewState = createReviewState();
  let head = "sha1";
  const hooks = createHooks({
    worktree: root,
    state,
    getHeadSha: async () => (opts.head ? opts.head() : head),
    emit: (e) => events.push(e),
    requireReview: opts.requireReview ?? true,
  })!;
  const run = (event: "PreToolUse" | "SubagentStart" | "SubagentStop" | "Stop", input: Record<string, unknown>) =>
    hooks[event]![0]!.hooks[0]!(
      { session_id: "s", transcript_path: "t", cwd: root, hook_event_name: event, ...input } as never,
      undefined,
      { signal: new AbortController().signal },
    ) as Promise<Record<string, unknown>>;
  return { events, state, run, setHead: (s: string) => (head = s) };
}

test("denied Bash call returns deny output and emits exactly one blocked event", async () => {
  const { events, run } = setup();
  const out = await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "gh pr merge 5" } });
  assert.deepEqual(out.hookSpecificOutput, {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: (out.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason,
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "blocked");
});

test("allowed call emits tool_call (default agent maya, summary capped at 160) and not blocked", async () => {
  const { events, run } = setup();
  const long = "x".repeat(500);
  const out = await run("PreToolUse", { tool_name: "Write", tool_input: { file_path: "src/a.ts", content: long } });
  assert.deepEqual(out, {});
  assert.equal(events.length, 1);
  const e = events[0]!;
  assert.ok(e.type === "tool_call");
  assert.equal(e.agent, "maya");
  assert.equal(e.tool, "Write");
  assert.equal(e.summary.length, 160);
  const out2 = await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "git status" }, agent_type: "quinn" });
  assert.deepEqual(out2, {});
  const e2 = events[1]!;
  assert.ok(e2.type === "tool_call" && e2.agent === "quinn");
});

test("Write outside the worktree is denied; missing path is denied", async () => {
  const { events, run } = setup();
  const a = await run("PreToolUse", { tool_name: "Write", tool_input: { file_path: "../x" } });
  const b = await run("PreToolUse", { tool_name: "Edit", tool_input: {} });
  const c = await run("PreToolUse", { tool_name: "NotebookEdit", tool_input: { notebook_path: "C:\\Windows\\x.ipynb" } });
  for (const o of [a, b, c]) assert.ok(o.hookSpecificOutput);
  assert.deepEqual(events.map((e) => e.type), ["blocked", "blocked", "blocked"]);
});

test("Read and other tools pass through", async () => {
  const { run } = setup();
  assert.deepEqual(await run("PreToolUse", { tool_name: "Read", tool_input: { file_path: "../x" } }), {});
});

test("ranTests is set by a test command, not by echoing one, and not by a denied one", async () => {
  const { state, run } = setup();
  await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "echo npm test" } });
  assert.equal(state.ranTests, false);
  await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test && gh pr merge 5" } });
  assert.equal(state.ranTests, false);
  await run("PreToolUse", { tool_name: "Bash", tool_input: { command: "cd x && npm test" } });
  assert.equal(state.ranTests, true);
});

test("SubagentStart / SubagentStop emit agent events", async () => {
  const { events, run } = setup();
  await run("SubagentStart", { agent_id: "1", agent_type: "maya" });
  await run("SubagentStop", { agent_id: "1", agent_type: "maya", stop_hook_active: false });
  assert.deepEqual(events, [
    { type: "agent_started", agent: "maya" },
    { type: "agent_finished", agent: "maya" },
  ]);
});

test("SubagentStop quinn REJECT sets verdict and sha", async () => {
  const { state, run } = setup();
  await run("SubagentStop", { agent_id: "1", agent_type: "quinn", last_assistant_message: "no.\nVERDICT: REJECT" });
  assert.equal(state.quinnVerdict, "REJECT");
  assert.equal(state.quinnReviewedSha, "sha1");
});

test("SubagentStop quinn uses the LAST verdict; none leaves null", async () => {
  const { state, run } = setup();
  await run("SubagentStop", { agent_type: "quinn", last_assistant_message: "VERDICT: REJECT then VERDICT: APPROVE" });
  assert.equal(state.quinnVerdict, "APPROVE");
  await run("SubagentStop", { agent_type: "quinn", last_assistant_message: "looks fine" });
  assert.equal(state.quinnVerdict, null);
});

test("SubagentStop of a non-quinn agent leaves review state unchanged", async () => {
  const { state, run } = setup();
  await run("SubagentStop", { agent_type: "maya", last_assistant_message: "VERDICT: APPROVE" });
  assert.deepEqual(state, createReviewState());
});

async function approved(s: ReturnType<typeof setup>) {
  s.state.ranTests = true;
  await s.run("SubagentStop", { agent_type: "quinn", last_assistant_message: "VERDICT: APPROVE" });
}

test("Stop blocks when tests were not run", async () => {
  const s = setup();
  await approved(s);
  s.state.ranTests = false;
  const out = await s.run("Stop", { stop_hook_active: false });
  assert.equal(out.decision, "block");
  assert.match(String(out.reason), /test/i);
});

test("Stop blocks without a Quinn approval", async () => {
  const s = setup();
  s.state.ranTests = true;
  const out = await s.run("Stop", { stop_hook_active: false });
  assert.equal(out.decision, "block");
  assert.match(String(out.reason), /quinn/i);
});

test("Stop blocks when code changed after approval", async () => {
  const s = setup();
  await approved(s);
  s.setHead("sha2");
  const out = await s.run("Stop", { stop_hook_active: false });
  assert.equal(out.decision, "block");
  assert.match(String(out.reason), /changed/i);
});

test("Stop allows with tests run and approval on current HEAD", async () => {
  const s = setup();
  await approved(s);
  assert.deepEqual(await s.run("Stop", { stop_hook_active: false }), {});
});

test("Stop allows when stop_hook_active even if unsatisfied", async () => {
  const s = setup();
  assert.deepEqual(await s.run("Stop", { stop_hook_active: true }), {});
});

test("Stop always allows when requireReview is false", async () => {
  const s = setup({ requireReview: false });
  assert.deepEqual(await s.run("Stop", { stop_hook_active: false }), {});
});
