import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");

test("package.json pins Node 24.2+ and tolerates a missing .env", () => {
  assert.equal(pkg.engines.node, ">=24.2");
  assert.match(pkg.scripts.village, /--env-file-if-exists=\.env/);
  assert.doesNotMatch(pkg.scripts.village, /--env-file=\.env/);
});

test("README states Node 24.2+ and documents exit code 2", () => {
  assert.match(readme, /Node 24\.2\+/);
  assert.match(readme, /exit(?:s)? (?:code )?2|code 2/i);
});
