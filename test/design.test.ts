// Tests for the designer handoff: when a run is design work, and the hooks that hold Susie's place in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  changedFiles,
  createDesignHooks,
  createDesignState,
  designLabel,
  designPending,
  isUiPath,
  mergeHooks,
  noteChangedFiles,
} from "../runner/design.ts";
import type { DesignState } from "../runner/design.ts";
import type { VillageEvent } from "../runner/events.ts";
import type { Exec } from "../runner/git.ts";

const WT = join(tmpdir(), "village-design-wt");

type HookName = "PreToolUse" | "PostToolUse" | "SubagentStop" | "Stop";

function setup(o: { labels?: string[]; requireReview?: boolean; changed?: () => Promise<string[]> } = {}) {
  const events: VillageEvent[] = [];
  const state: DesignState = createDesignState(o.labels ?? []);
  const hooks = createDesignHooks({
    worktree: WT,
    state,
    emit: (e) => events.push(e),
    requireReview: o.requireReview ?? true,
    ...(o.changed ? { getChangedFiles: o.changed } : {}),
  })!;
  const run = (event: HookName, input: Record<string, unknown>) =>
    hooks[event]![0]!.hooks[0]!(
      { session_id: "s", transcript_path: "t", cwd: "c", hook_event_name: event, ...input } as never,
      undefined,
      { signal: new AbortController().signal },
    ) as Promise<Record<string, any>>;
  const handTo = (agent: string, tool = "Agent") =>
    run("PreToolUse", { tool_name: tool, tool_input: { subagent_type: agent, description: "d", prompt: "p" }, tool_use_id: "1" });
  const finished = (agent: string) =>
    run("SubagentStop", { stop_hook_active: false, agent_id: "a", agent_transcript_path: "p", agent_type: agent });
  const wrote = (file_path: string, tool = "Write") =>
    run("PostToolUse", { tool_name: tool, tool_input: { file_path }, tool_response: {}, tool_use_id: "2" });
  const stop = (stop_hook_active = false) => run("Stop", { stop_hook_active });
  const denied = (r: Record<string, any>) => r.hookSpecificOutput?.permissionDecision === "deny";
  return { events, state, run, handTo, finished, wrote, stop, denied };
}

// ---- what counts as design work ----

test("isUiPath: components, markup and styles are UI; logic, docs and tests are not", () => {
  for (const p of ["src/App.tsx", "a/b/Card.jsx", "Page.vue", "x.svelte", "index.html", "site.CSS", "s.scss", "C:\\web\\Nav.tsx"]) {
    assert.equal(isUiPath(p), true, p);
  }
  for (const p of ["src/app.ts", "triage.js", "README.md", "Button.test.tsx", "Card.spec.jsx", "Nav.stories.tsx",
    "src/__tests__/Nav.tsx", "src/__snapshots__/a.html", ".css", "", "styles"]) {
    assert.equal(isUiPath(p), false, p);
  }
});

test("designLabel matches design, ui, ux and ui/ux case-insensitively, and nothing looser", () => {
  assert.equal(designLabel(["bug", "Design"]), "Design");
  assert.equal(designLabel([" UX "]), " UX ");
  assert.equal(designLabel(["ui/ux"]), "ui/ux");
  assert.equal(designLabel(["designer", "build", "guide"]), null);
  assert.equal(designLabel([]), null);
});

test("createDesignState: a design label makes the run design work before any model call", () => {
  assert.deepEqual(createDesignState(["ui"]), { required: 'issue labeled "ui"', susieRan: false });
  assert.deepEqual(createDesignState(), { required: null, susieRan: false });
  assert.equal(designPending(createDesignState(["ui"])), true);
  assert.equal(designPending(createDesignState()), false);
});

test("noteChangedFiles marks design work once, naming the first UI file", () => {
  const events: VillageEvent[] = [];
  const state = createDesignState();
  noteChangedFiles(state, ["src/a.ts", "README.md"], (e) => events.push(e));
  assert.equal(state.required, null);
  noteChangedFiles(state, ["src/a.ts", "src/Nav.tsx", "src/x.css"], (e) => events.push(e));
  noteChangedFiles(state, ["src/y.css"], (e) => events.push(e));
  assert.equal(state.required, "changes UI file src/Nav.tsx");
  assert.deepEqual(events, [{ type: "design_required", reason: "changes UI file src/Nav.tsx" }]);
});

test("changedFiles lists the branch's files against its base and throws when git fails", async () => {
  const seen: string[][] = [];
  const ok: Exec = async (_cmd, args) => (seen.push(args), { stdout: "a.ts\n src/B.tsx \n\n", code: 0 });
  assert.deepEqual(await changedFiles(ok, WT, "origin/main"), ["a.ts", "src/B.tsx"]);
  assert.deepEqual(seen[0], ["diff", "--name-only", "origin/main...HEAD"]);
  const bad: Exec = async () => ({ stdout: "", code: 128, stderr: "unknown revision" });
  await assert.rejects(changedFiles(bad, WT, "origin/main"), /git diff failed: unknown revision/);
});

// ---- the handoff hook (PreToolUse on Agent) ----

test("design work: handing to Quinn before Susie is denied with a reason Maya can act on", async () => {
  const h = setup({ labels: ["design"] });
  const r = await h.handTo("quinn");
  assert.ok(h.denied(r));
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /susie must review it before quinn does/);
  assert.deepEqual(h.events, [{ type: "blocked", tool: "Agent", reason: "quinn before susie on design work" }]);
});

test("design work: Susie and Sam may always be called; Quinn is allowed once Susie has finished", async () => {
  const h = setup({ labels: ["design"] });
  assert.ok(!h.denied(await h.handTo("susie")));
  assert.ok(!h.denied(await h.handTo("sam")));
  await h.finished("sam");
  assert.ok(h.denied(await h.handTo("quinn")), "another agent finishing does not count");
  await h.finished("susie");
  assert.equal(h.state.susieRan, true);
  assert.ok(!h.denied(await h.handTo("quinn")));
});

test("the older Task tool name is held to the same rule", async () => {
  const h = setup({ labels: ["ux"] });
  assert.ok(h.denied(await h.handTo("quinn", "Task")));
});

test("not design work: Quinn is never held back, and other tools are ignored", async () => {
  const h = setup();
  assert.ok(!h.denied(await h.handTo("quinn")));
  assert.deepEqual(await h.run("PreToolUse", { tool_name: "Bash", tool_input: { command: "npm test" }, tool_use_id: "1" }), {});
  assert.deepEqual(h.events, []);
});

test("with review off (--no-review) the handoff is not enforced", async () => {
  const h = setup({ labels: ["design"], requireReview: false });
  assert.ok(!h.denied(await h.handTo("quinn")));
  assert.deepEqual(await h.stop(), {});
});

// ---- UI writes (PostToolUse) ----

test("a UI file written through a file tool makes the run design work, once", async () => {
  const h = setup();
  await h.wrote(join(WT, "src", "app.ts"));
  assert.equal(h.state.required, null);
  await h.wrote(join(WT, "src", "Header.tsx"), "Edit");
  await h.wrote(join(WT, "src", "site.css"), "MultiEdit");
  assert.equal(h.state.required, "changes UI file src/Header.tsx");
  assert.deepEqual(h.events, [{ type: "design_required", reason: "changes UI file src/Header.tsx" }]);
  assert.ok(h.denied(await h.handTo("quinn")));
});

test("UI writes from a subagent count too, and a notebook path is read from notebook_path", async () => {
  const h = setup();
  await h.run("PostToolUse", { tool_name: "Write", agent_type: "sam", tool_input: { file_path: "pages/index.html" }, tool_response: {}, tool_use_id: "3" });
  assert.equal(h.state.required, "changes UI file pages/index.html");
  const n = setup();
  await n.run("PostToolUse", { tool_name: "NotebookEdit", tool_input: { notebook_path: "a.ipynb" }, tool_response: {}, tool_use_id: "4" });
  assert.equal(n.state.required, null);
});

test("reads and test files do not make a run design work", async () => {
  const h = setup();
  await h.run("PostToolUse", { tool_name: "Read", tool_input: { file_path: "src/App.tsx" }, tool_response: {}, tool_use_id: "5" });
  await h.wrote("src/App.test.tsx");
  assert.equal(h.state.required, null);
});

// ---- the Stop hook ----

test("Stop blocks while the design handoff is pending, and clears once Susie has run", async () => {
  const h = setup({ labels: ["design"] });
  const r = await h.stop();
  assert.equal(r.decision, "block");
  assert.match(r.reason, /^Not ready to finish: this is design work \(issue labeled "design"\)/);
  await h.finished("susie");
  assert.deepEqual(await h.stop(), {});
});

test("Stop reads the committed diff, so a UI file written from the shell still needs Susie", async () => {
  const h = setup({ changed: async () => ["src/a.ts", "src/Nav.vue"] });
  const r = await h.stop();
  assert.equal(r.decision, "block");
  assert.equal(h.state.required, "changes UI file src/Nav.vue");
});

test("Stop lets Maya end on the second try (stop_hook_active); the runner's own check still applies", async () => {
  const h = setup({ labels: ["design"] });
  assert.deepEqual(await h.stop(true), {});
  assert.equal(designPending(h.state), true);
});

test("Stop with no UI changes, or a diff it cannot read, does not block", async () => {
  assert.deepEqual(await setup({ changed: async () => ["src/a.ts"] }).stop(), {});
  const h = setup({ changed: async () => { throw new Error("git diff failed"); } });
  assert.deepEqual(await h.stop(), {});
  assert.equal(h.state.required, null);
});

// ---- merging hook sets ----

test("mergeHooks keeps every set's matchers per event, in order", () => {
  const a = async () => ({});
  const b = async () => ({});
  const c = async () => ({});
  const merged = mergeHooks({ PreToolUse: [{ hooks: [a] }], Stop: [{ hooks: [b] }] }, undefined, { PreToolUse: [{ matcher: "Agent", hooks: [c] }] });
  assert.deepEqual(merged.PreToolUse!.map((m) => m.hooks[0]), [a, c]);
  assert.equal(merged.PreToolUse![1]!.matcher, "Agent");
  assert.deepEqual(merged.Stop!.map((m) => m.hooks[0]), [b]);
});
