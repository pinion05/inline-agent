/**
 * Skills discovery — not injection.
 *
 * Scans ~/.inline-agent/skills/ and .inline-agent/skills/
 * Returns a short list appended to the first tool result.
 * The LLM reads skill contents via shell when it wants to.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function discoverSkills(): string[] {
  const dirs = [
    join(homedir(), ".inline-agent", "skills"),
    join(process.cwd(), ".inline-agent", "skills"),
  ];

  const skills: string[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        if (!seen.has(entry)) {
          seen.add(entry);
          skills.push(entry);
        }
      }
    } catch {
      // permission error etc — skip
    }
  }

  return skills;
}

export function skillsAnnouncement(): string | null {
  const skills = discoverSkills();
  if (skills.length === 0) return null;
  return `[skills available: ${skills.join(", ")}]`;
}
