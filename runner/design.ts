/**
 * The designer handoff: a deterministic rule for when Susie (the product designer) must take part.
 *
 * Before this, Susie ran only when Maya read an issue as UI work, which is guidance in Markdown and not
 * guaranteed. Now the runner decides, from facts it can check, that a run is design work:
 *  - the issue carries a design label (DESIGN_LABELS), known before any model call;
 *  - an agent writes a UI file through a file tool (PostToolUse on Write, Edit, MultiEdit, NotebookEdit);
 *  - the committed diff against the base branch touches a UI file (checked when Maya tries to stop, and
 *    again by the runner before any PR, which also catches files written from the shell).
 *
 * Once a run is design work, three checks hold the handoff in place:
 *  - PreToolUse on the Agent tool denies handing work to Quinn until Susie has run;
 *  - the Stop hook blocks Maya from finishing until Susie has run;
 *  - the runner opens no PR (verdict `unreviewed`) unless Susie has run.
 *
 * Like the other guards, this applies only when review is required (it is off with --no-review).
 * It is not a security boundary: see guards.ts.
 */
import { basename, relative } from "node:path";
import type { HookCallback, HookCallbackMatcher, HookEvent, Options } from "@anthropic-ai/claude-agent-sdk";
import type { VillageEvent } from "./events.ts";
import type { Exec } from "./git.ts";

export const DESIGNER = "susie";
export const REVIEWER = "quinn";

// Issue labels that mark a run as design work, matched case-insensitively.
export const DESIGN_LABELS = ["design", "ui", "ux", "ui/ux"];

// File types that hold UI: components, markup and styles.
const UI_EXTENSIONS = new Set([
  ".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html", ".htm",
  ".css", ".scss", ".sass", ".less", ".styl",
]);

// Tests for UI code are not UI changes on their own.
const TEST_FILE = /(?:^|\/)(?:__tests__|__snapshots__)\/|\.(?:test|spec|stories)\.[^/]+$/i;

/** True when a path (relative or absolute, either separator) is a UI file that is not a test. */
export function isUiPath(path: string): boolean {
  if (typeof path !== "string" || path === "") return false;
  const p = path.replace(/\\/g, "/");
  if (TEST_FILE.test(p)) return false;
  const name = basename(p);
  const dot = name.lastIndexOf(".");
  return dot > 0 && UI_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/** The first label that marks the issue as design work, or null. */
export function designLabel(labels: string[]): string | null {
  const wanted = new Set(DESIGN_LABELS);
  return labels.find((l) => wanted.has(l.trim().toLowerCase())) ?? null;
}

export type DesignState = {
  // Why this run is design work (shown in events and the PR), or null while it is not.
  required: string | null;
  // Susie finished at least once during this run.
  susieRan: boolean;
};

export function createDesignState(labels: string[] = []): DesignState {
  const label = designLabel(labels);
  return { required: label ? `issue labeled "${label}"` : null, susieRan: false };
}

/** Mark the run as design work. Emits design_required the first time only. */
export function requireDesign(state: DesignState, reason: string, emit: (e: VillageEvent) => void): void {
  if (state.required !== null) return;
  state.required = reason;
  emit({ type: "design_required", reason });
}

/** Mark the run as design work if any of these files is a UI file. */
export function noteChangedFiles(state: DesignState, files: string[], emit: (e: VillageEvent) => void): void {
  const ui = files.find(isUiPath);
  if (ui) requireDesign(state, `changes UI file ${ui}`, emit);
}

/** The design handoff still owes Susie's input. */
export function designPending(state: DesignState): boolean {
  return state.required !== null && !state.susieRan;
}

/** Files committed on the branch since it left `base` (the base branch it was created from). */
export async function changedFiles(exec: Exec, worktree: string, base: string): Promise<string[]> {
  const r = await exec("git", ["diff", "--name-only", `${base}...HEAD`], { cwd: worktree });
  if (r.code !== 0) throw new Error(`git diff failed: ${r.stderr || r.stdout}`.trim());
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

const FILE_TOOLS: Record<string, string[]> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path", "file_path"],
};

// Claude Code's subagent tool. "Task" is its older name.
const AGENT_TOOLS = new Set(["Agent", "Task"]);

export function pendingReason(state: DesignState): string {
  return `this is design work (${state.required}), so ${DESIGNER} must review it before ${REVIEWER} does. Hand the design to ${DESIGNER} with the Agent tool first`;
}

export function createDesignHooks(deps: {
  worktree: string;
  state: DesignState;
  emit: (e: VillageEvent) => void;
  requireReview: boolean;
  // The branch's committed files; when it throws, the Stop hook skips the diff (the runner checks again).
  getChangedFiles?: () => Promise<string[]>;
}): Pick<Options, "hooks">["hooks"] {
  const { worktree, state, emit, requireReview, getChangedFiles } = deps;

  // The handoff itself: no review by Quinn while the design handoff is pending.
  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    if (!requireReview || !AGENT_TOOLS.has(input.tool_name)) return {};
    const target = (input.tool_input as { subagent_type?: unknown } | undefined)?.subagent_type;
    if (target !== REVIEWER || !designPending(state)) return {};
    const reason = pendingReason(state);
    emit({ type: "blocked", tool: input.tool_name, reason: `${REVIEWER} before ${DESIGNER} on design work` });
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Not yet: ${reason}.`,
      },
    };
  };

  // A UI file written through a file tool makes the run design work (PostToolUse: only writes that happened).
  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PostToolUse") return {};
    const keys = FILE_TOOLS[input.tool_name];
    if (!keys) return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const key = keys.find((k) => typeof toolInput[k] === "string");
    if (!key) return {};
    const path = toolInput[key] as string;
    if (!isUiPath(path)) return {};
    const rel = relative(worktree, path).replace(/\\/g, "/");
    requireDesign(state, `changes UI file ${rel.startsWith("..") ? path : rel}`, emit);
    return {};
  };

  const subagentStop: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStop") return {};
    if (input.agent_type === DESIGNER) state.susieRan = true;
    return {};
  };

  const stop: HookCallback = async (input) => {
    if (input.hook_event_name !== "Stop") return {};
    if (!requireReview || input.stop_hook_active) return {};
    if (getChangedFiles && state.required === null) {
      try {
        noteChangedFiles(state, await getChangedFiles(), emit);
      } catch {
        // Unknown here; the runner's own check before any PR fails closed.
      }
    }
    if (!designPending(state)) return {};
    return { decision: "block", reason: `Not ready to finish: ${pendingReason(state)}.` };
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    SubagentStop: [{ hooks: [subagentStop] }],
    Stop: [{ hooks: [stop] }],
  };
}

type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>;

/** Combine hook sets: each event runs every set's matchers, in order. */
export function mergeHooks(...sets: (Hooks | undefined)[]): Hooks {
  const out: Hooks = {};
  for (const set of sets) {
    for (const [event, matchers] of Object.entries(set ?? {}) as [HookEvent, HookCallbackMatcher[]][]) {
      out[event] = [...(out[event] ?? []), ...matchers];
    }
  }
  return out;
}
