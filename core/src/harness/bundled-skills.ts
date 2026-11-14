// The skill files that ship with Ozzie, as text. `?raw` makes Vite (the desktop webview build) and
// vitest import each file's exact contents; raw-imports.d.ts tells TypeScript. A runtime without
// Vite (a Node MCP server) reads core/skills/*.md itself and passes them to loadSkills.
import answer from "../../skills/answer-from-what-was-read.md?raw";
import followUps from "../../skills/follow-up-owners.md?raw";
import groups from "../../skills/group-night.md?raw";
import rooms from "../../skills/room-check.md?raw";
import ready from "../../skills/sunday-ready.md?raw";
import help from "../../skills/who-could-help.md?raw";
import type { Skill } from "./contract.js";
import { loadSkills, type SkillFile } from "./skills.js";

export const SKILL_FILES: readonly SkillFile[] = Object.freeze([
  { path: "answer-from-what-was-read.md", text: answer },
  { path: "follow-up-owners.md", text: followUps },
  { path: "group-night.md", text: groups },
  { path: "room-check.md", text: rooms },
  { path: "sunday-ready.md", text: ready },
  { path: "who-could-help.md", text: help },
]);

/** The shipped skills, checked and hashed. */
export const bundledSkills = (): Promise<ReadonlyMap<string, Skill>> => loadSkills(SKILL_FILES);
