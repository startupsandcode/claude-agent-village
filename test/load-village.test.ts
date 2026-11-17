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

function targetDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "village-"));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

test("target quinn.md with a YAML-list tools field removes the village quinn and reports it", () => {
  const v = loadVillage("village").agents;
  const dir = targetDir({
    "quinn.md": "---\nname: quinn\ndescription: Target reviewer\ntools:\n  - Read\n  - Grep\n---\nCustom quinn.\n",
  });
  const r = mergeTargetAgents(v, dir);
  assert.ok(!("quinn" in r.agents));
  assert.deepEqual(Object.keys(r.agents).sort(), ["sam", "susie", "theo"]);
  assert.deepEqual(r.overridden, ["quinn"]);
  assert.ok("quinn" in v, "input is not mutated");
});

test("name: quinn inside code-reviewer.md is detected, filename is not used when name is present", () => {
  const v = loadVillage("village").agents;
  const r = mergeTargetAgents(v, targetDir({ "code-reviewer.md": "---\nname: quinn\ndescription: R\n---\nbody" }));
  assert.deepEqual(r.overridden, ["quinn"]);
  assert.ok(!("quinn" in r.agents));
});

test("quoted names are unquoted; filename is the fallback when there is no name", () => {
  const v = loadVillage("village").agents;
  const a = mergeTargetAgents(v, targetDir({ "x.md": '---\nname: "quinn"\ndescription: R\n---\nb' }));
  assert.deepEqual(a.overridden, ["quinn"]);
  const b = mergeTargetAgents(v, targetDir({ "x.md": "---\nname: 'sam'\n---\nb" }));
  assert.deepEqual(b.overridden, ["sam"]);
  const c = mergeTargetAgents(v, targetDir({ "theo.md": "---\ndescription: T\n---\nb" }));
  assert.deepEqual(c.overridden, ["theo"]);
  const d = mergeTargetAgents(v, targetDir({ "quinn.md": "---\r\nname: quinn\r\n---\r\nb" }));
  assert.deepEqual(d.overridden, ["quinn"]);
});

test("files without frontmatter (a stray README.md) are skipped with a note, not an error", () => {
  const v = loadVillage("village").agents;
  const r = mergeTargetAgents(v, targetDir({ "README.md": "# Agents\nsome docs about quinn", "docs.md": "---\nname: docs\n---\nx" }));
  assert.deepEqual(r.overridden, []);
  assert.deepEqual(r.agents, v);
  assert.equal(r.notes.length, 1);
  assert.match(r.notes[0]!, /README\.md.*frontmatter/);
});

test("target-only agents are not added (the SDK loads them natively) and a missing dir is a no-op", () => {
  const v = loadVillage("village").agents;
  const dir = targetDir({ "docs.md": "---\nname: docs\ndescription: Docs\n---\nWrite docs." });
  assert.deepEqual(mergeTargetAgents(v, dir).agents, v);
  const none = mergeTargetAgents(v, join(dir, "missing"));
  assert.deepEqual(none.agents, v);
  assert.deepEqual(none.overridden, []);
  assert.deepEqual(none.notes, []);
});
