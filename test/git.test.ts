import { test } from "node:test";
import assert from "node:assert/strict";
import { assertRepo, createWorktree, headSha } from "../runner/git.ts";
import type { Exec } from "../runner/git.ts";

type Call = { cmd: string; args: string[]; cwd?: string };

function fake(handler: (call: Call) => { stdout?: string; code?: number; stderr?: string }) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    const call = { cmd, args, cwd: opts?.cwd };
    calls.push(call);
    const r = handler(call);
    return { stdout: r.stdout ?? "", code: r.code ?? 0, stderr: r.stderr };
  };
  return { exec, calls };
}

test("assertRepo throws 'not a git repository'", async () => {
  const { exec } = fake(() => ({ code: 128 }));
  await assert.rejects(assertRepo(exec, "/r"), /not a git repository/);
});

test("assertRepo throws 'no remote'", async () => {
  const { exec } = fake((c) => (c.args[0] === "remote" ? { stdout: "\n" } : { stdout: "true\n" }));
  await assert.rejects(assertRepo(exec, "/r"), /no remote/);
});

test("assertRepo passes with repo and remote", async () => {
  const { exec } = fake((c) => (c.args[0] === "remote" ? { stdout: "origin\n" } : { stdout: "true\n" }));
  await assertRepo(exec, "/r");
});

test("createWorktree runs git worktree add -b", async () => {
  const { exec, calls } = fake((c) => (c.args[0] === "rev-parse" ? { code: 1 } : {}));
  const r = await createWorktree(exec, "/work/proj", 12);
  assert.equal(r.branch, "village/issue-12");
  assert.ok(r.worktree.split(String.fromCharCode(92)).join("/").endsWith("/work/.village-worktrees/proj-issue-12"));
  const add = calls.find((c) => c.args[0] === "worktree");
  assert.ok(add);
  assert.deepEqual(add.args.slice(0, 4), ["worktree", "add", "-b", "village/issue-12"]);
  assert.equal(add.args[4], r.worktree);
  assert.equal(add.cwd, "/work/proj");
});

test("createWorktree throws when branch exists and never adds", async () => {
  const { exec, calls } = fake(() => ({ code: 0 }));
  await assert.rejects(createWorktree(exec, "/work/proj", 12), /branch village\/issue-12 already exists/);
  assert.equal(calls.filter((c) => c.args[0] === "worktree").length, 0);
});

test("headSha returns trimmed sha in the worktree", async () => {
  const { exec, calls } = fake(() => ({ stdout: "abc123\n" }));
  assert.equal(await headSha(exec, "/wt"), "abc123");
  assert.equal(calls[0].cwd, "/wt");
});
