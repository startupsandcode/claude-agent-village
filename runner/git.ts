import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; code: number; stderr?: string }>;

// execFile (no shell); never rejects on a non-zero exit.
export const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      { cwd: opts?.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        let code = 0;
        let err = stderr;
        if (error) {
          const c = (error as { code?: unknown }).code;
          code = typeof c === "number" ? c : 1;
          if (typeof c !== "number" && !err) err = error.message;
        }
        resolvePromise({ stdout, code, stderr: err });
      },
    );
  });

export async function assertRepo(exec: Exec, repo: string): Promise<void> {
  const inside = await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo });
  if (inside.code !== 0) throw new Error(`${repo} is not a git repository`);
  const remotes = await exec("git", ["remote"], { cwd: repo });
  const names = remotes.stdout.split(/\s+/).filter(Boolean);
  if (remotes.code !== 0 || !names.includes("origin")) {
    throw new Error(`${repo} has no remote named origin`);
  }
}

export async function createWorktree(
  exec: Exec,
  repo: string,
  n: number,
): Promise<{ branch: string; worktree: string }> {
  const branch = `village/issue-${n}`;
  const root = resolve(repo);
  const worktree = join(root, "..", ".village-worktrees", `${basename(root)}-issue-${n}`);
  const exists = await exec("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: repo,
  });
  const dirExists = existsSync(worktree);
  if (exists.code === 0 || dirExists) {
    const what = [
      ...(exists.code === 0 ? [`branch ${branch}`] : []),
      ...(dirExists ? [`directory ${worktree}`] : []),
    ].join(" and ");
    const q = (p: string) => (/\s/.test(p) ? `"${p}"` : p);
    throw new Error(
      `${what} already exists. To rerun, clean up in ${repo}: ` +
        `git worktree remove --force ${q(worktree)} && git branch -D ${branch}`,
    );
  }
  const fetch = await exec("git", ["fetch", "origin"], { cwd: repo });
  const head =
    fetch.code === 0
      ? await exec("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo })
      : fetch;
  let base = head.code === 0 ? head.stdout.trim() : "";
  if (fetch.code === 0 && base === "") {
    // No local origin/HEAD (clones made with `git init` + `remote add` lack it). Ask the remote directly
    // instead of changing the target repo's refs. Output: "ref: refs/heads/main\tHEAD".
    const remote = await exec("git", ["ls-remote", "--symref", "origin", "HEAD"], { cwd: repo });
    const m = remote.code === 0 ? /^ref:\s*refs\/heads\/(\S+)\s+HEAD/m.exec(remote.stdout) : null;
    if (m) base = `origin/${m[1]}`;
  }
  if (base === "") {
    throw new Error(
      `could not resolve origin's default branch (${(head.stderr || head.stdout || "no output").trim()}). ` +
        `Run 'git fetch origin' and 'git remote set-head origin -a' in ${repo}, then retry.`,
    );
  }
  const add = await exec("git", ["worktree", "add", "-b", branch, worktree, base], { cwd: repo });
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`.trim());
  }
  return { branch, worktree };
}

export async function headSha(exec: Exec, worktree: string): Promise<string> {
  const r = await exec("git", ["rev-parse", "HEAD"], { cwd: worktree });
  if (r.code !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr || r.stdout}`.trim());
  return r.stdout.trim();
}
