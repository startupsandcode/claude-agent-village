import { realExec } from "./git.ts";
import type { Exec } from "./git.ts";

export { realExec };
export type { Exec };

export type Issue = {
  number: number;
  title: string;
  body: string;
  outcome: string;
  criteria: string[];
};

function section(body: string, heading: string): string[] {
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break;
    out.push(l);
  }
  return out;
}

export function parseIssue(number: number, title: string, body: string): Issue {
  const outcome = section(body, "Outcome").join("\n").trim();
  const criteria = section(body, "Acceptance criteria")
    .map((l) => /^\s*- \[[ xX]\]\s+(.*\S)\s*$/.exec(l)?.[1])
    .filter((c): c is string => Boolean(c));
  return { number, title, body, outcome, criteria };
}

export async function getIssue(exec: Exec, repo: string, n: number): Promise<Issue> {
  const r = await exec("gh", ["issue", "view", String(n), "--repo", repo, "--json", "title,body"]);
  if (r.code !== 0) throw new Error(`gh issue view failed: ${r.stderr ?? r.stdout}`.trim());
  const data = JSON.parse(r.stdout) as { title: string; body: string };
  return parseIssue(n, data.title, data.body ?? "");
}

export async function openDraftPr(
  exec: Exec,
  worktree: string,
  issue: Issue,
  body: string,
): Promise<string> {
  const br = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree });
  if (br.code !== 0) throw new Error(`git rev-parse failed: ${br.stderr ?? br.stdout}`.trim());
  const branch = br.stdout.trim();
  const push = await exec("git", ["push", "-u", "origin", branch], { cwd: worktree });
  if (push.code !== 0) throw new Error(`git push failed: ${push.stderr ?? push.stdout}`.trim());
  const create = await exec(
    "gh",
    [
      "pr", "create", "--draft",
      "--title", `Village: #${issue.number} ${issue.title}`,
      "--body", `${body}\n\nCloses #${issue.number}`,
    ],
    { cwd: worktree },
  );
  if (create.code !== 0) {
    throw new Error(`gh pr create failed: ${create.stderr ?? create.stdout}`.trim());
  }
  return create.stdout.trim();
}
