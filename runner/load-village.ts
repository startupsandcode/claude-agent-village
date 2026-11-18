import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

export function parseAgentFile(name: string, text: string): AgentDefinition {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") throw new Error(`${name}: missing frontmatter`);
  const end = lines.indexOf("---", 1);
  if (end === -1) throw new Error(`${name}: unterminated frontmatter`);
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!fields.description) throw new Error(`${name}: description is required`);
  const def: AgentDefinition = {
    description: fields.description,
    prompt: lines.slice(end + 1).join("\n").trim(),
  };
  if (fields.tools) {
    def.tools = fields.tools.split(",").map((t) => t.trim()).filter(Boolean);
  }
  if (fields.model) def.model = fields.model;
  return def;
}

function readAgentDir(dir: string): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};
  if (!existsSync(dir)) return agents;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
    const name = file.slice(0, -3);
    agents[name] = parseAgentFile(name, readFileSync(join(dir, file), "utf8"));
  }
  return agents;
}

export function loadVillage(villageDir: string): { maya: string; agents: Record<string, AgentDefinition> } {
  return {
    maya: readFileSync(join(villageDir, "maya.md"), "utf8"),
    agents: readAgentDir(join(villageDir, "agents")),
  };
}

// The agent name a target .md file declares: frontmatter `name:` (quotes stripped), else the filename.
// Returns null when the file has no (terminated) frontmatter, i.e. it is not an agent file.
function targetAgentName(file: string, text: string): string | null {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end === -1) return null;
  for (const line of lines.slice(1, end)) {
    const m = /^name\s*:\s*(.*?)\s*$/.exec(line);
    if (m) {
      const name = m[1]!.replace(/^(["'])(.*)\1$/, "$2").trim();
      if (name) return name;
    }
  }
  return file.replace(/\.md$/i, "");
}

// Target-agent-wins, without re-parsing the target's files: for every name the target defines that
// the village also defines, drop the village entry. The SDK then loads the target's own definition
// natively through settingSources: ["project"]. Files without frontmatter are skipped with a note.
export function mergeTargetAgents(
  village: Record<string, AgentDefinition>,
  targetAgentsDir: string,
): { agents: Record<string, AgentDefinition>; overridden: string[]; notes: string[] } {
  const agents = { ...village };
  const overridden: string[] = [];
  const notes: string[] = [];
  if (!existsSync(targetAgentsDir)) return { agents, overridden, notes };
  for (const file of readdirSync(targetAgentsDir).filter((f) => f.endsWith(".md")).sort()) {
    const name = targetAgentName(file, readFileSync(join(targetAgentsDir, file), "utf8"));
    if (name === null) {
      notes.push(`skipped ${file} in target .claude/agents: no frontmatter`);
      continue;
    }
    if (name in agents) {
      delete agents[name];
      if (!overridden.includes(name)) overridden.push(name);
    }
  }
  return { agents, overridden, notes };
}
