## Outcome

Submissions from a sanctioned territory are declined outright, and a decline wins over any referral.

## Context

The desk cannot write business in sanctioned territories. For this demo the list is the ISO country codes `KP`, `IR` and `SY`. A submission that is both sanctioned and has a high loss ratio must come out as `decline`, with both reasons listed.

## Acceptance criteria

- [ ] A submission whose `country` is in the sanctioned list is declined, with a reason whose `rule` is `sanctioned_territory`.
- [ ] Country matching ignores case (`kp` and `KP` both decline).
- [ ] A sanctioned submission that also trips another rule is declined, and every reason is still listed.
- [ ] The sanctioned list is a named, exported constant.
- [ ] Tests cover each case above, and `npm test` passes.

## Constraints

No new dependencies. Do not change how missing fields are handled.
