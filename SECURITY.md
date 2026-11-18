# Security

## Read this before running it

Claude Agent Village runs AI agents that execute shell commands (Bash and PowerShell) and edit files in a git worktree of the target repository. The checks in `runner/guards.ts` are a safety net against mistakes, not a sandbox. See "Not a security boundary" in the [README](README.md) for the known gaps.

- **Only run it on repositories and issues you trust.** The issue title and body go straight into the agents' prompt, so anyone who can write an issue can steer what the agents do (prompt injection).
- **Prefer a container or VM** for anything beyond your own repos. The agents have the permissions of the account that runs the runner, including its `gh` login and any credentials in the environment.
- **Use a scoped, low-privilege GitHub token** and a spend cap (`--max-usd`). The runner pushes a branch and opens a draft PR with your `gh` credentials.
- A human reviews and merges every PR. The runner never merges.

## Reporting a vulnerability

Please report security problems privately through GitHub's "Report a vulnerability" option on this repository's Security tab (private vulnerability reporting), rather than a public issue. If that option is not available, open an issue asking for a private contact without including details.
