// Submission triage: decide whether an underwriter should quote, refer, or decline a submission,
// and say why. Every reason names the rule that produced it, so a decision can be traced.
//
// Fictional rules for a demo. Not underwriting advice.

export const REQUIRED_FIELDS = ["insured", "lineOfBusiness", "country", "tiv"];

// Each rule looks at one submission and returns null, or { decision, rule, message }.
export const RULES = [
  function missingFields(s) {
    const missing = REQUIRED_FIELDS.filter((f) => s[f] === undefined || s[f] === null || s[f] === "");
    return missing.length
      ? { decision: "refer", rule: "missing_fields", message: `missing ${missing.join(", ")}` }
      : null;
  },
  function highLossRatio(s) {
    return typeof s.lossRatio5y === "number" && s.lossRatio5y > 0.7
      ? { decision: "refer", rule: "high_loss_ratio", message: `5-year loss ratio ${s.lossRatio5y} is above 0.7` }
      : null;
  },
];

const RANK = { quote: 0, refer: 1, decline: 2 };

export function triage(submission, rules = RULES) {
  const reasons = rules.map((rule) => rule(submission)).filter(Boolean);
  const decision = reasons.reduce((d, r) => (RANK[r.decision] > RANK[d] ? r.decision : d), "quote");
  return { decision, reasons };
}
