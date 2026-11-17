import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// JSON lines, one object per line, appended to <dir>/events.jsonl. The directory is created eagerly
// so a record exists even when the run stops before doing any work.
export function createRunLog(dir: string): { write(e: unknown): void; path: string } {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  return {
    path,
    write(e: unknown) {
      appendFileSync(path, `${JSON.stringify(e)}\n`, "utf8");
    },
  };
}
