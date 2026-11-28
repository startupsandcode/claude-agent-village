import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("assertRepo requires a remote named origin", async () => {
  const { exec } = fake((c) => (c.args[0] === "remote" ? { stdout: "upstream\nfork\n" } : { stdout: "true\n" }));
  await assert.rejects(assertRepo(exec, "/r"), /origin/);
});

test("assertRepo passes with repo and remote", async () => {
  const { exec } = fake((c) => (c.args[0] === "remote" ? { stdout: "origin\n" } : { stdout: "true\n" }));
  await assertRepo(exec, "/r");
});

const resolveOrigin = (c: Call) =>
  c.args[0] === "rev-parse" ? { code: 1 } : c.args[0] === "symbolic-ref" ? { stdout: "origin/main\n" } : {};

test("createWorktree fetches, resolves origin's default branch and branches from it", async () => {
  const { exec, calls } = fake(resolveOrigin);
  const r = await createWorktree(exec, "/work/proj", 12);
  assert.equal(r.branch, "village/issue-12");
  assert.ok(r.worktree.split(String.fromCharCode(92)).join("/").endsWith("/work/.village-worktrees/proj-issue-12"));
  const fetchIdx = calls.findIndex((c) => c.args[0] === "fetch");
  const refIdx = calls.findIndex((c) => c.args[0] === "symbolic-ref");
  const addIdx = calls.findIndex((c) => c.args[0] === "worktree");
  assert.ok(fetchIdx >= 0 && refIdx > fetchIdx && addIdx > refIdx);
  assert.deepEqual(calls[fetchIdx].args, ["fetch", "origin"]);
  assert.equal(calls[fetchIdx].cwd, "/work/proj");
  assert.deepEqual(calls[refIdx].args, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  const add = calls[addIdx];
  assert.deepEqual(add.args.slice(0, 4), ["worktree", "add", "-b", "village/issue-12"]);
  assert.equal(add.args[4], r.worktree);
  assert.equal(add.args[5], "origin/main");
  assert.equal(add.cwd, "/work/proj");
  assert.equal(r.base, "origin/main", "the base is returned so the runner can diff the branch against it");
});

test("createWorktree throws a clear error when fetch fails and adds nothing", async () => {
  const { exec, calls } = fake((c) => (c.args[0] === "fetch" ? { code: 128, stderr: "no network" } : resolveOrigin(c)));
  await assert.rejects(createWorktree(exec, "/work/proj", 12), /could not resolve origin's default branch.*no network/);
  assert.equal(calls.filter((c) => c.args[0] === "worktree").length, 0);
});

test("createWorktree falls back to the remote's HEAD when origin/HEAD is not set locally", async () => {
  const { exec, calls } = fake((c) =>
    c.args[0] === "symbolic-ref"
      ? { code: 128, stderr: "ref refs/remotes/origin/HEAD is not a symbolic ref" }
      : c.args[0] === "ls-remote"
        ? { stdout: "ref: refs/heads/main\tHEAD\n607a5e8e23a70c2c4d149527ff567ec0e935c171\tHEAD\n" }
        : resolveOrigin(c),
  );
  await createWorktree(exec, "/work/proj", 12);
  assert.deepEqual(calls.find((c) => c.args[0] === "ls-remote")!.args, ["ls-remote", "--symref", "origin", "HEAD"]);
  assert.equal(calls.find((c) => c.args[0] === "worktree")!.args[5], "origin/main");
  assert.equal(calls.filter((c) => c.args.includes("set-head")).length, 0);
});

test("createWorktree throws a clear error when origin/HEAD cannot be resolved and adds nothing", async () => {
  const { exec, calls } = fake((c) => (c.args[0] === "symbolic-ref" ? { code: 128, stderr: "ref refs/remotes/origin/HEAD is not a symbolic ref" } : resolveOrigin(c)));
  await assert.rejects(createWorktree(exec, "/work/proj", 12), /could not resolve origin's default branch/);
  assert.equal(calls.filter((c) => c.args[0] === "worktree").length, 0);
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

test("already-exists error names the branch and gives the recovery commands", async () => {
  const { exec } = fake((c) => (c.args[0] === "rev-parse" ? { code: 0 } : {}));
  await assert.rejects(createWorktree(exec, "/work/proj", 12), (e: Error) => {
    assert.match(e.message, /^branch village\/issue-12 already exists/);
    assert.ok(!/directory/.test(e.message.split(". To rerun")[0]));
    assert.match(e.message, /git worktree remove --force \S*proj-issue-12/);
    assert.match(e.message, /git branch -D village\/issue-12/);
    assert.match(e.message, /in \/work\/proj/);
    return true;
  });
});

test("already-exists error names the directory when only the directory exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "village-git-"));
  const repo = join(root, "proj");
  mkdirSync(repo);
  const dir = join(root, ".village-worktrees", "proj-issue-12");
  mkdirSync(dir, { recursive: true });
  const { exec, calls } = fake((c) => (c.args[0] === "rev-parse" ? { code: 1 } : {}));
  await assert.rejects(createWorktree(exec, repo, 12), (e: Error) => {
    assert.ok(e.message.startsWith(`directory ${dir} already exists`), e.message);
    assert.ok(e.message.includes(`git worktree remove --force ${dir}`));
    assert.ok(e.message.includes("git branch -D village/issue-12"));
    return true;
  });
  assert.equal(calls.filter((c) => c.args[0] === "worktree").length, 0);
});

test("errors fall back to stdout when stderr is an empty string", async () => {
  const { exec } = fake((c) => (c.args[0] === "rev-parse" ? { code: 1, stdout: "from stdout", stderr: "" } : {}));
  await assert.rejects(headSha(exec, "/wt"), /from stdout/);
});
