## Outcome

Submissions whose total insured value (TIV) is above the desk underwriter's authority limit are referred to a senior underwriter instead of being quoted, and the reason says so.

## Context

Underwriters can only bind up to their authority limit. Today `triage` quotes a clean $80M submission. The limit for this desk is $50,000,000.

## Acceptance criteria

- [ ] A submission with `tiv` above 50,000,000 is referred, with a reason whose `rule` is `tiv_above_authority`.
- [ ] A submission with `tiv` of exactly 50,000,000 is still quoted.
- [ ] The reason's message includes the TIV and the limit.
- [ ] The limit is a named constant in `src/triage.js`, not a magic number inside the rule.
- [ ] Tests cover above, at, and below the limit, and `npm test` passes.

## Constraints

No new dependencies. Keep existing rules and their order.
