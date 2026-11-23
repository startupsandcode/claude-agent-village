import { test } from "node:test";
import assert from "node:assert/strict";
import { triage } from "../src/triage.js";

const clean = { insured: "Acme Foods", lineOfBusiness: "property", country: "US", tiv: 12_000_000, lossRatio5y: 0.35 };

test("a clean submission is quoted with no reasons", () => {
  assert.deepEqual(triage(clean), { decision: "quote", reasons: [] });
});

test("missing required fields refer, naming each field", () => {
  const r = triage({ ...clean, country: "", tiv: undefined });
  assert.equal(r.decision, "refer");
  assert.equal(r.reasons[0].rule, "missing_fields");
  assert.match(r.reasons[0].message, /country, tiv/);
});

test("a 5-year loss ratio above 0.7 refers", () => {
  const r = triage({ ...clean, lossRatio5y: 0.82 });
  assert.equal(r.decision, "refer");
  assert.deepEqual(r.reasons.map((x) => x.rule), ["high_loss_ratio"]);
});

test("a loss ratio of exactly 0.7 is still quoted", () => {
  assert.equal(triage({ ...clean, lossRatio5y: 0.7 }).decision, "quote");
});

test("every rule that fires is listed, not just the first", () => {
  const r = triage({ ...clean, insured: "", lossRatio5y: 0.9 });
  assert.deepEqual(r.reasons.map((x) => x.rule), ["missing_fields", "high_loss_ratio"]);
});
