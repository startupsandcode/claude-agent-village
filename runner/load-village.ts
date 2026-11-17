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

export function mergeTargetAgents(
  village: Record<string, AgentDefinition>,
  targetAgentsDir: string,
): { agents: Record<string, AgentDefinition>; overridden: string[] } {
  const target = readAgentDir(targetAgentsDir);
  const overridden = Object.keys(target).filter((n) => n in village);
  return { agents: { ...village, ...target }, overridden };
}
