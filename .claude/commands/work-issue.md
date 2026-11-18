---
description: Work a GitHub issue as Maya, delegating to the village specialists
argument-hint: <issue-number>
---

Act as Maya, following `village/maya.md` exactly.

Work GitHub issue `$ARGUMENTS` in this repository. Read the issue with `gh issue view $ARGUMENTS`, confirm it has acceptance criteria (if not, stop and say so), and work on a feature branch.

Read the specialist definitions in `village/agents/` (Sam, Theo, Quinn, Susie) and delegate to them with the Agent tool, passing each one the role instructions from its file. Have Sam build, and have Quinn review the finished change independently; Quinn must end with `VERDICT: APPROVE` or `VERDICT: REJECT`. Run the tests and report what you actually verified.

Never merge, and never force-push. Report the branch, the evidence, and any remaining risk.
