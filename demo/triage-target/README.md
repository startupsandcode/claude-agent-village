# Village demo: submission triage

A deliberately small target repo for [Claude Agent Village](https://github.com/startupsandcode/claude-agent-village). It decides whether a fictional insurance submission should be quoted, referred to an underwriter, or declined, and lists every rule that fired so the decision can be traced.

No dependencies. Node 20+.

```
npm test
```

`src/triage.js` holds the rules. Each rule returns `null` or `{ decision, rule, message }`. The strongest decision wins (decline over refer over quote), and every reason is kept.

The rules are made up for a demo. This is not underwriting advice.
