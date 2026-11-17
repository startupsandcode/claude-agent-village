# Claude Agent Village: core loop design

Status: approved by John. Date: 2026-11-17.

## Intent and why

Agent Village (github.com/startupsandcode/agent-village, local copy at `Projects/mine/agent-village`) is John's workflow for turning GitHub Issues into reviewed pull requests. It was built with Codex: Maya is the lead persona, with Theo, Sam, Quinn and Susie as specialist agents.

Claude Agent Village is a new repo that does the same job on the Claude platform and is built with Claude. John's key requirement: **the Claude Agent SDK is the point.** A runner program must drive the loop through the SDK, so the project teaches and exercises SDK features (subagents, hooks, permissions, budgets, sessions), not just Markdown instructions. A UI (the Village Office) comes later and will sit on top of the runner.

## Goals

1. Interactive: talk to Maya in Claude Code (VS Code), say "work issue 12", and the loop runs.
2. Headless: `npm run village -- work 12 --repo <path>` runs the same loop through the Agent SDK on **any target repo**, with guardrails, and leaves a draft PR plus a run log in that repo.
3. One definition of each agent and of Maya's rules, used by both front doors, kept in the village repo and never copied into target repos.
4. The runner exposes a clean programmatic API (an async stream of typed run events) that a UI can consume later without changes to the loop.

## Non-goals (this phase)

- The Village Office UI, check-in reports, and the demo site.
- The local Maya chat, Astra Lab worker, design-led mission runner and Vercel adapter.
- Background polling, scheduled runs, automatic issue assignment, or merging. Agents never merge.
- Being a security boundary. Guardrails are in-process; isolation comes from a per-issue git worktree and tool limits, not a sandbox.

## Anti-goals (failure even if it technically works)

- Prompt text duplicated between the interactive and headless paths.
- Maya claiming work is done without evidence (tests run, files inspected). The Codex version's honesty rules carry over.
- A runner that grows into its own product: it orchestrates one issue to one PR and stops.
- A headless run with no cost cap or turn cap.

## Constraints

- New repo `claude-agent-village` at `C:\Users\JMann\Projects\mine\claude-agent-village`; this learning repo stays unchanged.
- Windows 11 primary; `gh` CLI is already authenticated for GitHub work.
- Same TypeScript conventions as claude-platform-learning: Node 24+, `.ts` run directly, `@anthropic-ai/claude-agent-sdk`, `node --test`, `tsc` for typecheck.

## Approaches considered

- **A. Claude Code native, no code.** CLAUDE.md, `.claude/agents/*.md`, a slash command. Closest 1:1 port but cannot be driven programmatically, so a UI has nothing to call.
- **B. Agent SDK program only.** Headless and scriptable, but loses the interactive "talk to Maya in the editor" use and forces agent definitions into code.
- **C. Shared definitions, two front doors.** Agents and Maya's rules live once in files; the SDK runner loads them. **Chosen by John**, with the emphasis that the runner is a first-class deliverable, not a thin wrapper.

## Design

### Two repos: the village and the target

The village repo (this one) holds the agents, Maya's rules and the runner. The work happens in a **target repo**, any project John points it at (Astra Lab, a client repo, this repo itself). The SDK only auto-loads `.claude/agents` and `CLAUDE.md` from its `cwd`, so the village's definitions are NOT found when `cwd` is a target worktree. The runner therefore loads them itself and passes them to the SDK in code. A target repo's own `CLAUDE.md` still applies (Maya reads it as project rules), and the village's agents never need to be copied into it.

### Single source of truth (in the village repo)

- `village/maya.md`: Maya's role and the working agreement (ported from `AGENTS.md`: outcome and acceptance criteria first, one issue per branch and PR, evidence before claims, specialists only when they help, PRs never merged by agents). The runner passes it as the main agent's system prompt (appended to the SDK's Claude Code preset).
- `village/agents/{sam,theo,quinn,susie}.md`: the specialists, ported from the `.codex/agents/*.toml` prompts, with frontmatter (description, tools, model). The runner parses these into the SDK `agents` option. Theo, Quinn and Susie are read-only (tools limited to Read, Glob, Grep, plus read-only Bash where needed); Sam can edit and run tests.
- `.github/ISSUE_TEMPLATE/work-item.md`: copied from the current repo, for use in target repos.
- Interactive use on a target repo is a packaging question left to the builder (most likely a Claude Code plugin generated from the same `village/` files, so there is still one copy). Interactive use inside the village repo itself is covered by a thin `.claude/` that points at the same files.

### The runner (`runner/`)

`npm run village -- work <issue> [--repo <path>]` does, in order. `--repo` defaults to the current directory; the target must be a git repo with a GitHub remote and a clean enough state to branch from.

1. **Read the issue** from the target repo with `gh issue view`. If there is no clear outcome or acceptance criteria, stop and report; do not guess.
2. **Create an isolated git worktree and branch** in the target for the issue (`village/issue-<n>`), so its main checkout is never touched.
3. **Run Maya** with the SDK `query()`: Maya's role from `village/maya.md` as the system prompt, the four specialists from `village/agents/` passed as the `agents` option, `cwd` set to the target worktree, `settingSources: ["project"]` so the target's own CLAUDE.md applies.
4. **Apply guardrails** from the SDK: `maxTurns`, `maxBudgetUsd`, a `PreToolUse` hook that blocks destructive Bash and writes outside the worktree and any `gh pr merge`, and `disallowedTools` where useful. Defaults are conservative and overridable by flags.
5. **Require review before the PR:** a `Stop` hook (or equivalent end-of-run check) refuses to let Maya finish a substantive code issue until Quinn has reviewed the final commit and tests have been run.
6. **Open a draft PR** linked to the issue, with what changed, how it was verified, and remaining risk, then stop.
7. **Write a run log** (JSON lines) under `runs/<issue>-<timestamp>/`: every event, tool call, subagent start/stop, cost, and the verdict. Gitignored.

Runner API: an async generator `runIssue(options)` yielding typed events (`started`, `agent_started`, `tool_call`, `blocked`, `agent_finished`, `cost`, `finished`). The CLI is a thin printer over it. A later UI consumes the same generator.

### Repo layout (proposed)

```
village/maya.md
village/agents/{sam,theo,quinn,susie}.md
.claude/                              # thin, for using the village inside this repo
.github/ISSUE_TEMPLATE/work-item.md
runner/{cli.ts,run-issue.ts,load-village.ts,guards.ts,events.ts,git.ts,github.ts}
test/                                 # guard logic, event shapes, git/gh wrappers with fakes
docs/                                 # this design, README, how to run
```

### Testing

- Unit tests with no API calls for the guards (blocked commands, path jail, merge refusal), event mapping, issue parsing, and the git/gh wrappers against fakes.
- One real end-to-end run against a throwaway test repo issue, cost-capped, to confirm the loop works. Reported honestly if it doesn't.

## Decisions John made

- Core loop only; UI comes later.
- Approach C, with the SDK runner as a first-class part.
- New repo named Claude Agent Village, separate from claude-platform-learning.
- Two-repo model: the village holds the agents and runner; work happens in a target repo passed with `--repo`.
- **If a target repo defines an agent with the same name as a village agent, the target's definition wins**, because it is specific to that repo. The runner merges village agents first, then lets the target's override by name, and logs which were overridden.

## My calls (please check)

- **Models:** Maya, Sam and Quinn on `claude-sonnet-5-5`, Theo and Susie on `claude-haiku-5-5` for cost; configurable in one place. Real coding work needs more than Haiku, unlike the cheap lessons.
- **Worktree per issue** rather than a branch in the main checkout, matching the safety of the Astra worker.
- **Default caps:** 40 turns and $2.00 per run; flags override.
- **Run logs are local only** (gitignored), no database.
- **Draft PRs only**, never ready-for-review, so a human always promotes them.

## Left to the builder

- How interactive use on a target repo is packaged (plugin vs. other), and how the runner discovers the target's `.claude/agents` for the override rule above.
- Exact hook mechanics (which hook enforces "Quinn reviewed", and how the runner knows the final commit), to be read from the installed SDK types before coding.
- Prompt wording for each agent beyond the ported text.
- Run-log format details and the CLI flag names.
- Whether the worktree is cleaned up automatically after a PR is opened.
