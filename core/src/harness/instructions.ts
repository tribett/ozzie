// System text for one agent task (harness contract RuntimeDeps.instructions): Ozzie's fixed policy
// (fixed/policy.txt), then the skill's plain-language procedure, joined exactly as
// fixed/vocabulary.json system_message.format says, so the native check can pin the whole text for each
// bundled procedure. Built here, never by the loop, and never from source data, so a changed prompt can't
// widen what the model may do; the broker and verification still enforce every rule on their own.
import type { AgentTask, Skill } from "./contract.js";
import { systemText } from "./fixed.js";
import { ASK_SKILL } from "./skills.js";

export { POLICY } from "./fixed.js";

/** Policy plus the task's procedure. Throws for a task whose procedure isn't loaded (the loop then fails it as an invalid task). */
export function instructionsFor(skills: ReadonlyMap<string, Skill>): (task: AgentTask) => string {
  return task => {
    const skill = skills.get(task.kind === "ask" ? ASK_SKILL : task.skill_id);
    if (!skill || (task.kind === "ask" && task.skill_id !== ASK_SKILL)) throw new Error("No procedure for this task.");
    return systemText(skill);
  };
}
