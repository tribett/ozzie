import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NATIVE_TOOL_ALLOWLIST } from "../../src/harness/contract.js";
import { bundledSkills, SKILL_FILES } from "../../src/harness/bundled-skills.js";
import { ASK_SKILL, checkSkill, loadSkills, parseSkill, sha256Hex, type SkillFile } from "../../src/harness/skills.js";

const DIR = new URL("../../skills/", import.meta.url);
const file = (text: string, path = "who-could-help.md"): SkillFile => ({ path, text });
const VALID = [
  "---", "id: who-could-help", "title: Who could help", "purpose: Shows who on a role's team has no overlap found, in no particular order.",
  "tools: sunday.open_needs, sunday.who_could_help", "needs: services", "runs: on-request", "---",
  "1. Find the roles that still need people.", "2. Keep people in the order given. It is not a ranking.", "",
].join("\n");
const problems = (text: string, path?: string) => { const r = checkSkill(file(text, path)); return r.ok ? [] : r.problems; };
const withBody = (body: string) => VALID.replace(/---\n1\.[^]*$/u, `---\n${body}\n`);

describe("skill files", () => {
  it("are the six procedures, every file on disk is bundled, and each passes the checks", async () => {
    const onDisk = readdirSync(DIR).filter(f => f.endsWith(".md")).sort();
    expect(onDisk).toEqual(["answer-from-what-was-read.md", "follow-up-owners.md", "group-night.md", "room-check.md", "sunday-ready.md", "who-could-help.md"]);
    expect(SKILL_FILES.map(f => f.path).sort()).toEqual(onDisk);
    for (const f of SKILL_FILES) expect(f.text, f.path).toBe(readFileSync(new URL(f.path, DIR), "utf8"));
    const skills = await bundledSkills();
    expect([...skills.keys()].sort()).toEqual(onDisk.map(f => f.replace(/\.md$/, "")));
    for (const s of skills.values()) {
      expect(s.tools.every(t => (NATIVE_TOOL_ALLOWLIST as readonly string[]).includes(t))).toBe(true);
      expect(s.needs).toContain("services");
      expect(s.body.length).toBeGreaterThan(80);
    }
  });

  it("give Ask every read tool and no refresh, and only the room, follow-up and group procedures need Calendar, People and Groups", async () => {
    const skills = await bundledSkills();
    const ask = skills.get(ASK_SKILL)!;
    expect(ask.runs).toEqual(["on-request"]);
    expect([...ask.tools].sort()).toEqual(NATIVE_TOOL_ALLOWLIST.filter(t => t !== "planning_center.refresh").sort());
    expect(skills.get("who-could-help")!.tools).toEqual(["sunday.open_needs", "sunday.who_could_help", "drafts.prepare_note"]);
    expect(skills.get("sunday-ready")!.tools).toContain("planning_center.refresh");
    for (const id of ["room-check", "follow-up-owners", "group-night"]) expect(skills.get(id)!.needs, id).toEqual(["services", "operations"]);
    for (const id of ["sunday-ready", "who-could-help"]) expect(skills.get(id)!.needs, id).toEqual(["services"]);
  });

  it("hash the whole file with sha-256 so What happened can name the version that ran", async () => {
    const skills = await bundledSkills();
    for (const f of SKILL_FILES) {
      const id = f.path.replace(/\.md$/, "");
      expect(skills.get(id)!.hash).toBe(createHash("sha256").update(readFileSync(new URL(f.path, DIR))).digest("hex"));
    }
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("the skill checks", () => {
  it("accept a plain procedure", async () => {
    expect(problems(VALID)).toEqual([]);
    const [skill] = [...(await loadSkills([file(VALID)])).values()];
    expect(skill).toMatchObject({ id: "who-could-help", title: "Who could help", tools: ["sunday.open_needs", "sunday.who_could_help"], needs: ["services"], runs: ["on-request"] });
    expect(skill!.body).toBe("1. Find the roles that still need people.\n2. Keep people in the order given. It is not a ranking.");
    expect(parseSkill(VALID.replace("tools: sunday.open_needs, sunday.who_could_help", "tools: [sunday.open_needs, sunday.who_could_help]"))?.meta["tools"])
      .toEqual(["sunday.open_needs", "sunday.who_could_help"]);
  });

  it("reject unknown tools, missing or extra fields, and an id that isn't the file name", () => {
    expect(problems(VALID.replace("sunday.who_could_help", "email.send"))).toContain("unknown tool: email.send");
    expect(problems(VALID.replace("sunday.who_could_help", "planning_center.update"))).toContain("unknown tool: planning_center.update");
    expect(problems(VALID.replace(/^title: .*\n/m, ""))).toContain("missing title");
    expect(problems(VALID.replace(/^purpose: .*\n/m, ""))).toContain("missing purpose");
    expect(problems(VALID.replace("runs: on-request", "runs: whenever"))).toContain("unknown runs: whenever");
    expect(problems(VALID.replace("needs: services", "needs: giving"))).toContain("unknown needs: giving");
    expect(problems(VALID.replace("needs: services\n", "needs: services\nauthor: someone\n"))).toContain("unknown field: author");
    expect(problems(VALID, "other.md")).toContain("id must match the file name");
    expect(problems("no frontmatter")).toContain("missing frontmatter");
    expect(problems(withBody(""))).toContain("empty body");
  });

  it("reject a Calendar, People or Groups tool without that need", () => {
    expect(problems(VALID.replace("sunday.who_could_help", "rooms.conflicts"))).toContain("rooms.conflicts needs operations");
  });

  it("reject bodies that tell anyone to send, write back, change Planning Center, rank or score people, or write prayers", () => {
    for (const body of [
      "1. Send the draft to the person.", "- Email the team leader.", "Then text everyone on the team.", "Update Planning Center with the new time.",
      "Write back to Planning Center when done.", "2. Rank the people by how often they serve.", "Pick the best person for the role.",
      "Say who to ask first.", "Score each volunteer.", "Close with a short prayer.", "Add a scripture verse.", "Mark anyone at risk.",
      "Assign the open role.", "Please schedule the volunteer.",
    ]) expect(problems(withBody(body)).length, body).toBeGreaterThan(0);
  });

  it("allow saying what is never done", () => {
    for (const body of ["Ozzie never ranks people.", "It is not a ranking, and nobody is scored.", "Ozzie doesn't send anything; a person sends it.",
      "Nothing in Planning Center changes.", "No prayers, sermons or scripture."]) expect(problems(withBody(body)), body).toEqual([]);
  });

  it("reject words people shouldn't see under See how this works, and technical names", () => {
    for (const word of ["This skill finds roles.", "The agent reads the log.", "Uses the Planning Center connector.", "The harness decides.",
      "In this session, look again.", "Call sunday.open_needs first."]) expect(problems(withBody(word)).length, word).toBeGreaterThan(0);
    expect(problems(VALID.replace("title: Who could help", "title: Who could help skill")).length).toBeGreaterThan(0);
  });

  it("refuse to load a set with a broken file or a repeated id", async () => {
    await expect(loadSkills([file(VALID.replace("sunday.who_could_help", "email.send"))])).rejects.toThrow(/who-could-help.md: unknown tool: email.send/);
    await expect(loadSkills([file(VALID), file(VALID)])).rejects.toThrow(/repeated id/);
  });
});
