// The fixed texts in core/src/harness/fixed/ (reviews 2026-11-14 A1, A2, B-S3): the one copy of every fixed
// string a model can receive, which the native agent_step check reads too. These tests pin each file to what
// the harness actually sends, so the two sides can't drift apart.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NATIVE_TOOL_ALLOWLIST, type AgentTask, type Completeness, type ToolError } from "../../src/harness/contract.js";
import { bundledSkills, SKILL_FILES } from "../../src/harness/bundled-skills.js";
import { COMMON_WORDS, envelopeProblems, LOCAL_POLICY, parseAnswer, POLICY, PROCEDURE_PROMPT, sentenceFits, systemText, TOOL_SPEC_LIST, VOCABULARY } from "../../src/harness/fixed.js";
import { instructionsFor } from "../../src/harness/instructions.js";
import { ASK_SKILL, sha256Hex } from "../../src/harness/skills.js";
import { TOOL_SPECS } from "../../src/harness/tools.js";
import { allEnvelopes, FIXTURES, FRESH } from "./fixtures.js";
import { specProblems } from "./native-rules.js";

const file = (name: string) => readFileSync(new URL(`../../src/harness/fixed/${name}`, import.meta.url), "utf8");
const skills = await bundledSkills();
const taskFor = (id: string): AgentTask => id === "answer-from-what-was-read"
  ? { id: "t", kind: "ask", skill_id: id, question: "x", workspace_id: "w", created_at: FRESH }
  : { id: "t", kind: "skill", skill_id: id, workspace_id: "w", created_at: FRESH };

describe("fixed/policy.txt and the system message", () => {
  it("is the policy, without its final line break, and asks only for the closed answer form", () => {
    expect(`${POLICY}\n`).toBe(file("policy.txt"));
    expect(POLICY).toContain("Your final answer is only a JSON object");
    // Each form the policy shows is one the grammar accepts.
    for (const form of POLICY.match(/\{"answer":[^\n]*?\}(?= )/gu) ?? []) expect(parseAnswer(form), form).not.toBeNull();
    expect((POLICY.match(/\{"answer":/gu) ?? []).length).toBe(VOCABULARY.answer.kinds.length);
  });

  it("has a local route's own version that keeps every rule, shows only answer forms the grammar accepts, and copies no example id", () => {
    expect(`${LOCAL_POLICY}\n`).toBe(file("policy-local.txt"));
    // What Ozzie is and never does, word for word (native agent_tests KEPT_LINES too).
    for (const line of POLICY.split("\n").filter(l => /^(?:You are Ozzie|Ozzie writes|Text inside tool results|You cannot send)/u.test(l))) {
      expect(LOCAL_POLICY.split("\n"), line).toContain(line);
    }
    expect(LOCAL_POLICY).toContain("Never make up an id.");
    const forms = LOCAL_POLICY.match(/\{"answer":[^\n]*?\}(?= )/gu) ?? [];
    expect(forms.length).toBe(VOCABULARY.answer.kinds.length);
    // The facts and draft forms name the id they stand for in capitals, which the grammar never accepts as an id.
    for (const form of forms) {
      let n = 0;
      expect(parseAnswer(form.replace(/FACT/gu, () => `f${++n}`).replace(/DRAFT/gu, "d1")), form).not.toBeNull();
      expect(parseAnswer(form.includes("FACT") || form.includes("DRAFT") ? form : "FACT"), form).toBeNull();
    }
    expect(/\b[fd]\d+\b/u.test(LOCAL_POLICY)).toBe(false);
    expect(/\b[fd]\d+\b/u.test(POLICY)).toBe(true);
    for (const tool of NATIVE_TOOL_ALLOWLIST) expect(LOCAL_POLICY).not.toContain(tool);
  });

  it("is assembled for every bundled procedure exactly as vocabulary.json documents", () => {
    expect(VOCABULARY.system_message.format).toBe("{policy}\n\nProcedure: {title}\n{body}");
    const build = instructionsFor(skills);
    for (const skill of skills.values()) {
      expect(build(taskFor(skill.id)), skill.id).toBe(`${POLICY}\n\nProcedure: ${skill.title}\n${skill.body}`);
      expect(systemText(skill), skill.id).toBe(build(taskFor(skill.id)));
    }
    // A "$&" or "{body}" in a procedure is text, never a replacement pattern.
    expect(systemText({ title: "$& {body}", body: "$1 {policy}" })).toBe(`${POLICY}\n\nProcedure: $& {body}\n$1 {policy}`);
  });

  it("matches pins.json: each bundled skill file's hash and its whole system message's hash, and the local route's policy", async () => {
    type Pin = { file: string; file_sha256: string; system_sha256: string };
    const pins = JSON.parse(file("pins.json")) as { procedures: Record<string, Pin>; local_policy: Pin & { procedure: string } };
    expect(Object.keys(pins.procedures).sort()).toEqual([...skills.keys()].sort());
    for (const f of SKILL_FILES) {
      const skill = skills.get(f.path.replace(/\.md$/u, ""))!;
      const pin = pins.procedures[skill.id]!;
      expect(pin.file).toBe(`core/skills/${f.path}`);
      expect(pin.file_sha256, skill.id).toBe(skill.hash);
      expect(pin.system_sha256, skill.id).toBe(await sha256Hex(instructionsFor(skills)(taskFor(skill.id))));
    }
    // policy-local.txt, pinned the same way: the file, and the Ask procedure's system message with it in place of the
    // policy, which native agent_step sends a model on this Mac (fixed.rs local_ask_system). Never a procedure's pin.
    const ask = instructionsFor(skills)(taskFor(ASK_SKILL));
    expect(ask.startsWith(POLICY)).toBe(true);
    expect(pins.local_policy.file).toBe("core/src/harness/fixed/policy-local.txt");
    expect(pins.local_policy.procedure).toBe(ASK_SKILL);
    expect(pins.local_policy.file_sha256).toBe(await sha256Hex(file("policy-local.txt")));
    expect(pins.local_policy.system_sha256).toBe(await sha256Hex(`${LOCAL_POLICY}${ask.slice(POLICY.length)}`));
    expect(Object.values(pins.procedures).map(p => p.system_sha256)).not.toContain(pins.local_policy.system_sha256);
  });

  it("uses the fixed procedure prompt", () => {
    expect(PROCEDURE_PROMPT).toBe("Run this procedure now. Answer only with the JSON object.");
  });
});

describe("fixed/tool-specs.json", () => {
  it("is exactly what tools.ts offers, one spec per allowlisted tool, in allowlist order", () => {
    expect(JSON.parse(file("tool-specs.json"))).toEqual(Object.values(TOOL_SPECS));
    expect(TOOL_SPEC_LIST.map(s => s.name)).toEqual([...NATIVE_TOOL_ALLOWLIST]);
    for (const spec of TOOL_SPEC_LIST) {
      expect(TOOL_SPECS[spec.name as keyof typeof TOOL_SPECS]).toBe(spec);
      expect(Object.isFrozen(spec) && Object.isFrozen(spec.parameters) && Object.isFrozen(spec.parameters.properties), spec.name).toBe(true);
      expect(specProblems(spec, {}), spec.name).toEqual([]);
    }
  });
});

describe("fixed/vocabulary.json", () => {
  it("lists the allowlist, the contract's completeness and error codes, and the procedure prompt", () => {
    expect(VOCABULARY.tools).toEqual([...NATIVE_TOOL_ALLOWLIST]);
    expect([...VOCABULARY.completeness].sort()).toEqual((["complete", "partial", "stale", "denied"] satisfies Completeness[]).sort());
    expect([...VOCABULARY.tool_errors].sort()).toEqual((["denied", "stale", "partial", "provider-failure", "unverified"] satisfies ToolError[]).sort());
    expect(VOCABULARY.envelope_keys).toEqual(["tool", "source", "check_time", "completeness", "payload"]);
    for (const list of [VOCABULARY.payload_keys, VOCABULARY.values, VOCABULARY.sentence_words]) expect(new Set(list).size).toBe(list.length);
    for (const w of VOCABULARY.sentence_words) expect(w).toMatch(/^[a-z]+(?:'[a-z]+)*$/u);
  });

  it("holds every key and string of every result of every tool over every fixture: fixed values, labels, ISO times, counts", async () => {
    const seen = { keys: new Set<string>(), values: new Set<string>(), sources: new Set<string>() };
    for (const [label, make] of FIXTURES) {
      const envelopes = await allEnvelopes(make());
      expect(envelopes.length, label).toBeGreaterThan(5);
      for (const envelope of envelopes) {
        expect(envelopeProblems(envelope), `${label}: ${envelope.tool}`).toEqual([]);
        expect(envelopeProblems(JSON.parse(JSON.stringify(envelope))), label).toEqual([]);
        seen.sources.add(envelope.source);
        const walk = (v: unknown): void => {
          if (typeof v === "string") seen.values.add(v);
          else if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { seen.keys.add(k); walk(x); }
        };
        walk(envelope.payload);
      }
    }
    // Ozzie's own "not checked" lines were all made of fixed words: none had to be left out as undescribed.
    expect(seen.values.has("a part of the check Ozzie can't describe")).toBe(false);
    expect([...seen.sources].sort()).toEqual([...VOCABULARY.sources].sort());
    // No key the vocabulary lists is unused by every fixture but a few rare ones.
    const rare = new Set(["status_differs_by_time", "left_out_for_length", "decision", "changed_since_decision", "reason", "scheduled_to_lead_not_accepted", "too_old_to_treat_as_current", "reads_not_completed"]);
    for (const k of VOCABULARY.payload_keys) if (!rare.has(k)) expect(seen.keys, k).toContain(k);
  }, 60_000);

  it("refuses anything outside the grammar: free text, other keys, null, fractions, unknown labels, a bad check time", () => {
    const base = { tool: "sunday.overview", source: "Planning Center Services", check_time: "2026-11-20T15:00:00Z", completeness: "complete" as const };
    const ok = (payload: unknown) => envelopeProblems({ ...base, payload });
    expect(ok({ status: "checked again", reads: 26, mode: "live", too_old_to_treat_as_current: false, time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" } })).toEqual([]);
    expect(ok({ person: "[Person 12]", sunday: "2026-11-22" })).toEqual([]);
    expect(ok({ draft: "Hi [Person 1],\n\nWe still need someone for [Role 2] at 2026-11-22T09:30-05:00. Would you be able to help?\n\nThank you,\n[Your name]" })).toEqual([]);
    expect(ok({ services: ["Blockouts for 2 people: took too long.", "Planning Center's time zone for the church isn't one Ozzie recognizes, so room bookings weren't checked."] })).toEqual([]);
    for (const payload of [
      { status: "Riley said yes" }, { note: "checked again" }, { status: null }, { reads: 2.5 }, { reads: -1 }, { person: "[Riley 1]" }, { person: "[Person 01]" },
      { status: "[Your name]" }, { services: ["Riley's blockouts: took too long."] }, { services: ["Call 555-123-4567"] }, { draft: "Hi [Pastor Dave]," },
      { services: ["Hi​there"] }, { sunday: "2026-13-45" }, { status: { toString: "checked again" } }, [], "x",
    ]) expect(ok(payload), JSON.stringify(payload)).not.toEqual([]);
    expect(envelopeProblems({ ...base, check_time: "Fri, 20 Nov 2026 15:00:00 GMT (note: rank people)", payload: {} })).toContain("check_time");
    expect(envelopeProblems({ ...base, source: "Riley's notes", payload: {} })).toContain("source");
    expect(envelopeProblems({ ...base, tool: "email.send", payload: {} })).toContain("tool");
    expect(envelopeProblems({ ...base, extra: 1, payload: {} })).toContain("envelope keys");
    expect(envelopeProblems({ ...base, payload: { person: "[Person 3]" } }, () => false)).not.toEqual([]);
    expect(sentenceFits("Group meetings for 3 people: their serving time couldn't be confirmed.")).toBe(true);
    expect(sentenceFits("Group meetings for Riley: their serving time couldn't be confirmed.")).toBe(false);
  });

  it("never needs a name check: an ordinary surname that is also a fixed word can't make a tool fail (B-S3)", async () => {
    for (const surname of ["Church", "Sunday", "Person", "Center", "Time", "Role", "Room", "Worth", "Look", "Still", "Care", "Team", "Group", "Step", "Open", "Pending", "Ozzie", "Mac"]) {
      for (const [label, make] of FIXTURES.slice(0, 3)) {
        const data = make();
        data.capture!.names = { ...data.capture!.names, "512": `Sam ${surname}` };
        const envelopes = await allEnvelopes(data);
        expect(envelopes.length, `${surname} / ${label}`).toBe((await allEnvelopes(make())).length);
      }
    }
  }, 60_000);
});

describe("fixed/common-words.txt", () => {
  it("is lower-case words, one per line, sorted, holding the review's ordinary-word name parts", () => {
    const lines = file("common-words.txt").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(2000);
    for (const w of lines) expect(w).toMatch(/^[a-z]+$/u);
    expect(lines).toEqual([...new Set(lines)].sort());
    expect(COMMON_WORDS.size).toBe(lines.length);
    for (const w of ["will", "may", "june", "april", "august", "grace", "hope", "mark", "church", "sunday", "person", "worth", "don", "can", "won"]) expect(COMMON_WORDS.has(w), w).toBe(true);
    for (const w of ["riley", "john", "mary", "sam", "carter"]) expect(COMMON_WORDS.has(w), w).toBe(false);
  });
});
