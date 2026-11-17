# Claude Agent Village Core Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A runner that takes a GitHub issue in any target repo and, through the Claude Agent SDK, has Maya coordinate Sam, Theo, Quinn and Susie to a reviewed draft PR, under guardrails.

**Architecture:** Agent definitions and Maya's rules live as Markdown in `village/`. `runner/` parses them into the SDK `agents` option, creates a git worktree in the target repo, runs `query()` with hooks as guardrails and review gates, and exposes the run as an async generator of typed events. The CLI is a thin printer over that generator.

**Tech Stack:** TypeScript on Node 24+ (run `.ts` directly), `@anthropic-ai/claude-agent-sdk` ^0.3.326, `node --test`, `tsc`, `gh` and `git` CLIs.

**Spec:** `docs/superpowers/specs/2026-11-17-claude-agent-village-core-design.md`

## Global Constraints

- New repo at `C:\Users\JMann\Projects\mine\claude-agent-village`; do not modify `claude-platform-learning`.
- Windows 11 primary. Node 24 or newer, `.ts` files run directly, no build step. `tsconfig` mirrors claude-platform-learning (`strict`, `noEmit`, `allowImportingTsExtensions`, `module: nodenext`).
- Dependencies: `@anthropic-ai/claude-agent-sdk` `^0.3.326`; dev: `typescript` `^7.0.2`, `@types/node` `^26.6.6`. No other runtime dependencies (frontmatter is parsed by hand).
- Models: Maya, Sam, Quinn on `sonnet` (main model `claude-sonnet-5-5`); Theo, Susie on `haiku`. Set in frontmatter and one constant `MAYA_MODEL`.
- Defaults: 40 turns, $2.00 per run (`--max-turns`, `--max-usd` override).
- Draft PRs only. Agents never merge. Run logs are gitignored under `runs/`.
- If a target repo's `.claude/agents/<name>.md` has the same name as a village agent, the target's wins; the runner logs the override.
- Every commit message ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Guards are in-process, not a security boundary. Say so in `README.md` and the header of `runner/guards.ts`.

## Review Focus

Inputs the spec implies but its main tests would not hit, most likely first. Each has a test in the owning task.

1. Issue has no acceptance criteria: stop before creating a worktree, report why (Task 3).
2. Re-running the same issue when `village/issue-<n>` already exists: do not clobber it; fail with a clear message (Task 3).
3. Bash phrasings that dodge a naive guard: `gh pr merge` inside `&&` chains or PowerShell, `git push --force`, `Remove-Item -Recurse`, `rm -rf` on `/` or `~`, writes with `..` or another drive (Task 4).
4. Run hits the turn or budget cap mid-work: verdict `capped`, no PR, partial log kept (Task 5).
5. Quinn rejects, or never reviews, or the code changes after Quinn approved: no PR (Task 4 and Task 5).

---

## File Structure

```
package.json  tsconfig.json  .gitignore  .env.example  README.md
village/maya.md
village/agents/{sam,theo,quinn,susie}.md
runner/events.ts        # VillageEvent, Verdict types
runner/load-village.ts  # parse village/*.md, merge target overrides -> SDK agents
runner/github.ts        # gh wrappers: getIssue, parseIssue, openDraftPr
runner/git.ts           # worktree/branch create, HEAD sha, changed-files
runner/guards.ts        # PreToolUse guard + Stop review gate (pure logic + hook factories)
runner/runlog.ts        # JSONL run log writer
runner/run-issue.ts     # runIssue() async generator (the core)
runner/cli.ts           # `village work <n> [--repo p]`
.claude/                # thin, interactive use inside the village repo
.github/ISSUE_TEMPLATE/work-item.md
test/*.test.ts
```

External commands (`gh`, `git`) go through one injectable `Exec` type so tests use fakes.

---

### Task 1: Scaffold and event types

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore` (`node_modules/`, `.env`, `runs/`), `.env.example`, `runner/events.ts`, `test/events.test.ts`

**Interfaces:**
- Produces, in `runner/events.ts`:
  ```ts
  export type Verdict = "pr_opened" | "not_ready" | "unreviewed" | "capped" | "error";
  export type VillageEvent =
    | { type: "started"; issue: number; repo: string; branch: string; worktree: string }
    | { type: "agent_started"; agent: string }
    | { type: "tool_call"; agent: string; tool: string; summary: string }
    | { type: "blocked"; tool: string; reason: string }
    | { type: "agent_finished"; agent: string }
    | { type: "cost"; usd: number }
    | { type: "finished"; verdict: Verdict; pr?: string; costUsd: number; turns: number; note?: string };
  export function isTerminal(e: VillageEvent): e is Extract<VillageEvent, { type: "finished" }>;
  ```
- `package.json` scripts: `test` = `node --test "test/*.test.ts"`, `typecheck` = `tsc -p .`, `village` = `node --env-file=.env runner/cli.ts`.

- [ ] **Step 1: Write the failing test** `test/events.test.ts`: `isTerminal({type:"finished",verdict:"pr_opened",costUsd:0.1,turns:3})` is `true`; `isTerminal({type:"cost",usd:1})` is `false`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL, module not found.
- [ ] **Step 3: Implement** `events.ts` as above; add the scaffold files; run `npm install`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS, no type errors.
- [ ] **Step 5: Commit** `feat: scaffold repo and event types`.

---

### Task 2: Village definitions and loader

**Files:**
- Create: `village/maya.md`, `village/agents/{sam,theo,quinn,susie}.md`, `runner/load-village.ts`, `test/load-village.test.ts`

**Interfaces:**
- Consumes: SDK `AgentDefinition` type.
- Produces, in `runner/load-village.ts`:
  ```ts
  export function parseAgentFile(name: string, text: string): AgentDefinition;
  export function loadVillage(villageDir: string): { maya: string; agents: Record<string, AgentDefinition> };
  export function mergeTargetAgents(
    village: Record<string, AgentDefinition>,
    targetAgentsDir: string,
  ): { agents: Record<string, AgentDefinition>; overridden: string[] };
  ```
- Agent file format: frontmatter between `---` lines with `description:` (required), `tools:` (comma-separated, optional), `model:` (optional); body is `prompt`. A file with no `description` throws.

- [ ] **Step 1: Write failing tests** in `test/load-village.test.ts`:
  - `parseAgentFile("quinn", ...)` returns `description`, `tools: ["Read","Glob","Grep"]`, `model: "sonnet"` and a non-empty `prompt`; missing description throws.
  - `loadVillage("village")` returns `maya` text and exactly the keys `sam, theo, quinn, susie`; `theo`, `quinn`, `susie` have no `Write`/`Edit` in `tools`; `sam` has no `tools` restriction beyond a list including `Edit` and `Bash`.
  - `mergeTargetAgents` with a temp dir containing `quinn.md` returns that quinn's prompt and `overridden: ["quinn"]`; with a missing dir returns the village agents unchanged and `overridden: []`; a target-only agent (e.g. `docs.md`) is added, not counted as overridden.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Write the content.** `maya.md` ports the Maya section and Working agreement of `AGENTS.md` from `Projects/mine/agent-village`, replacing Codex references with Claude and the specialist agent names, and keeping: outcome and acceptance criteria first, one issue per branch and PR, evidence before claims, delegate substantive code to Sam then require Quinn's review, never merge. Add: "Quinn ends every review with exactly `VERDICT: APPROVE` or `VERDICT: REJECT`." The four agent files port the `developer_instructions` from `.codex/agents/*.toml` verbatim, with frontmatter: sam (`tools: Read, Glob, Grep, Edit, Write, Bash`, sonnet), theo (`Read, Glob, Grep`, haiku), quinn (`Read, Glob, Grep, Bash`, sonnet, plus the VERDICT line instruction), susie (`Read, Glob, Grep`, haiku).
- [ ] **Step 4: Implement** the three functions; hand-rolled frontmatter parser.
- [ ] **Step 5: Run** `npm test`. Expected: PASS.
- [ ] **Step 6: Commit** `feat: village agent definitions and loader`.

---

### Task 3: GitHub and git wrappers

**Files:**
- Create: `runner/github.ts`, `runner/git.ts`, `test/github.test.ts`, `test/git.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Exec = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; code: number }>;
  export const realExec: Exec;                       // child_process.execFile wrapper (no shell)

  // github.ts
  export type Issue = { number: number; title: string; body: string; outcome: string; criteria: string[] };
  export function parseIssue(number: number, title: string, body: string): Issue;
  export function getIssue(exec: Exec, repo: string, n: number): Promise<Issue>;  // gh issue view --json
  export function openDraftPr(exec: Exec, worktree: string, issue: Issue, body: string): Promise<string>; // returns PR URL

  // git.ts
  export function assertRepo(exec: Exec, repo: string): Promise<void>;           // is a git repo with a remote
  export function createWorktree(exec: Exec, repo: string, n: number): Promise<{ branch: string; worktree: string }>;
  export function headSha(exec: Exec, worktree: string): Promise<string>;
  ```
- `parseIssue` fills `outcome` from the `## Outcome` section and `criteria` from `- [ ]` lines under `## Acceptance criteria` (the work-item template). `criteria` is empty when none.
- Worktree path: `<repo>/../.village-worktrees/<repoName>-issue-<n>`; branch `village/issue-<n>`.

- [ ] **Step 1: Write failing tests**:
  - `parseIssue` on a template-shaped body returns the outcome and 2 criteria; a body with no criteria returns `criteria: []`.
  - `getIssue` with a fake exec returning `gh` JSON returns a parsed `Issue`; a non-zero code throws with the stderr text.
  - `assertRepo` throws "not a git repository" and "no remote" for the matching fakes.
  - `createWorktree` calls `git worktree add -b village/issue-12 <path>`; when the fake reports the branch exists, it throws `branch village/issue-12 already exists` and never runs a second add (Review Focus 2).
  - `openDraftPr` passes `--draft`, a title containing the issue number, and a body containing `Closes #<n>`; returns the URL from stdout.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** the signatures above; arguments passed as arrays, never joined into a shell string.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: github and git wrappers`.

---

### Task 4: Guards and the review gate

**Files:**
- Create: `runner/guards.ts`, `test/guards.test.ts`

**Interfaces:**
- Consumes: `VillageEvent` (Task 1), `headSha` shape (Task 3), SDK `HookCallback`.
- Produces:
  ```ts
  export function checkBash(command: string): { allowed: true } | { allowed: false; reason: string };
  export function checkPath(root: string, requested: string): { allowed: true } | { allowed: false; reason: string };
  export const TEST_COMMAND: RegExp; // npm|pnpm|yarn [run] test, pytest, go test, cargo test, node --test

  export type ReviewState = {
    ranTests: boolean;
    quinnVerdict: "APPROVE" | "REJECT" | null;
    quinnReviewedSha: string | null;
  };
  export function createReviewState(): ReviewState;
  export function createHooks(deps: {
    worktree: string;
    state: ReviewState;
    getHeadSha: () => Promise<string>;
    emit: (e: VillageEvent) => void;
    requireReview: boolean;
  }): Pick<Options, "hooks">["hooks"];
  ```
- Behavior of `createHooks`:
  - `PreToolUse`: for `Bash` calls run `checkBash`, record `ranTests` when the command matches `TEST_COMMAND`; for `Write`/`Edit`/`NotebookEdit` run `checkPath` on `file_path`. A denial returns `{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason}}` and calls `emit({type:"blocked",...})`.
  - `SubagentStop` where `agent_type === "quinn"`: parse `last_assistant_message` for the last `VERDICT: APPROVE|REJECT`; set `quinnVerdict` and `quinnReviewedSha = await getHeadSha()`.
  - `Stop`: if `requireReview` and not (`ranTests` and `quinnVerdict === "APPROVE"` and `quinnReviewedSha === await getHeadSha()`), return `{decision:"block", reason}` saying what is missing, unless `stop_hook_active` is already true, in which case return `{}` (allow stop; the runner reports `unreviewed`).

- [ ] **Step 1: Write failing tests** in `test/guards.test.ts`:
  - `checkBash` denies: `gh pr merge 5`, `cd x && gh pr merge --squash`, `git push --force origin main`, `git push -f`, `rm -rf /`, `rm -rf ~`, `Remove-Item -Recurse -Force C:\`, `gh pr merge` in PowerShell `;` chains. Allows: `npm test`, `git status`, `git commit -m "merge fix"`, `gh pr view 5`. (Review Focus 3)
  - `checkPath(root, ...)` allows `src/a.ts`; denies `../x`, `..\\x`, `C:\\Windows\\win.ini`, `\\\\host\\share\\x`, `src/../../x`, an empty string, and a path with `\0`. Containment uses `path.relative`, not string prefix.
  - `createHooks` Stop hook with `ranTests:false` returns `decision: "block"` and mentions tests; with approve on an older SHA than current HEAD blocks (code changed after approval); with approval on current HEAD and tests run returns `{}`; with `stop_hook_active: true` returns `{}` even when unsatisfied; with `requireReview:false` always `{}`. (Review Focus 5)
  - SubagentStop with `agent_type:"quinn"` and `"...VERDICT: REJECT"` sets `quinnVerdict: "REJECT"`; a non-quinn agent leaves state unchanged.
  - A denied Bash call emits one `blocked` event.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.** Split commands on `&&`, `||`, `;`, `|` and newlines and test each segment, case-insensitive, so chaining cannot hide a denied command. `checkPath` is ported from `resolveInWorkspace` in `claude-platform-learning/messages/04-tool-allowlist.ts`.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: guards and review gate`.

---

### Task 5: The runner core

**Files:**
- Create: `runner/runlog.ts`, `runner/run-issue.ts`, `test/run-issue.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1 to 4, SDK `query`.
- Produces:
  ```ts
  // runlog.ts
  export function createRunLog(dir: string): { write(e: unknown): void; path: string };  // JSON lines, one object per line

  // run-issue.ts
  export type RunOptions = {
    issue: number;
    repo: string;                 // target repo path
    villageDir: string;
    maxTurns: number;
    maxUsd: number;
    requireReview: boolean;
    exec: Exec;
    queryFn: typeof query;        // injected; real SDK query in production
    runsDir: string;
  };
  export function runIssue(opts: RunOptions): AsyncGenerator<VillageEvent, void>;
  ```
- `runIssue` order: `assertRepo` → `getIssue` → if `criteria` is empty yield `finished{verdict:"not_ready"}` and stop (no worktree) → `createWorktree` → yield `started` → build options (`systemPrompt: {type:"preset",preset:"claude_code",append: maya}`, `agents` from `loadVillage` + `mergeTargetAgents(<repo>/.claude/agents)`, `cwd: worktree`, `settingSources:["project"]`, `model: MAYA_MODEL`, `maxTurns`, `maxBudgetUsd`, `hooks` from `createHooks`, `disallowedTools` none beyond hooks) → iterate `queryFn` messages mapping them to events (assistant `tool_use` → `tool_call`; subagent start/stop hooks → `agent_started`/`agent_finished`; `result` → `cost`) and draining hook-emitted events before each message → on result: `error_max_turns`/`error_max_budget_usd` → verdict `capped`; other errors → `error`; success with a satisfied `ReviewState` → `openDraftPr` and verdict `pr_opened`; success without → `unreviewed`. Every event is written to the run log. Log which agents were overridden as a `note` on `started`.

- [ ] **Step 1: Write failing tests** using a fake `queryFn` (an async generator of SDK-shaped messages) and a fake `exec`:
  - Issue with no criteria yields exactly one `finished{not_ready}` and never calls `createWorktree` (Review Focus 1).
  - A happy path with the fake emitting a Bash `npm test`, a quinn `VERDICT: APPROVE` stop, and a success result yields `started … finished{pr_opened, pr:<url>}` and calls `openDraftPr` once.
  - `queryFn` receives options containing `cwd === worktree`, `maxTurns`, `maxBudgetUsd`, `settingSources` including `"project"`, an `agents` object with all four names, and `hooks` with `PreToolUse` and `Stop`.
  - Fake result `error_max_budget_usd` yields `finished{capped}`, no `openDraftPr`, and the run log still exists with the events up to that point (Review Focus 4).
  - Success result but Quinn never ran yields `finished{unreviewed}` and no PR.
  - A target `.claude/agents/quinn.md` in a temp repo results in `queryFn` seeing the target's quinn prompt and `started.note` containing `quinn`.
  - Run log file has one JSON line per yielded event.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `runlog.ts` (append JSON lines under `<runsDir>/<issue>-<ISO timestamp>/events.jsonl`) and `runIssue`. Read SDK message shapes from `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`SDKResultMessage`, `error_max_turns`, `error_max_budget_usd`, `total_cost_usd`, `num_turns`); do not guess field names.
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: runIssue core with guardrails and run log`.

---

### Task 6: CLI, interactive entry, docs, real run

**Files:**
- Create: `runner/cli.ts`, `test/cli.test.ts`, `.claude/commands/work-issue.md`, `.github/ISSUE_TEMPLATE/work-item.md`, `README.md`
- Modify: `package.json` if scripts need adjusting

**Interfaces:**
- Consumes: `runIssue`, `realExec`, SDK `query`.
- Produces: `export function parseArgs(argv: string[]): { command: "work"; issue: number; repo: string; maxTurns: number; maxUsd: number; requireReview: boolean }` (throws a usage message on bad input). Flags: `--repo <path>` (default cwd), `--max-turns <n>` (default 40), `--max-usd <n>` (default 2), `--no-review` (sets `requireReview` false; prints a warning).

- [ ] **Step 1: Write failing tests** for `parseArgs`: `["work","12"]` gives defaults with `issue: 12`, `repo` equal to cwd; all flags parse; `["work"]`, `["work","abc"]`, and `["wrk","1"]` throw a usage error.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement** `parseArgs` and `main()`: requires `ANTHROPIC_API_KEY`, iterates `runIssue`, prints one line per event, exits `0` on `pr_opened` and `1` otherwise, with the verdict and the run log path on the last line. Add `.claude/commands/work-issue.md` (tells Maya, in the village repo, to follow `village/maya.md` for issue `$ARGUMENTS`), copy the issue template from `Projects/mine/agent-village/.github/ISSUE_TEMPLATE/work-item.md`, and write `README.md` covering setup, usage (`--repo`), the two-repo model, the target-override rule, guardrails, the not-a-security-boundary note, and what is out of scope (UI, Astra, Vercel, merging).
- [ ] **Step 4: Run** `npm test` and `npm run typecheck`. Expected: all PASS.
- [ ] **Step 5: Real end-to-end run.** Create a throwaway GitHub repo with one tiny issue that has acceptance criteria, then run `npm run village -- work 1 --repo <path> --max-usd 1`. Expected: a draft PR URL printed, `runs/…/events.jsonl` present, no merge. If it fails or does not reach `pr_opened`, report the verdict and log honestly and do not claim success.
- [ ] **Step 6: Commit** `feat: CLI, interactive entry and docs`.

---

## Self-Review

- **Spec coverage:** interactive entry (Task 6), headless runner with `--repo` (Tasks 3, 5, 6), single-source agents (Task 2), target override (Tasks 2, 5), guardrails: caps, PreToolUse jail and merge block, Quinn review gate (Tasks 4, 5), draft PR only (Tasks 3, 5), typed event generator (Tasks 1, 5), run log (Task 5), tests with no API calls plus one real run (all tasks, Task 6).
- **Left to the builder in the spec, now decided:** the review gate is a `Stop` hook plus a `SubagentStop` hook reading Quinn's final `VERDICT:` line and comparing HEAD SHAs; the test requirement is a regex over Bash commands (`TEST_COMMAND`, my call, easy to extend); interactive use on target repos is **not** built in this plan (packaging as a plugin is a follow-up), only interactive use inside the village repo.
- **Type consistency:** `Exec`, `Issue`, `VillageEvent`, `Verdict`, `ReviewState` and the `createHooks` deps are defined once (Tasks 1, 3, 4) and consumed unchanged in Task 5.
- **Not covered, on purpose:** worktree cleanup after a PR, running against repos without a GitHub remote, Windows-specific `gh` auth setup.
