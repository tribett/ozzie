import { describe, expect, it } from "vitest";
import { buildAskContext, containsNameWord, hasContactDetail, prepareAsk } from "../../src/ask.js";
import { ToolFailure } from "../../src/broker.js";
import { HARNESS_LIMITS, NATIVE_TOOL_ALLOWLIST, type ToolEnvelope } from "../../src/harness/contract.js";
import { HarnessSession, LABEL_PATTERN, restoreLabels } from "../../src/harness/session.js";
import { HarnessTools, localIso, TOOL_SPECS, type HarnessData } from "../../src/harness/tools.js";
import { CHECKED, nov22Capture, PEOPLE, SERVICE, TEAMS } from "../../src/fictional-sunday.js";
import { decide } from "../../src/sunday-decisions.js";
import { buildSundayBrief } from "../../src/sunday-brief.js";
import { FRESH, harnessData, LEAD_RULES, sourceStrings } from "./fixtures.js";

const signal = new AbortController().signal;
const tools = (data: HarnessData = harnessData(), now = FRESH) => new HarnessTools(data, new HarnessSession(), { now: () => now });
/** Fact and draft ids set aside (they are tested on their own below), so each test reads what a tool says. */
const bare = <T,>(v: T): T => (Array.isArray(v) ? v.map(bare) : v && typeof v === "object"
  ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "fact" && k !== "draft_id").map(([k, x]) => [k, bare(x)])) : v) as T;
const run = async (t: HarnessTools, name: string, args: Record<string, unknown> = {}) => bare(await t.run(name, args, signal));
/** The [Role N] label the tools gave a position. */
async function roleLabel(t: HarnessTools, name: string): Promise<string> {
  const seen = [...JSON.stringify([(await run(t, "sunday.open_needs")).payload, (await run(t, "sunday.pending_requests")).payload]).matchAll(LABEL_PATTERN)];
  const label = seen.map(m => m[0]).find(l => { const target = t.session.target(l); return target?.kind === "role" && target.name === name; });
  if (label) return label;
  throw new Error(`no label for ${name}`);
}
const stringsIn = (v: unknown): string[] => typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(stringsIn)
  : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => [k, ...stringsIn(x)]) : [];
const personOf = (t: HarnessTools, label: string) => { const target = t.session.target(label); return target?.kind === "person" ? target.id : null; };
async function failure(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof ToolFailure) return e.code; throw e; }
  throw new Error("expected a tool failure");
}

describe("tool specs", () => {
  it("define exactly the allowlisted tools, each with a fixed closed parameter object", () => {
    expect(Object.keys(TOOL_SPECS).sort()).toEqual([...NATIVE_TOOL_ALLOWLIST].sort());
    for (const [name, spec] of Object.entries(TOOL_SPECS)) {
      expect(spec.name).toBe(name);
      expect(spec.parameters.type).toBe("object");
      expect(spec.parameters.additionalProperties).toBe(false);
      for (const required of spec.parameters.required) expect(spec.parameters.properties).toHaveProperty(required);
      expect(Object.isFrozen(spec)).toBe(true);
    }
    expect(TOOL_SPECS["sunday.who_could_help"].parameters.required).toEqual(["role"]);
    expect(TOOL_SPECS["drafts.prepare_note"].parameters.required).toEqual(["person", "role"]);
    expect(Object.keys(TOOL_SPECS["sunday.overview"].parameters.properties)).toEqual([]);
  });
});

describe("times", () => {
  it("are ISO 8601 in the church's own zone, to the minute", () => {
    expect(localIso(SERVICE.starts_at, "America/New_York")).toBe("2026-11-22T09:30-05:00");
    expect(localIso("2026-07-05T14:30:00Z", "America/New_York")).toBe("2026-07-05T10:30-04:00");
    expect(localIso(SERVICE.starts_at, "UTC")).toBe("2026-11-22T14:30Z");
    expect(localIso(SERVICE.starts_at, null)).toBe("2026-11-22T14:30Z");
    expect(localIso(SERVICE.starts_at, "Not/AZone")).toBe("2026-11-22T14:30Z");
    expect(localIso("nonsense", "America/New_York")).toBeNull();
  });
});

describe("Sunday tools", () => {
  it("overview: mode, check time, source and each finding in fixed words", async () => {
    const env = await run(tools(), "sunday.overview");
    expect(env).toMatchObject({ tool: "sunday.overview", source: "Planning Center Services", check_time: CHECKED, completeness: "complete" });
    const p = env.payload as { mode: string; sunday: string; reads: number; reads_not_completed: number; findings: { kind: string }[] };
    expect(p).toMatchObject({ mode: "fictional", sunday: "2026-11-22", reads: 26, reads_not_completed: 0 });
    expect(p.findings.map(f => f.kind)).toEqual(["needs people", "needs people", "pending", "check-in suggested"]);
  });

  it("open needs: each role as a label, its time, Planning Center's remaining count and how many people were listed", async () => {
    const t = tools(harnessData({ rules: LEAD_RULES }));
    const greeter = await roleLabel(t, "Greeter");
    const p = (await run(t, "sunday.open_needs")).payload as { needs: Record<string, unknown>[] };
    const need = p.needs.find(n => n["role"] === greeter)!;
    expect(need).toMatchObject({
      kind: "needs people", remaining: 1, time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" },
      people_listed: { no_overlap_found: 1, possible_conflict: 1, needs_confirmation: 1, left_out: 2 }, team_leaders: "none listed",
    });
    expect(p.needs.find(n => n["kind"] === "no scheduled lead")).toMatchObject({ team_leaders: [expect.stringMatching(/^\[Person \d+\]$/)] });
  });

  it("who could help: everyone on the role's team in Planning Center id order, never ranked, with fixed status words", async () => {
    const t = tools();
    const role = await roleLabel(t, "Greeter");
    const env = await run(t, "sunday.who_could_help", { role });
    const p = env.payload as { asked_for: { role: string }; people: { person: string; status: string; reasons?: string[] }[]; order: string; willingness: string };
    expect(p.asked_for).toEqual({ role });
    // Person-id order (review N4): label numbers follow the order Ask first met people, so they aren't used to order.
    const ids = p.people.map(x => personOf(t, x.person)!);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
    const byId = Object.fromEntries(p.people.map(x => [personOf(t, x.person), x]));
    expect(byId[PEOPLE.riley]).toEqual({ role, person: expect.any(String), status: "no overlap found" });
    expect(byId[PEOPLE.casey]).toMatchObject({ status: "possible conflict", reasons: ["pending elsewhere at this time"] });
    expect(byId[PEOPLE.drew]).toMatchObject({ status: "availability needs confirmation", reasons: ["a blockout couldn't be checked"] });
    expect(byId[PEOPLE.sam]).toMatchObject({ status: "left out", reasons: ["a blockout covers this time"] });
    expect(byId[PEOPLE.morgan]).toMatchObject({ status: "left out", reasons: ["confirmed elsewhere at this time"] });
    expect(Object.keys(byId)).toHaveLength(5);
    expect(p.order).toBe("in no particular order, not ranked");
    expect(p.willingness).toMatch(/only the person can say/);
  });

  it("give every fact an id, numbered in order within one task, and a draft its own id (structured answers)", async () => {
    const t = tools();
    const role = await roleLabel(t, "Greeter");
    const first = await t.run("sunday.who_could_help", { role }, signal, "task-a");
    const p = first.payload as { fact: string; times: { fact: string }[]; people: { fact: string; person: string }[]; asked_for: Record<string, unknown> };
    expect(p.fact).toBe("f1");
    expect(p.times.map(x => x.fact)).toEqual(["f2"]);
    expect(p.people.map(x => x.fact)).toEqual(["f3", "f4", "f5", "f6", "f7"]);
    expect(p.asked_for).toEqual({ role });
    // The next tool of the same task goes on; another task starts again at f1.
    const next = await t.run("sunday.pending_requests", {}, signal, "task-a");
    expect((next.payload as { fact: string }).fact).toBe("f8");
    expect(((await t.run("sunday.overview", {}, signal, "task-b")).payload as { fact: string }).fact).toBe("f1");
    const riley = p.people.find(x => personOf(t, x.person) === PEOPLE.riley)!.person;
    const draft = (await t.run("drafts.prepare_note", { person: riley, role }, signal, "task-a")).payload as Record<string, unknown>;
    expect(draft["draft_id"]).toBe("d1");
    expect(draft["fact"]).toBeUndefined();
    // No draft (someone not listed for the role): the result is a fact instead.
    const pending = (await t.run("sunday.pending_requests", {}, signal, "task-a")).payload as { pending: { person: string }[] };
    const none = (await t.run("drafts.prepare_note", { person: pending.pending[0]!.person, role }, signal, "task-a")).payload as Record<string, unknown>;
    expect(none["fact"]).toMatch(/^f\d+$/u);
    expect(none["draft_id"]).toBeUndefined();
    expect(none["status"]).toBe("no draft prepared");
  });

  it("who could help: the same order however Ask numbered the people first (N4)", async () => {
    const data = harnessData();
    const t = tools(data);
    // Ask labels the people it lists in its own (status) order before any tool runs.
    const context = buildAskContext(t.session.ask, { brief: data.brief, names: data.capture!.names, organization: data.capture!.organization })!;
    expect(prepareAsk(t.session.ask, context, "Who could cover Greeter?").ok).toBe(true);
    const role = await roleLabel(t, "Greeter");
    const p = (await run(t, "sunday.who_could_help", { role })).payload as { people: { person: string }[] };
    expect(p.people.map(x => personOf(t, x.person))).toEqual([PEOPLE.riley, PEOPLE.sam, PEOPLE.morgan, PEOPLE.casey, PEOPLE.drew].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
  });

  it("who could help: a role with no open need says so", async () => {
    const t = tools();
    const lyrics = await roleLabel(t, "Lyrics");
    expect((await run(t, "sunday.who_could_help", { role: lyrics })).payload).toMatchObject({ asked_for: { role: lyrics }, open_need: "none in the last check", people: [] });
  });

  it("pending requests and check-ins: labels, fixed request words and the rule's own threshold", async () => {
    const t = tools();
    const pending = (await run(t, "sunday.pending_requests")).payload as { pending: { person: string; request: string }[] };
    expect(pending.pending).toHaveLength(1);
    expect(personOf(t, pending.pending[0]!.person)).toBe(PEOPLE.lyricsPending);
    expect(pending.pending[0]!.request).toBe("request not sent yet");
    const checkins = (await run(t, "sunday.rule_checkins")).payload as { check_in_after_sundays_in_a_row: number; check_ins: { person: string; sundays_in_a_row: number }[] };
    expect(checkins.check_in_after_sundays_in_a_row).toBe(3);
    expect(checkins.check_ins.map(c => [personOf(t, c.person), c.sundays_in_a_row])).toEqual([[PEOPLE.greeterConfirmed, 3]]);
  });

  it("not checked: what the check couldn't read, never an all-clear", async () => {
    const p = (await run(tools(), "sunday.not_checked")).payload as { services: string[]; rooms_follow_ups_groups: string[] };
    expect(p.services).toContain("Whether someone is willing to serve isn't something Planning Center records.");
    const off = (await run(tools(harnessData({ granted: ["services"] })), "sunday.not_checked")).payload as typeof p;
    expect(off.rooms_follow_ups_groups).toEqual(["Rooms, follow-ups and group meetings are not part of this connection."]);
  });

  it("decisions a person made show as fixed words, never the reason they typed", async () => {
    const data = harnessData();
    const need = data.brief!.findings.find(f => f.kind === "needs-people")!;
    const decided = harnessData({ decisions: [decide(need, "covered-outside", "Riley Thornbury's mom said she'd do it", CHECKED)] });
    const p = (await run(tools(decided), "sunday.open_needs")).payload as { needs: Record<string, unknown>[] };
    expect(p.needs[0]).toMatchObject({ decision: "covered outside Planning Center", changed_since_decision: false });
    expect(JSON.stringify(p)).not.toMatch(/mom|Riley/i);
  });
});

describe("rooms, follow-ups and group meetings", () => {
  it("rooms: the overlapping bookings under the church's room rule", async () => {
    const t = tools();
    const env = await run(t, "rooms.conflicts");
    expect(env).toMatchObject({ source: "Planning Center Calendar", completeness: "complete" });
    const p = env.payload as { status: string; rooms: Record<string, unknown>[] };
    expect(p.status).toBe("room use needs review");
    expect(p.rooms).toEqual([{
      room: "[Room 1]", label: "Room use needs review", overlap: { starts_at: "2026-11-22T10:30-05:00", ends_at: "2026-11-22T11:00-05:00" },
      bookings: [
        { time: { starts_at: "2026-11-22T09:00-05:00", ends_at: "2026-11-22T11:00-05:00" }, approval: "approved" },
        { time: { starts_at: "2026-11-22T10:45-05:00", ends_at: "2026-11-22T11:15-05:00" }, approval: "approved" },
      ],
      setup_minutes: 15, church_rule: "not shared", worked_out_in_planning_center: "not worked out",
    }]);
  });

  it("follow-ups: overdue ones with no owner, as workflow and step labels", async () => {
    const env = await run(tools(), "followups.unowned");
    expect(env.source).toBe("Planning Center People");
    expect(env.payload).toMatchObject({ status: "needs an owner", follow_ups: [{ workflow: "[Workflow 1]", step: "[Step 1]", due: "2026-10-26T17:27-04:00", label: "Follow-up needs an owner" }] });
  });

  it("group meetings: the same person label as their pending assignment", async () => {
    const t = tools();
    const pending = (await run(t, "sunday.pending_requests")).payload as { pending: { person: string; role: string }[] };
    const env = await run(t, "groups.clashes");
    expect(env.source).toBe("Planning Center Groups");
    expect(env.payload).toMatchObject({ clashes: [{ person: pending.pending[0]!.person, serving: [{ role: pending.pending[0]!.role, status: "pending" }],
      group_meetings: [{ time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" } }], label: "Worth a look" }] });
  });

  it("are denied when the connection wasn't granted Calendar, People and Groups", async () => {
    for (const name of ["rooms.conflicts", "followups.unowned", "groups.clashes"]) {
      const env = await run(tools(harnessData({ granted: ["services"] })), name);
      expect(env.completeness, name).toBe("denied");
      expect(env.payload, name).toEqual({ status: "not granted" });
    }
  });

  it("say they weren't checked when the reads were turned off", async () => {
    const env = await run(tools(harnessData({ operationsOff: true })), "rooms.conflicts");
    expect(env.completeness).toBe("partial");
    expect((env.payload as { status: string }).status).toBe("not fully checked");
  });
});

describe("today, rules, refresh and drafts", () => {
  it("today: the fictional import as codes and labels only, and only beside the fictional example", async () => {
    const env = await run(tools(), "today.attention");
    expect(env.source).toBe("Fictional email and calendar import");
    expect(env.payload).toMatchObject({ items: [{ event: "[Event 1]", kind: "a message says the room is unavailable while the calendar still lists it",
      starts_at: "2026-11-19T19:00-05:00", volunteers_contacted: "not contacted, according to the message" }] });
    expect(JSON.stringify(env)).not.toMatch(/ignore your rules|plumbing|orientation|fellowship/i);
    expect(await failure(run(tools(harnessData({ mode: "live" })), "today.attention"))).toBe("unverified");
  });

  it("rules: the Church rules Ozzie applied, as labels and numbers", async () => {
    const env = await run(tools(harnessData({ rules: LEAD_RULES })), "rules.current");
    expect(env.source).toBe("Church rules on this Mac");
    expect(env.payload).toEqual({
      check_in_after_sundays_in_a_row: 3, sunday_leads: [{ lead_role: expect.stringMatching(/^\[Role \d+\]$/) }],
      rooms: [{ room: "[Room 1]", rule: "not shared", setup_minutes: 15 }],
    });
  });

  it("refresh: runs the native Sunday check and later tools read the new check", async () => {
    let calls = 0;
    const later = harnessData({ mode: "live", capture: { ...nov22Capture(), reads: nov22Capture().reads.map(r => ({ ...r, checked_at: "2026-11-20T16:00:00Z" })) }, now: "2026-11-20T16:01:00Z" });
    const t = new HarnessTools(harnessData({ mode: "live", connected: true, refresh: async s => { calls++; expect(s).toBe(signal); return later; } }),
      new HarnessSession(), { now: () => "2026-11-20T16:01:00Z" });
    expect((await run(t, "sunday.overview")).completeness).toBe("stale");
    const env = await run(t, "planning_center.refresh");
    expect(calls).toBe(1);
    expect(env).toMatchObject({ check_time: "2026-11-20T16:00:00Z", completeness: "complete", payload: { status: "checked again", reads: 26, reads_not_completed: 0 } });
    expect(t.data).toBe(later);
    expect((await run(t, "sunday.overview")).check_time).toBe("2026-11-20T16:00:00Z");
    expect(await failure(run(tools(), "planning_center.refresh"))).toBe("denied");
    const broken = new HarnessTools(harnessData({ mode: "recording", connected: true, refresh: () => Promise.reject(new Error("offline")) }), new HarnessSession());
    expect(await failure(run(broken, "planning_center.refresh"))).toBe("provider-failure");
  });

  it("refresh: only reads again when the last check is out of date or a recording (B-S8)", async () => {
    let calls = 0;
    const refresh = async () => { calls++; return harnessData({ mode: "live", connected: true }); };
    const current = await run(tools(harnessData({ mode: "live", connected: true, refresh })), "planning_center.refresh");
    expect(current.payload).toMatchObject({ status: "not needed; the last check is current" });
    expect(calls).toBe(0);
    await run(tools(harnessData({ mode: "recording", connected: true, refresh })), "planning_center.refresh");
    await run(tools(harnessData({ mode: "live", connected: true, refresh }), "2026-11-20T16:00:00Z"), "planning_center.refresh");
    expect(calls).toBe(2);
  });

  it("drafts: Ozzie's own wording with labels, a draft a person sends", async () => {
    const t = tools();
    const role = await roleLabel(t, "Greeter");
    const people = (await run(t, "sunday.who_could_help", { role })).payload as { people: { person: string; status: string }[] };
    const riley = people.people.find(p => personOf(t, p.person) === PEOPLE.riley)!.person;
    const env = await run(t, "drafts.prepare_note", { person: riley, role });
    expect(env.payload).toEqual({
      asked_for: { person: riley, role },
      draft: `Hi ${riley},\n\nWe still need someone for ${role} at 2026-11-22T09:30-05:00. Would you be able to help?\n\nIt's completely fine to say no. Just let me know either way so we can plan.\n\nThank you,\n[Your name]`,
      status: "draft only; nothing has been sent", listed_for_role: "no overlap found",
    });
    const restored = restoreLabels((env.payload as { draft: string }).draft, t.session, { names: t.data.capture!.names, sender: "Pat", firstNames: true, timeZone: "America/New_York" });
    expect(restored).toMatch(/^Hi Riley,\n\nWe still need someone for Greeter at 9:30 AM on November 22\./);
    expect(restored).toMatch(/Thank you,\nPat$/);
  });

  it("drafts: none for someone the check didn't list for that role's open need, or for a role with no open need (B-S1, N3)", async () => {
    const t = tools();
    const greeter = await roleLabel(t, "Greeter");
    const pending = (await run(t, "sunday.pending_requests")).payload as { pending: { role: string; person: string }[] };
    const lyricsPerson = pending.pending[0]!.person, lyrics = pending.pending[0]!.role;
    // The Lyrics volunteer is a real, issued label, but not on the Greeter team; Lyrics has no open need at all.
    for (const [person, role] of [[lyricsPerson, greeter], [lyricsPerson, lyrics]] as const) {
      const env = await run(t, "drafts.prepare_note", { person, role });
      expect(env.payload).toEqual({ asked_for: { person, role }, status: "no draft prepared", reason: "not listed for an open need of this role" });
    }
  });
});

describe("every tool result", () => {
  const all = async (t: HarnessTools) => {
    const out: ToolEnvelope[] = [];
    for (const name of NATIVE_TOOL_ALLOWLIST) {
      if (name === "sunday.who_could_help" || name === "drafts.prepare_note" || name === "planning_center.refresh") continue;
      out.push(await run(t, name));
    }
    for (const role of ["Greeter", "Nursery", "Lyrics"]) {
      const label = await roleLabel(t, role);
      const env = await run(t, "sunday.who_could_help", { role: label });
      out.push(env);
      for (const p of (env.payload as { people: { person: string }[] }).people) out.push(await run(t, "drafts.prepare_note", { person: p.person, role: label }));
    }
    return out;
  };

  it("is placeholder-only: no name, position name, place name, typed reason, imported text or contact detail", async () => {
    const need = harnessData({ rules: LEAD_RULES }).brief!.findings.find(f => f.kind === "needs-people")!;
    const data = harnessData({ rules: LEAD_RULES, decisions: [decide(need, "covered-outside", "Sam's cousin Pat said yes, call 555-123-4567", CHECKED)] });
    const t = tools(data);
    for (const env of await all(t)) {
      const text = JSON.stringify(env);
      expect(containsNameWord(text, data.capture!.names), text).toBe(false);
      expect(hasContactDetail(text), text).toBe(false);
      for (const s of sourceStrings(data)) expect(text.toLowerCase(), s).not.toContain(s.toLowerCase());
      for (const m of stringsIn(env).join("\n").matchAll(/\[[^\]\n]*\]/g)) expect(t.session.has(m[0]) || m[0] === "[Your name]", m[0]).toBe(true);
      expect(text.length).toBeLessThanOrEqual(HARNESS_LIMITS.envelopeChars);
    }
  });

  it("keeps a person's label across tools and across Ask questions in the same session", async () => {
    const data = harnessData();
    const t = tools(data);
    const role = await roleLabel(t, "Greeter");
    const people = (await run(t, "sunday.who_could_help", { role })).payload as { people: { person: string }[] };
    const riley = people.people.find(p => personOf(t, p.person) === PEOPLE.riley)!.person;
    const context = buildAskContext(t.session.ask, { brief: data.brief, names: data.capture!.names, organization: data.capture!.organization })!;
    const asked = prepareAsk(t.session.ask, context, "Is Riley free for Greeter?");
    expect(asked.ok && asked.asked.sent).toBe(`Is ${riley} free for ${role}?`);
  });

  it("labels a position whose name holds a roster name, and never sends it", async () => {
    const capture = nov22Capture();
    for (const r of capture.reads) for (const row of [...(Array.isArray(r.body?.data) ? r.body.data : []), ...(r.body?.included ?? [])] as { attributes?: Record<string, unknown> }[]) {
      if (row.attributes?.["team_position_name"] === "Greeter") row.attributes["team_position_name"] = "Riley's Welcome Team";
      if (row.attributes?.["name"] === "Greeter") row.attributes["name"] = "Riley's Welcome Team";
    }
    const data = harnessData({ capture });
    const t = tools(data);
    const label = await roleLabel(t, "Riley's Welcome Team");
    const env = await run(t, "sunday.who_could_help", { role: label });
    expect(JSON.stringify(env)).not.toMatch(/riley|welcome/i);
    expect((env.payload as { people: unknown[] }).people).toHaveLength(5);
  });

  it("says how complete it is: stale for a recording or an old live check, partial when a read didn't complete", async () => {
    expect((await run(tools(harnessData({ mode: "recording" })), "sunday.overview")).completeness).toBe("stale");
    expect((await run(tools(harnessData({ mode: "live" })), "sunday.overview")).completeness).toBe("complete");
    expect((await run(tools(harnessData({ mode: "live" }), "2026-11-20T15:31:00Z"), "sunday.overview")).completeness).toBe("stale");
    const capture = nov22Capture();
    capture.reads = capture.reads.map(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.riley ? { ...r, outcome: "timeout" } : r);
    const partial = await run(tools(harnessData({ mode: "live", capture })), "sunday.overview");
    expect(partial.completeness).toBe("partial");
    expect(partial.payload).toMatchObject({ reads_not_completed: 1 });
  });

  it("fails as unverified when nothing has been checked yet", async () => {
    const empty: HarnessData = { ...harnessData(), capture: null, brief: null, operations: null };
    expect(await failure(run(tools(empty), "sunday.overview"))).toBe("unverified");
  });

  it("refuses an unknown tool or a label it never issued", async () => {
    expect(await failure(run(tools(), "planning_center.update"))).toBe("denied");
    expect(await failure(run(tools(), "sunday.who_could_help", { role: "[Role 99]" }))).toBe("denied");
  });

  it("stays within the envelope size for a large team, saying how many were left out", async () => {
    const capture = nov22Capture();
    const team = capture.reads.find(r => r.collection === "team_position_assignments" && r.team_id === TEAMS.greeter)!;
    const ids = Array.from({ length: 300 }, (_, i) => String(10_000 + i));
    team.body!.data = ids.map((p, i) => ({ type: "PersonTeamPositionAssignment", id: `x${i}`, attributes: {},
      relationships: { person: { data: { type: "Person", id: p } }, team_position: { data: { type: "TeamPosition", id: "601" } } } }));
    for (const id of ids) {
      capture.names[id] = `Qx${id} Zyv${id}`;
      capture.reads.push({ collection: "person_schedules", person_id: id, offset: 0, checked_at: CHECKED, outcome: "ok", body: { data: [], included: [] } },
        { collection: "person_blockouts", person_id: id, offset: 0, checked_at: CHECKED, outcome: "ok", body: { data: [] } });
    }
    const data = harnessData({ capture });
    expect(buildSundayBrief(data.capture!, data.rules, FRESH, true).findings[0]!.people!.suggestions.length).toBe(300);
    const t = tools(data);
    const env = await run(t, "sunday.who_could_help", { role: await roleLabel(t, "Greeter") });
    expect(JSON.stringify(env).length).toBeLessThanOrEqual(HARNESS_LIMITS.envelopeChars);
    expect(env.completeness).toBe("partial");
    const p = env.payload as { people: unknown[]; left_out_for_length: number };
    expect(p.people.length + p.left_out_for_length).toBe(300);
  });
});
