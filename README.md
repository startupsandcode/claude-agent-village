# Claude Agent Village

A headless runner that takes a GitHub issue in a target repository, has Maya (engineering lead) and her specialist subagents implement it in an isolated git worktree, and opens a **draft** pull request once Quinn (reviewer) approves. It never merges.

Status: the unit tests pass without API calls. A real end-to-end run against a live repo has not been recorded yet.

## Setup

- Node 24.2+ (TypeScript files run directly).
- On Windows, Git for Windows (Git Bash) is required: Claude Code uses it for shell commands, and the runner shells out to `git` and `gh`.
- `npm install`
- Copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.
- `gh auth login` (the runner uses the `gh` CLI to read issues and open draft PRs).

## Usage

```
npm run village -- work 12 --repo <path-to-target-repo>
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--repo <path>` | current directory | Target repo (must be a git repo with a GitHub remote) |
| `--max-turns <n>` | 40 | Turn cap for the run |
| `--max-usd <n>` | 2 | Spend cap in USD |
| `--no-review` | review required | Skip the Quinn review gate (prints a warning) |

The runner prints one line per event and exits 0 only when a draft PR was opened, otherwise 1. Every event is also appended to `runs/<issue>-<timestamp>/events.jsonl`. The final line names the verdict (`pr_opened`, `not_ready`, `unreviewed`, `capped`, `error`) and the path of this run's `events.jsonl` (also on the `finished` event as `logPath`).

## Rerunning an issue

Each run works on branch `village/issue-<n>` in a worktree at `<target-parent>/.village-worktrees/<repo>-issue-<n>`. These are kept after a run (the `finished` event carries the `worktree` path). A second run of the same issue stops with an error naming which one exists (the branch, the directory, or both) and the cleanup commands. Run them in the target repo, then rerun:

```
git worktree remove --force <path>
git branch -D village/issue-<n>
```

There is deliberately no `--reset` flag: deleting a branch and worktree is destructive, so you do it yourself.

Interactive use inside this repo: run `/work-issue <number>` in Claude Code (`.claude/commands/work-issue.md`). It makes Claude act as Maya and delegate to the agents in `village/agents/`.

## Two repos: the village and the target

- The **village** (this repo) holds the agents: `village/maya.md` and `village/agents/*.md` (Sam, Theo, Quinn, Susie). It is the single source of truth.
- The **target** is the repo being changed. The runner creates a worktree and branch there and runs the agents with that worktree as their working directory.
- Target-agent-wins override: if the target repo has `.claude/agents/<name>.md`, it replaces the village agent of the same name for that run, and the `started` event notes which agents were overridden. The runner reads the target's `.claude/agents/*.md` from the worktree and matches on the frontmatter `name:` (falling back to the filename); for each match it drops the village agent and lets Claude Code load the target's own file, so the target's tools and model apply as written. Files without frontmatter are skipped with a note.

Issues need an "Acceptance criteria" checklist (see `.github/ISSUE_TEMPLATE/work-item.md`); an issue without one finishes as `not_ready`.

## Guardrails

- Caps: `--max-turns` and `--max-usd` end the run with verdict `capped`.
- PreToolUse hook: file tools are jailed to the worktree, and any `git push`, `gh pr create`/`ready`, merges (including merge API endpoints) and destructive commands are blocked (reported as `blocked` events).
- Quinn review gate: a PR is opened only if a test command ran and Quinn's final `VERDICT: APPROVE` is for the current HEAD commit. Otherwise the verdict is `unreviewed`.
- Draft PRs only. The runner pushes and opens the PR; the agents are told not to.
- Clean-worktree check: uncommitted changes at the end mean no PR (`unreviewed`).
- Run log under `runs/`.

Permission mode is `acceptEdits` with `allowedTools` of Read, Glob, Grep, Edit, Write, Bash, PowerShell and Agent.

## Not a security boundary

These checks run in-process and are a safety net against mistakes, not a sandbox against a determined or compromised agent. For real isolation, run the runner in a container, VM or other sandbox. Known limits:

- Variable indirection and string-building can defeat command pattern matching.
- Scripts written to disk and then run are not inspected.
- PowerShell escapes and alternative syntaxes are not fully covered.
- Symlinks are not resolved.
- Bash and PowerShell writes are not path-jailed (only the file tools are).
- `ranTests` only records that a test-looking command ran, not that it passed or was meaningful.

## Out of scope

- UI / Village Office, Astra Lab, Vercel deployment.
- Merging (a human merges).
- Interactive use on other repos; that needs plugin packaging and is a follow-up.

## Development

`npm test` (no API calls) and `npm run typecheck`.
