import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadVillage, mergeTargetAgents, parseAgentFile } from "../runner/load-village.ts";

const quinnText = `---
description: Reviewer
tools: Read, Glob, Grep
model: sonnet
---

Review the change.
`;

test("parseAgentFile parses frontmatter and body", () => {
  const a = parseAgentFile("quinn", quinnText);
  assert.equal(a.description, "Reviewer");
  assert.deepEqual(a.tools, ["Read", "Glob", "Grep"]);
  assert.equal(a.model, "sonnet");
  assert.equal(a.prompt, "Review the change.");
});

test("parseAgentFile throws without description", () => {
  assert.throws(() => parseAgentFile("x", "---\nmodel: haiku\n---\nbody"), /description/);
});

test("loadVillage loads maya and the four specialists", () => {
  const v = loadVillage("village");
  assert.ok(v.maya.length > 0);
  assert.deepEqual(Object.keys(v.agents).sort(), ["quinn", "sam", "susie", "theo"]);
  for (const n of ["theo", "quinn", "susie"]) {
    const t = v.agents[n].tools ?? [];
    assert.ok(!t.includes("Write") && !t.includes("Edit"), n);
  }
  assert.ok(v.agents.sam.tools?.includes("Edit"));
  assert.ok(v.agents.sam.tools?.includes("Bash"));
  assert.match(v.agents.quinn.prompt, /VERDICT: APPROVE/);
  assert.match(v.maya, /Do not push or open a pull request yourself/);
});

test("mergeTargetAgents overrides, adds, and tolerates a missing dir", () => {
  const v = loadVillage("village").agents;
  const dir = mkdtempSync(join(tmpdir(), "village-"));
  writeFileSync(join(dir, "quinn.md"), quinnText.replace("Review the change.", "Custom quinn."));
  writeFileSync(join(dir, "docs.md"), "---\ndescription: Docs\n---\nWrite docs.");
  const r = mergeTargetAgents(v, dir);
  assert.equal(r.agents.quinn.prompt, "Custom quinn.");
  assert.ok(r.agents.docs);
  assert.deepEqual(r.overridden, ["quinn"]);
  const none = mergeTargetAgents(v, join(dir, "missing"));
  assert.deepEqual(none.agents, v);
  assert.deepEqual(none.overridden, []);
});
