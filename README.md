# Claude Agent Village

A headless runner that takes a GitHub issue in a target repository, has Maya (engineering lead) and her specialist subagents implement it in an isolated git worktree, and opens a **draft** pull request once Quinn (reviewer) approves. It never merges.

Status: the unit tests pass without API calls. One real end-to-end run has succeeded: issue #1 of a small test repo became a draft PR after Quinn approved it (9 turns, about $0.29).

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
| `--verify <command>` | none | Acceptance check the runner runs itself, in the worktree at the final commit, before any PR (for example `--verify "npm test"`). A failure means no PR (`unreviewed`). |

The runner prints one line per event and exits 0 only when a draft PR was opened, 1 for any other verdict, and exit code 2 for a usage error or a missing `ANTHROPIC_API_KEY` (nothing is run). Every event is also appended to `runs/<issue>-<timestamp>/events.jsonl`. The final line names the verdict (`pr_opened`, `not_ready`, `unreviewed`, `capped`, `error`) and the path of this run's `events.jsonl` (also on the `finished` event as `logPath`).

## Scorecard

```
npm run village -- report [--runs <dir>]
```

Reads every `runs/*/events.jsonl` and prints a scorecard: runs, how many stopped at the input gate, draft PRs per attempted run, total and median cost (per run and per PR), median turns and wall time, Quinn reviews and rejections, first-pass approvals, agent test runs and failures, runner checks and failures, and the most common blocked actions. No API calls.

## How a run is evaluated

A draft PR opens only when every check below holds. Each check writes an event to the run log, so the scorecard can count what each one caught.

1. **Input gate:** the issue has an Outcome and acceptance criteria, or the run ends `not_ready` before any model call.
2. **Agent tests:** a test command ran (`test_result` events) and the most recent run passed. The outcome comes from Claude Code reporting a non-zero exit as a tool failure; an interrupted or backgrounded run counts as unknown, not passed.
3. **Designer handoff:** when the run is design work, Susie (product designer) has run before Quinn's review (`design_required` event). See [Designer handoff](#designer-handoff).
4. **Independent review:** Quinn, a separate subagent with read-only file tools, ends with `VERDICT: APPROVE` for the current HEAD commit (`review` events). Any commit after the approval needs a new review.
5. **Runner check (optional):** with `--verify`, the runner, not the agents, runs the command you chose at the final commit (`verified` event). The agents cannot see, change or skip it.
6. **Clean finish:** no uncommitted changes, HEAD on the issue branch.
7. **A human merges.** The runner only opens drafts.

## Designer handoff

Susie used to run only when Maya read an issue as UI work. That was an instruction in Markdown, so nothing guaranteed it. The runner now decides, and SDK hooks hold the order (`runner/design.ts`).

A run is design work when any of these is true:

- The issue has a `design`, `ui`, `ux` or `ui/ux` label (any case). This is known before any model call, and Maya's prompt says so.
- An agent writes a UI file through a file tool: `.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.html`, `.htm`, `.css`, `.scss`, `.sass`, `.less` or `.styl`. Test and story files (`*.test.*`, `*.spec.*`, `*.stories.*`, `__tests__/`) do not count.
- The branch's committed diff against its base touches a UI file. This is checked when Maya tries to finish and again by the runner before any PR, so it also catches files written from the shell.

Once a run is design work:

- **PreToolUse on the Agent tool** denies handing work to Quinn until Susie has finished (a `blocked` event), and tells Maya to bring Susie in first.
- **The Stop hook** blocks Maya from finishing until Susie has run.
- **The runner** opens no PR until Susie has run (verdict `unreviewed`), and the PR body records `Design: susie reviewed (<why>)`. If it cannot read the diff, the run ends `error` rather than opening a PR unchecked.

Runs that touch no UI files and carry no design label behave exactly as before. `--no-review` turns this gate off along with the review gate. Interactive `/work-issue` runs have no runner, so there the order is guidance only.

## Demo target

`demo/` holds a small, dependency-free target repo (fictional insurance submission triage: quote, refer or decline, with a traced reason per rule) and three issues: two real work items and one that is deliberately not ready. To create it next to this checkout, push it to your account and file the issues:

```
.\demo\setup-target.ps1          # Windows PowerShell
demo/setup-target.sh              # macOS / Linux / Git Bash
```

Then:

```
npm run village -- work 3 --repo ../village-demo-triage                                   # not_ready, no model call
npm run village -- work 1 --repo ../village-demo-triage --verify "npm test" --max-usd 1  # full run to a draft PR
npm run village -- report
```

Setup prints the issue numbers it used; they are 1 to 3 on a fresh repo.

`demo/issues/live-template.md` is a blank work item for writing a new issue on the spot.

### Resetting the demo

To start over, remove the local target and run setup again:

```
demo/cleanup-target.sh --archive-runs     # macOS / Linux / Git Bash
demo/setup-target.sh --yes
```

```
.\demo\cleanup-target.ps1 -ArchiveRuns    # Windows PowerShell
.\demo\setup-target.ps1 -Yes
```

Cleanup is local only. It deletes `../village-demo-triage` and its worktrees under `../.village-worktrees/village-demo-triage-issue-*`, and with `--archive-runs` moves `runs/` to `runs-<timestamp>` so the next scorecard starts clean. It lists what it will delete and asks you to type the repo name unless you pass `--yes` (`-Yes`). It never deletes the GitHub repo and refuses to touch this checkout or a folder that isn't the demo target. Both scripts take the repo name as their first argument (`-Name` in PowerShell) if you used another.

When the GitHub repo already exists, setup reuses it instead of creating it: it force-pushes a fresh `main`, closes open PRs from `village/*` branches and deletes those branches, and reuses the three demo issues by title (reopening any that were closed and refreshing their bodies), so the issue numbers stay the same. It asks first unless you pass `--yes` (`-Yes`).

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

The target repo does not need a local `origin/HEAD`: the runner reads the remote's default branch from `git ls-remote --symref origin HEAD` when it is missing, and changes none of the target's refs.

Issues need a non-empty "Outcome" section and an "Acceptance criteria" checklist (see `.github/ISSUE_TEMPLATE/work-item.md`); an issue missing either finishes as `not_ready`, and the note says which.

## Guardrails

- Caps: `--max-turns` and `--max-usd` end the run with verdict `capped`.
- PreToolUse hook: file tools are jailed to the worktree, and any `git push`, `gh pr create`/`ready`, merges (including merge API endpoints) and destructive commands are blocked (reported as `blocked` events).
- Designer handoff: on design work, Quinn cannot be called and no PR opens until Susie has run (see [Designer handoff](#designer-handoff)).
- Quinn review gate: a PR is opened only if a test command ran, the last test run did not fail, and Quinn's final `VERDICT: APPROVE` is for the current HEAD commit. Otherwise the verdict is `unreviewed`.
- Runner check: with `--verify`, the runner reruns your acceptance command at the final commit before pushing anything.
- Draft PRs only. The runner pushes and opens the PR; the agents are told not to.
- Clean-worktree check: uncommitted changes at the end mean no PR (`unreviewed`).
- Run log under `runs/`.

Permission mode is `acceptEdits` with `allowedTools` of Read, Glob, Grep, Edit, Write, Bash, PowerShell and Agent.

Subagents run in the foreground: the runner sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` for the session. Without it Claude Code launches Quinn as a background task, Maya ends her turn ("the review is still running"), and the session finishes before Quinn reviews, so the run ends `unreviewed`. As a backstop, the Stop hook also blocks while any background task is still running, even on its second call.

## Only run it on trusted repos and issues

The issue text is part of the agents' prompt and the agents run shell commands, so an issue written by someone you do not trust can steer them. Use this only on repositories and issues you trust, ideally inside a container or VM, with a scoped GitHub token and a spend cap. See [SECURITY.md](SECURITY.md).

## Not a security boundary

These checks run in-process and are a safety net against mistakes, not a sandbox against a determined or compromised agent. For real isolation, run the runner in a container, VM or other sandbox. Known limits:

- Variable indirection and string-building can defeat command pattern matching.
- Scripts written to disk and then run are not inspected.
- PowerShell escapes and alternative syntaxes are not fully covered.
- Symlinks are not resolved.
- Bash and PowerShell writes are not path-jailed (only the file tools are).
- The designer handoff only checks that Susie ran, not what she said. UI files are recognised by extension, so UI built in plain `.ts` or `.js` needs a design label.
- Test outcomes rely on the shell's exit code as Claude Code reports it. A command that hides its exit code (`npm test | tail`) reads as a pass, and nothing checks that the tests are meaningful. `--verify` runs your own command independently, but it is only as good as that command.

## Out of scope

- UI / Village Office, Astra Lab, Vercel deployment.
- Merging (a human merges).
- Interactive use on other repos; that needs plugin packaging and is a follow-up.

## Development

`npm test` (no API calls) and `npm run typecheck`.

## License

MIT. See [LICENSE](LICENSE).
