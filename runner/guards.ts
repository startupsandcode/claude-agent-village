/**
 * Guards and the review gate for the village agents.
 *
 * NOT A SECURITY BOUNDARY. These are in-process string checks on commands and paths the model
 * proposes. A determined caller can bypass them (shell variables, aliases, encoded payloads, scripts
 * written to disk and then run, symlinks, races between check and use, anything else running as
 * your user). They catch the obvious and the accidental. Real isolation needs a sandbox or
 * container with no credentials for anything you cannot afford to lose.
 *
 * Three things live here:
 *  - checkBash / checkPath: pure checks used by the PreToolUse hook.
 *  - TEST_COMMAND: recognises a test run so the review gate can require one.
 *  - createHooks: the SDK `hooks` option: guards, event emission and the Stop review gate.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";
import type { VillageEvent } from "./events.ts";

export type CheckResult = { allowed: true } | { allowed: false; reason: string };

const ALLOW: CheckResult = { allowed: true };
const deny = (reason: string): CheckResult => ({ allowed: false, reason });

// ---------------------------------------------------------------------------------------------
// Bash / PowerShell command check
// ---------------------------------------------------------------------------------------------

const MAX_DEPTH = 6;

// Split on && || ; | & ( ) backtick and newlines, but not inside quotes.
function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (quote === '"' && c === "\\" && i + 1 < command.length) {
        cur += command[++i]!;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
    } else if ("&|;()`\n\r".includes(c)) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// Bodies of $(...) and `...` anywhere in the text (they run even inside double quotes).
function substitutions(command: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < command.length; i++) {
    if (command[i] === "$" && command[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      for (; j < command.length && depth > 0; j++) {
        if (command[j] === "(") depth++;
        else if (command[j] === ")") depth--;
      }
      bodies.push(command.slice(i + 2, depth === 0 ? j - 1 : j));
    }
  }
  for (const m of command.matchAll(/`([^`]*)`/g)) bodies.push(m[1]!);
  return bodies;
}

// Quoted values of message-style flags on commit/tag/PR-comment commands are prose, not commands.
const PROSE_COMMAND = /^\s*(?:\S*[\\/])?(?:git(?:\.exe)?\b.*\b(?:commit|tag|stash)\b|gh(?:\.exe)?\b.*\b(?:pr|issue)\s+(?:create|comment|edit|review|close)\b)/i;
const PROSE_FLAG_VALUE = /(?:^|\s)(?:-m|--message|--body|-b|--title|-t|--notes)(?:=|\s+)(?:"(?:[^"\\]|\\.)*"|'[^']*')/gi;

function normalize(segment: string, winPaths = false): string {
  let s = segment;
  if (PROSE_COMMAND.test(s)) s = s.replace(PROSE_FLAG_VALUE, " ");
  // Drop quote characters, cmd carets and shell backslash-escapes so gh pr "merge" / g''h / m\erge
  // still read as the command. Quoted CONTENT is kept (python -c "os.system('gh pr merge')").
  s = s.replace(/["'^]/g, "");
  // winPaths: backslash is a path separator (C:\tools\gh.exe); otherwise it is a shell escape (m\erge).
  // checkSegment tests both readings.
  s = winPaths ? s.replace(/\\/g, "/") : s.replace(/\\(?=[a-z])/gi, "");
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

const WRAPPER =
  /\b(?:bash|sh|zsh|dash|ksh|pwsh|powershell|cmd)(?:\.exe)?\s+(?:-\S+\s+)*?(?:-c|-command|\/c|\/k)(?=\s|"|'|$)|\b(?:eval|iex|invoke-expression)\b/i;
const ENCODED = /\b(?:pwsh|powershell)(?:\.exe)?\b.*\s-e(?:nc(?:odedcommand)?)?\s/i;

const DANGEROUS_TARGET =
  /^(?:\/|~|\$\{?home\}?|\$env:(?:home|userprofile)|%(?:userprofile|homedrive|homepath)%|[a-z]:|\.\.)(?:[\\/]\*?)*$|^\/\*$/i;

function isRecursiveDelete(tokens: string[]): boolean {
  return tokens.some(
    (t) =>
      /^-[a-z]*r[a-z]*$/i.test(t) || // rm -rf, -r, -R
      t === "--recursive" ||
      /^-r(?:e(?:c(?:u(?:r(?:se?)?)?)?)?)?$/i.test(t) || // -Recurse and abbreviations
      /^\/s$/i.test(t), // rd /s, del /s
  );
}

function checkSegment(raw: string, depth: number): CheckResult {
  const wrapper = WRAPPER.exec(raw);
  if (ENCODED.test(raw)) return deny("encoded PowerShell commands cannot be inspected");
  if (wrapper) {
    const payload = raw.slice(wrapper.index + wrapper[0].length).replace(/["']/g, " ");
    const inner = checkBash(payload, depth + 1);
    if (!inner.allowed) return inner;
  }

  for (const winPaths of [false, true]) {
    const r = checkRules(normalize(raw, winPaths));
    if (!r.allowed) return r;
  }
  return ALLOW;
}

// gh flags that take a separate value; skipped when looking for the subcommand words.
const GH_VALUE_FLAGS = new Set(["-r", "--repo", "-h", "--hostname"]);

// First two non-flag words after each gh / git token, flags (and their values) skipped.
function subcommands(tokens: string[], tool: RegExp, valueFlags: Set<string>): string[][] {
  const found: string[][] = [];
  for (let g = 0; g < tokens.length; g++) {
    if (!tool.test(tokens[g]!)) continue;
    const words: string[] = [];
    for (let i = g + 1; i < tokens.length && words.length < 2; i++) {
      const t = tokens[i]!;
      if (t.startsWith("-")) {
        if (valueFlags.has(t)) i++;
      } else words.push(t);
    }
    found.push(words);
  }
  return found;
}

const GH_TOOL = /^(?:.*\/)?gh(?:\.exe)?$/;
const GIT_TOOL = /^(?:.*\/)?git(?:\.exe)?$/;
const GIT_VALUE_FLAGS = new Set(["-c", "--git-dir", "--work-tree", "--namespace"]);

function ghDenied(tokens: string[]): string | null {
  for (const [a, b] of subcommands(tokens, GH_TOOL, GH_VALUE_FLAGS)) {
    if (a === "pr" && b === "merge") return "merging pull requests is not allowed";
    if (a === "pr" && b === "create") return "opening pull requests is the runner's job; gh pr create is not allowed";
    if (a === "pr" && b === "ready") return "marking pull requests ready is not allowed";
  }
  return null;
}

function checkRules(s: string): CheckResult {
  const tokens = s.split(" ");

  const gh = ghDenied(tokens);
  if (gh) return deny(gh);
  if (/\bgh(?:\.exe)?\b.*\bpr\s+merge\b/.test(s)) return deny("merging pull requests is not allowed");
  if (/\bgh(?:\.exe)?\b.*\bpr\s+(?:create|ready)\b/.test(s)) return deny("gh pr create/ready is not allowed");
  if (/\bgh(?:\.exe)?\b.*\bapi\b.*(?:\/merges?\b|mergepullrequest|enablepullrequestautomerge)/.test(s)) {
    return deny("merging through the API is not allowed");
  }

  const pushes = subcommands(tokens, GIT_TOOL, GIT_VALUE_FLAGS).some(([a]) => a === "push");
  if (pushes) {
    const push = tokens.indexOf("push");
    for (const t of tokens.slice(push + 1)) {
      if (t === "--force" || t === "--force-with-lease" || t.startsWith("--force-with-lease=") || t === "--force-if-includes" || t === "--mirror") {
        return deny("force pushes are not allowed");
      }
      if (/^-[a-z]+$/.test(t) && t.includes("f")) return deny("force pushes are not allowed");
      if (t.startsWith("+")) return deny("force pushes are not allowed");
      if (!t.startsWith("-")) {
        const ref = t.replace(/^\+/, "").split(":").pop()!.replace(/^refs\/heads\//, "");
        if (ref === "main" || ref === "master") return deny("pushing to main/master is not allowed");
      }
    }
    return deny("git push is not allowed: the runner pushes the issue branch itself");
  }

  if (/\bgit(?:\.exe)?\b.*\breset\b.*--hard\s+(?:origin|upstream)\b/.test(s)) {
    return deny("git reset --hard origin is not allowed");
  }

  const cmdIdx = tokens.findIndex((t) => /^(?:.*[\\/])?(?:rm|rmdir|rd|del|erase|remove-item|ri)(?:\.exe)?$/.test(t));
  if (cmdIdx >= 0) {
    const args = tokens.slice(cmdIdx + 1);
    if (isRecursiveDelete(args) && args.some((t) => !t.startsWith("-") && DANGEROUS_TARGET.test(t))) {
      return deny("recursive delete of a root or home directory is not allowed");
    }
  }
  return ALLOW;
}

export function checkBash(command: string, depth = 0): CheckResult {
  if (typeof command !== "string") return deny("malformed command");
  if (depth > MAX_DEPTH) return deny("command wrappers nested too deeply to inspect");
  for (const body of substitutions(command)) {
    const r = checkBash(body, depth + 1);
    if (!r.allowed) return r;
  }
  for (const segment of splitSegments(command)) {
    const r = checkSegment(segment, depth);
    if (!r.allowed) return r;
  }
  return ALLOW;
}

// Recognises a test run. Unanchored (use `testRan` below for the per-segment, anchored check).
export const TEST_COMMAND =
  /\b(?:(?:npm|pnpm|yarn)(?:\s+run)?\s+test|pytest|go\s+test|cargo\s+test|node\s+--test)\b/i;
const TEST_AT_START = new RegExp(`^\\s*(?:${TEST_COMMAND.source})`, "i");

// True when some segment STARTS with a test command, so `echo npm test` does not count.
function testRan(command: string): boolean {
  return splitSegments(command).some((seg) => TEST_AT_START.test(normalize(seg)));
}

// ---------------------------------------------------------------------------------------------
// Path jail
// ---------------------------------------------------------------------------------------------

// Containment via path.relative, not string-prefix matching ("worktree-evil" starts with "worktree").
// Absolute paths are fine when they resolve inside root.
export function checkPath(root: string, requested: string): CheckResult {
  if (typeof requested !== "string" || requested.length === 0 || requested.includes("\0")) {
    return deny("empty or malformed path");
  }
  if (process.platform !== "win32" && /^[a-zA-Z]:/.test(requested)) {
    return deny(`path escapes the worktree: ${requested}`);
  }
  // Treat backslash as a separator on every platform so ..\x cannot hide on POSIX.
  const normalized = requested.replace(/\\/g, "/");
  const base = resolve(root);
  const rel = relative(base, resolve(base, normalized));
  if (rel === "" || /^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel)) {
    return deny(`path escapes the worktree: ${requested}`);
  }
  return ALLOW;
}

// ---------------------------------------------------------------------------------------------
// Review gate and hooks
// ---------------------------------------------------------------------------------------------

export type ReviewState = {
  ranTests: boolean;
  quinnVerdict: "APPROVE" | "REJECT" | null;
  quinnReviewedSha: string | null;
};

export function createReviewState(): ReviewState {
  return { ranTests: false, quinnVerdict: null, quinnReviewedSha: null };
}

const PATH_TOOLS: Record<string, string[]> = {
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path", "file_path"],
};

function lastVerdict(text: string | undefined): "APPROVE" | "REJECT" | null {
  let verdict: "APPROVE" | "REJECT" | null = null;
  for (const m of (text ?? "").matchAll(/VERDICT:\s*(APPROVE|REJECT)\b/g)) {
    verdict = m[1] as "APPROVE" | "REJECT";
  }
  return verdict;
}

export function createHooks(deps: {
  worktree: string;
  state: ReviewState;
  getHeadSha: () => Promise<string>;
  emit: (e: VillageEvent) => void;
  requireReview: boolean;
}): Pick<Options, "hooks">["hooks"] {
  const { worktree, state, getHeadSha, emit, requireReview } = deps;

  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const tool = input.tool_name;
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    let verdict: CheckResult = ALLOW;

    if (tool === "Bash" || tool === "PowerShell") {
      const command = toolInput.command;
      verdict = typeof command === "string" ? checkBash(command) : deny("malformed command");
      if (verdict.allowed && typeof command === "string" && testRan(command)) state.ranTests = true;
    } else if (tool in PATH_TOOLS) {
      const key = PATH_TOOLS[tool]!.find((k) => toolInput[k] !== undefined);
      verdict = checkPath(worktree, key ? (toolInput[key] as string) : "");
    }

    if (!verdict.allowed) {
      emit({ type: "blocked", tool, reason: verdict.reason });
      return {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: verdict.reason,
        },
      };
    }
    emit({
      type: "tool_call",
      agent: input.agent_type ?? "maya",
      tool,
      summary: (JSON.stringify(input.tool_input) ?? "").slice(0, 160),
    });
    return {};
  };

  const subagentStart: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStart") return {};
    emit({ type: "agent_started", agent: input.agent_type });
    return {};
  };

  const subagentStop: HookCallback = async (input) => {
    if (input.hook_event_name !== "SubagentStop") return {};
    emit({ type: "agent_finished", agent: input.agent_type });
    if (input.agent_type === "quinn") {
      state.quinnVerdict = lastVerdict(input.last_assistant_message);
      try {
        state.quinnReviewedSha = await getHeadSha();
      } catch {
        state.quinnReviewedSha = null;
      }
    }
    return {};
  };

  const stop: HookCallback = async (input) => {
    if (input.hook_event_name !== "Stop") return {};
    if (!requireReview || input.stop_hook_active) return {};
    const missing: string[] = [];
    if (!state.ranTests) missing.push("the tests have not been run (run the project's test command)");
    if (state.quinnVerdict !== "APPROVE") {
      missing.push("Quinn has not approved (ask quinn to review and end with VERDICT: APPROVE)");
    } else if (state.quinnReviewedSha === null || state.quinnReviewedSha !== (await getHeadSha())) {
      missing.push("code changed after Quinn's approval (have quinn review the current commit again)");
    }
    if (missing.length === 0) return {};
    return { decision: "block", reason: `Not ready to finish: ${missing.join("; ")}.` };
  };

  return {
    PreToolUse: [{ hooks: [preToolUse] }],
    SubagentStart: [{ hooks: [subagentStart] }],
    SubagentStop: [{ hooks: [subagentStop] }],
    Stop: [{ hooks: [stop] }],
  };
}
