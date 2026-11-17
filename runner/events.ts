export type Verdict = "pr_opened" | "not_ready" | "unreviewed" | "capped" | "error";

export type VillageEvent =
  | { type: "started"; issue: number; repo: string; branch: string; worktree: string; note?: string }
  | { type: "agent_started"; agent: string }
  | { type: "tool_call"; agent: string; tool: string; summary: string }
  | { type: "blocked"; tool: string; reason: string }
  | { type: "agent_finished"; agent: string }
  | { type: "cost"; usd: number }
  | { type: "finished"; verdict: Verdict; pr?: string; costUsd: number; turns: number; note?: string };

export function isTerminal(e: VillageEvent): e is Extract<VillageEvent, { type: "finished" }> {
  return e.type === "finished";
}
