import { test } from "node:test";
import assert from "node:assert/strict";
import { getIssue, openDraftPr, parseIssue } from "../runner/github.ts";
import type { Exec } from "../runner/git.ts";

type Call = { cmd: string; args: string[]; cwd?: string };

function fake(handler: (call: Call) => { stdout?: string; code?: number; stderr?: string }) {
  const calls: Call[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    const call = { cmd, args, cwd: opts?.cwd };
    calls.push(call);
    const r = handler(call);
    return { stdout: r.stdout ?? "", code: r.code ?? 0, stderr: r.stderr };
  };
  return { exec, calls };
}

const body = `## Outcome
Users can log in.

## Acceptance criteria
- [ ] Login form renders
- [ ] Bad password shows an error

## Notes
- [ ] not a criterion
`;

test("parseIssue extracts outcome and criteria", () => {
  const i = parseIssue(7, "Login", body);
  assert.equal(i.number, 7);
  assert.equal(i.outcome, "Users can log in.");
  assert.deepEqual(i.criteria, ["Login form renders", "Bad password shows an error"]);
});

test("parseIssue with no criteria gives []", () => {
  const i = parseIssue(8, "T", "just text");
  assert.deepEqual(i.criteria, []);
  assert.equal(i.outcome, "");
});

test("getIssue parses gh JSON", async () => {
  const { exec, calls } = fake(() => ({ stdout: JSON.stringify({ title: "Login", body }) }));
  const i = await getIssue(exec, "o/r", 7);
  assert.equal(i.title, "Login");
  assert.equal(i.criteria.length, 2);
  assert.equal(calls[0].cmd, "gh");
  assert.ok(calls[0].args.includes("7"));
  assert.ok(!calls[0].args.includes("--repo"));
  assert.equal(calls[0].cwd, "o/r");
});

test("getIssue throws with stderr on failure", async () => {
  const { exec } = fake(() => ({ code: 1, stderr: "could not resolve" }));
  await assert.rejects(getIssue(exec, "o/r", 7), /could not resolve/);
});

const issue = parseIssue(12, "Add login", body);

test("openDraftPr pushes the explicit branch, then creates a draft PR", async () => {
  const { exec, calls } = fake((c) => (c.cmd === "gh" ? { stdout: "https://github.com/o/r/pull/3\n" } : {}));
  const url = await openDraftPr(exec, "/wt", issue, "Summary", "village/issue-12");
  assert.equal(url, "https://github.com/o/r/pull/3");
  const pushIdx = calls.findIndex((c) => c.cmd === "git" && c.args[0] === "push");
  const createIdx = calls.findIndex((c) => c.cmd === "gh");
  assert.ok(pushIdx >= 0 && createIdx > pushIdx);
  assert.deepEqual(calls[pushIdx].args, ["push", "-u", "origin", "village/issue-12"]);
  assert.equal(calls[pushIdx].cwd, "/wt");
  assert.ok(!calls.some((c) => c.args[0] === "rev-parse"), "branch is a parameter, not re-derived from HEAD");
  const a = calls[createIdx].args;
  assert.ok(a.includes("--draft"));
  assert.match(a[a.indexOf("--title") + 1], /12/);
  assert.match(a[a.indexOf("--body") + 1], /Closes #12/);
  assert.equal(calls[createIdx].cwd, "/wt");
});

test("openDraftPr throws on push failure and creates no PR", async () => {
  const { exec, calls } = fake((c) => (c.args[0] === "push" ? { code: 1, stderr: "permission denied" } : {}));
  await assert.rejects(openDraftPr(exec, "/wt", issue, "b", "village/issue-12"), /permission denied/);
  assert.equal(calls.filter((c) => c.cmd === "gh").length, 0);
});

test("getIssue asks gh for labels and returns their names", async () => {
  const { exec, calls } = fake(() => ({
    stdout: JSON.stringify({ title: "T", body, labels: [{ name: "design", color: "fff" }, { name: "bug" }, {}] }),
  }));
  const i = await getIssue(exec, "/work/proj", 4);
  assert.deepEqual(calls[0]!.args, ["issue", "view", "4", "--json", "title,body,labels"]);
  assert.deepEqual(i.labels, ["design", "bug"]);
});

test("getIssue treats a missing labels field as no labels", async () => {
  const { exec } = fake(() => ({ stdout: JSON.stringify({ title: "T", body }) }));
  assert.deepEqual((await getIssue(exec, "/work/proj", 4)).labels, []);
  assert.deepEqual(parseIssue(1, "T", body).labels, []);
});
