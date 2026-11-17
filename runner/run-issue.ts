import { join } from "node:path";
import type { query } from "@anthropic-ai/claude-agent-sdk";
import type { VillageEvent } from "./events.ts";
import { assertRepo, createWorktree, headSha } from "./git.ts";
import type { Exec } from "./git.ts";
import { getIssue, openDraftPr } from "./github.ts";
import { createHooks, createReviewState } from "./guards.ts";
import { loadVillage, mergeTargetAgents } from "./load-village.ts";
import { createRunLog } from "./runlog.ts";

export const MAYA_MODEL = "claude-sonnet-5-5";

export type RunOptions = {
  issue: number;
  repo: string; // target repo path
  villageDir: string;
  maxTurns: number;
  maxUsd: number;
  requireReview: boolean;
  exec: Exec;
  queryFn: typeof query; // injected; real SDK query in production
  runsDir: string;
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function* runIssue(opts: RunOptions): AsyncGenerator<VillageEvent, void> {
  const stamp = new Date().toISOString().replace(/:/g, "-");
  const log = createRunLog(join(opts.runsDir, `${opts.issue}-${stamp}`));
  const progress: { costUsd: number; worktree?: string } = { costUsd: 0 };
  const withWorktree = (e: VillageEvent): VillageEvent =>
    e.type === "finished"
      ? { ...e, ...(progress.worktree ? { worktree: progress.worktree } : {}), logPath: log.path }
      : e;
  let finished = false;
  try {
    for await (const raw of core(opts, progress)) {
      const e = withWorktree(raw);
      if (e.type === "finished") finished = true;
      log.write(e);
      yield e;
    }
    if (!finished) throw new Error("run ended without a result");
  } catch (err) {
    if (finished) return;
    const e = withWorktree({
      type: "finished",
      verdict: "error",
      costUsd: progress.costUsd,
      turns: 0,
      note: message(err),
    });
    log.write(e);
    yield e;
  }
}

async function* core(opts: RunOptions, progress: { costUsd: number; worktree?: string }): AsyncGenerator<VillageEvent, void> {
  const { exec, repo } = opts;
  await assertRepo(exec, repo);
  const issue = await getIssue(exec, repo, opts.issue);
  const missing = [
    ...(issue.outcome.trim() === "" ? ["an Outcome section"] : []),
    ...(issue.criteria.length === 0 ? ["acceptance criteria"] : []),
  ];
  if (missing.length > 0) {
    yield {
      type: "finished",
      verdict: "not_ready",
      costUsd: 0,
      turns: 0,
      note: `issue is missing ${missing.join(" and ")}`,
    };
    return;
  }

  const village = loadVillage(opts.villageDir);
  const { branch, worktree } = await createWorktree(exec, repo, opts.issue);
  progress.worktree = worktree;
  // The target's own agents live in the worktree (its checked-out default branch), not the working copy.
  const { agents, overridden, notes } = mergeTargetAgents(village.agents, join(worktree, ".claude", "agents"));
  const startNotes = [...(overridden.length ? [`overridden by target repo: ${overridden.join(", ")}`] : []), ...notes];
  yield {
    type: "started",
    issue: opts.issue,
    repo,
    branch,
    worktree,
    ...(startNotes.length ? { note: startNotes.join("; ") } : {}),
  };

  const pending: VillageEvent[] = [];
  const state = createReviewState();
  const hooks = createHooks({
    worktree,
    state,
    getHeadSha: () => headSha(exec, worktree),
    emit: (e) => pending.push(e),
    requireReview: opts.requireReview,
  });
  const drain = () => pending.splice(0, pending.length);

  const prompt =
    `Work GitHub issue #${issue.number} in this repository: ${issue.title}\n\n${issue.body}\n\n` +
    "Commit your work on the current branch. Do not push, open a pull request, or merge: the runner does that after Quinn approves.";

  const stream = opts.queryFn({
    prompt,
    options: {
      systemPrompt: { type: "preset", preset: "claude_code", append: village.maya },
      agents,
      cwd: worktree,
      settingSources: ["project"],
      model: MAYA_MODEL,
      maxTurns: opts.maxTurns,
      maxBudgetUsd: opts.maxUsd,
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "PowerShell", "Agent"],
      hooks,
      persistSession: false,
    },
  });

  for await (const msg of stream) {
    yield* drain();
    if (msg.type !== "result") continue;

    progress.costUsd = msg.total_cost_usd;
    yield { type: "cost", usd: msg.total_cost_usd };
    const base = { costUsd: msg.total_cost_usd, turns: msg.num_turns };

    if (msg.subtype === "error_max_turns" || msg.subtype === "error_max_budget_usd") {
      yield { type: "finished", verdict: "capped", ...base, note: msg.subtype };
      return;
    }
    if (msg.subtype !== "success" || msg.is_error) {
      yield { type: "finished", verdict: "error", ...base, note: msg.subtype === "success" ? `error result: ${msg.result}` : msg.subtype };
      return;
    }

    const status = await exec("git", ["status", "--porcelain"], { cwd: worktree });
    if (status.code !== 0) throw new Error(`git status failed: ${status.stderr || status.stdout}`.trim());
    if (status.stdout.trim() !== "") {
      yield { type: "finished", verdict: "unreviewed", ...base, note: "worktree has uncommitted changes; no PR opened" };
      return;
    }

    const onBranch = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktree });
    if (onBranch.code !== 0) throw new Error(`git rev-parse failed: ${onBranch.stderr || onBranch.stdout}`.trim());
    const current = onBranch.stdout.trim();
    if (current !== branch) {
      yield { type: "finished", verdict: "unreviewed", ...base, note: `worktree HEAD is ${current === "HEAD" ? "detached" : `on ${current}`}, not ${branch}; no PR opened` };
      return;
    }

    const sha = await headSha(exec, worktree);
    const reviewed =
      !opts.requireReview ||
      (state.ranTests && state.quinnVerdict === "APPROVE" && state.quinnReviewedSha === sha);
    if (!reviewed) {
      yield { type: "finished", verdict: "unreviewed", ...base, note: "tests or Quinn's approval of the current commit missing" };
      return;
    }
    const verified = opts.requireReview
      ? `Verified: tests run, Quinn approved ${sha.slice(0, 7)}`
      : "Verified: review not required for this run";
    const url = await openDraftPr(exec, worktree, issue, `${msg.result}\n\n${verified}`, branch);
    yield { type: "finished", verdict: "pr_opened", pr: url, ...base };
    return;
  }
  yield* drain();
  throw new Error("query ended without a result message");
}
