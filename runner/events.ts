export type Verdict = "pr_opened" | "not_ready" | "unreviewed" | "capped" | "error";

export type VillageEvent =
  | { type: "started"; issue: number; repo: string; branch: string; worktree: string; note?: string }
  | { type: "agent_started"; agent: string }
  | { type: "tool_call"; agent: string; tool: string; summary: string }
  | { type: "blocked"; tool: string; reason: string }
  | { type: "agent_finished"; agent: string }
  // An agent ran the project's tests. passed is false when the shell reported a non-zero exit.
  | { type: "test_result"; agent: string; command: string; passed: boolean }
  // Quinn finished a review. verdict is null when the review ended without a VERDICT line.
  | { type: "review"; verdict: "APPROVE" | "REJECT" | null; sha: string | null }
  // The run became design work, so Susie must review it before Quinn (see runner/design.ts). Once per run.
  | { type: "design_required"; reason: string }
  // The runner's own acceptance check (--verify), run after the agents stop, at the final commit.
  | { type: "verified"; command: string; passed: boolean; code: number; ms: number; sha: string }
  | { type: "cost"; usd: number }
  | {
      type: "finished";
      verdict: Verdict;
      pr?: string;
      costUsd: number;
      turns: number;
      note?: string;
      worktree?: string;
      logPath?: string;
      durationMs?: number;
    };

export function isTerminal(e: VillageEvent): e is Extract<VillageEvent, { type: "finished" }> {
  return e.type === "finished";
}
