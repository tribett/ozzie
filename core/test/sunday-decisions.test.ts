import { describe, expect, it } from "vitest";
import { buildSundayBrief, leadKey, needKey, type Finding, type SundayBrief } from "../src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../src/sunday-capture.js";
import { LATER, nov22Capture, nov22LaterCapture, PEOPLE, TEAMS } from "../src/fictional-sunday.js";
import {
  applyDecisions, changeText, decide, decisionsStorageKey, loadDecisions, openCount, REASON_MAX, saveDecisions,
  withDecision, withoutDecision, type Change, type KeyValueStore, type SundayDecision,
} from "../src/sunday-decisions.js";

const AT = "2026-11-20T15:10:00Z";
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const brief = (capture: SundayCapture = nov22Capture(), r = rules, now = capture.completed_at) => buildSundayBrief(capture, r, now);
const need = (b: SundayBrief, name: string) => b.findings.find(f => f.kind === "needs-people" && f.position!.name === name)!;
const item = (b: SundayBrief, decisions: SundayDecision[], key: string) => applyDecisions(b, decisions).items.find(i => i.finding.key === key)!;
type Row = { id: string; type: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> };
const rowsOf = (capture: SundayCapture, collection: string) => capture.reads.find(r => r.collection === collection)!.body!.data as Row[];
const names = nov22Capture().names;
const nameOf = (id: string) => names[id] ?? "Someone";

describe("a Sunday-only decision", () => {
  it("needs a short reason, trimmed", () => {
    const f = need(brief(), "Nursery");
    expect(() => decide(f, "covered-outside", "   ", AT)).toThrow(/short reason/);
    expect(() => decide(f, "covered-outside", "x".repeat(REASON_MAX + 1), AT)).toThrow(/shorter/);
    expect(decide(f, "covered-outside", "  Jordan's daughter is covering  ", AT)).toMatchObject({
      key: needKey(TEAMS.nursery, "Nursery"), kind: "needs-people", choice: "covered-outside", reason: "Jordan's daughter is covering", decided_at: AT,
      subject: { team_id: TEAMS.nursery, name: "Nursery" }, facts: { remaining: 1, confirmed: [PEOPLE.nurseryConfirmed], suggestions: [] }, earlier: [],
    });
  });

  it("offers only the choices that fit the finding; an incomplete check can never be resolved", () => {
    const b = brief(nov22Capture(), { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] });
    expect(() => decide(need(b, "Greeter"), "lead-expected", "no", AT)).toThrow();
    const lead = b.findings.find(f => f.kind === "lead-missing")!;
    expect(decide(lead, "lead-expected", "Jordan leads from the hallway", AT).key).toBe(leadKey(TEAMS.nursery));
    expect(() => decide(lead, "not-needed", "no", AT)).toThrow();
    for (const kind of ["pending", "streak"] as const) expect(() => decide(b.findings.find(f => f.kind === kind)!, "not-needed", "ok", AT)).toThrow();
    const failed = nov22Capture();
    failed.reads.find(r => r.collection === "plan_times")!.outcome = "timeout";
    expect(() => decide(brief(failed).findings.find(f => f.kind === "worth-a-look")!, "covered-outside", "it's fine", AT)).toThrow();
  });

  it("shows as resolved by you, never as source-confirmed, and stops needing a decision", () => {
    const b = brief();
    const d = decide(need(b, "Greeter"), "covered-outside", "Pat will greet", AT);
    const view = applyDecisions(b, [d]);
    const greeter = view.items.find(i => i.finding.key === d.key)!;
    expect(greeter).toMatchObject({ state: "resolved", decision: d, changes: [] });
    expect(view.history).toEqual([]);
    expect(openCount(applyDecisions(b, []))).toEqual({ decisions: 2, looks: 2, resolved: 0 });
    expect(openCount(view)).toEqual({ decisions: 1, looks: 2, resolved: 1 });
  });
});

describe("reopening after a later check", () => {
  it("a duplicate or irrelevant refresh keeps it resolved", () => {
    const d = decide(need(brief(), "Greeter"), "covered-outside", "Pat will greet", AT);
    expect(item(brief(nov22Capture(), rules, "2026-11-20T15:20:00Z"), [d], d.key).state).toBe("resolved");
    // Two hours later Nursery changed, but nothing about Greeter did.
    expect(item(brief(nov22LaterCapture()), [d], d.key)).toMatchObject({ state: "resolved", changes: [] });
    // A Church-rule change that adds an unrelated finding doesn't reopen it either.
    expect(item(brief(nov22Capture(), { ...rules, checkInAfterSundaysInARow: 2 }), [d], d.key).state).toBe("resolved");
  });

  it("a confirmed volunteer declining and the need rising reopens it, with the earlier reason kept", () => {
    const d = decide(need(brief(), "Nursery"), "not-needed", "Only two babies registered", AT);
    const later = item(brief(nov22LaterCapture()), [d], d.key);
    expect(later.state).toBe("reopened");
    expect(later.decision?.reason).toBe("Only two babies registered");
    expect(later.changes).toEqual([
      { code: "need-up", from: 1, to: 2 },
      { code: "confirmed-lost", person_ids: [PEOPLE.nurseryConfirmed] },
    ]);
    expect(later.changes.map(c => changeText(c, nameOf))).toEqual([
      "Planning Center now shows 2 remaining requests; it was 1 when you decided.",
      "Blake Ashgrove is no longer confirmed in Planning Center.",
    ]);
    expect(openCount(applyDecisions(brief(nov22LaterCapture()), [d])).decisions).toBe(2);
  });

  it("a change in who could help reopens it", () => {
    const d = decide(need(brief(), "Greeter"), "covered-outside", "Pat will greet", AT);
    const capture = nov22Capture();
    const riley = capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.riley)!;
    riley.body = { data: [{ type: "Blockout", id: "803", attributes: { starts_at: "2026-11-22T13:00:00Z", ends_at: "2026-11-22T17:00:00Z", repeat_frequency: "no_repeat" } }] };
    const changed = item(brief(capture), [d], d.key);
    expect(changed).toMatchObject({ state: "reopened", changes: [{ code: "suggestions-changed", added: [], removed: [PEOPLE.riley] }] });
    expect(changeText(changed.changes[0]!, nameOf)).toBe("Who could help changed: Riley Thornbury is no longer clear for this time.");
  });

  it("a need that went down is not a reason to bring it back", () => {
    const d = decide(need(brief(nov22LaterCapture()), "Nursery"), "covered-outside", "Two parents are covering", AT);
    const capture = nov22LaterCapture();
    (rowsOf(capture, "needed_positions").find(n => n.attributes.team_position_name === "Nursery")!.attributes).quantity = 1;
    expect(item(brief(capture), [d], d.key).state).toBe("resolved");
  });

  it("follows the finding by team and position, not by row order", () => {
    const d = decide(need(brief(), "Nursery"), "not-needed", "Combined with the 11:00", AT);
    const capture = nov22LaterCapture();
    rowsOf(capture, "needed_positions").reverse();
    expect(item(brief(capture), [d], d.key).state).toBe("reopened");
  });

  it("deciding again keeps every earlier reason", () => {
    const first = decide(need(brief(), "Nursery"), "not-needed", "Only two babies registered", AT);
    const again = decide(need(brief(nov22LaterCapture()), "Nursery"), "covered-outside", "Jordan will cover", LATER, first);
    expect(again.earlier).toEqual([{ choice: "not-needed", reason: "Only two babies registered", decided_at: AT }]);
    expect(item(brief(nov22LaterCapture()), [again], again.key).state).toBe("resolved");
    expect(withDecision([first], again)).toEqual([again]);
    expect(withoutDecision([first], first.key)).toEqual([]);
  });

  it("a scheduled lead dropping off reopens an 'expected' lead decision", () => {
    const leadRules = { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] };
    const capture = nov22Capture();
    rowsOf(capture, "team_members").push({ type: "PlanPerson", id: "404", attributes: { status: "U", team_position_name: "Nursery Lead", notification_sent_at: "2026-11-01T12:00:00Z" },
      relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryLeader } }, team: { data: { type: "Team", id: TEAMS.nursery } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
    const d = decide(brief(capture, leadRules).findings.find(f => f.kind === "lead-missing")!, "lead-expected", "Jordan said she'd confirm Saturday", AT);
    expect(item(brief(capture, leadRules), [d], d.key).state).toBe("resolved");
    (rowsOf(capture, "team_members").find(m => m.id === "404")!.attributes).status = "D";
    const later = item(brief(capture, leadRules), [d], d.key);
    expect(later).toMatchObject({ state: "reopened", changes: [{ code: "lead-lost", person_ids: [PEOPLE.nurseryLeader] }] });
    expect(changeText(later.changes[0]!, nameOf)).toBe("Jordan Ashdown no longer has a pending request to lead.");
  });
});

describe("when the source changes underneath a decision", () => {
  const filled = (status: "C" | "U") => {
    const capture = nov22Capture();
    const needs = rowsOf(capture, "needed_positions");
    needs.splice(needs.findIndex(n => n.attributes.team_position_name === "Nursery"), 1);
    rowsOf(capture, "team_members").push({ type: "PlanPerson", id: "406", attributes: { status, team_position_name: "Nursery", notification_sent_at: "2026-11-20T16:00:00Z" },
      relationships: { person: { data: { type: "Person", id: "590" } }, team: { data: { type: "Team", id: TEAMS.nursery } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
    return brief(capture);
  };
  const d = () => decide(need(brief(), "Nursery"), "covered-outside", "Jordan will cover", AT);

  it("a gap Planning Center now shows filled is source-confirmed, and the manual note is kept as history", () => {
    const view = applyDecisions(filled("C"), [d()]);
    expect(view.items.some(i => i.finding.key === d().key)).toBe(false);
    expect(view.history).toEqual([{ decision: d(), status: "source-confirmed", checked_at: filled("C").checked_at }]);
  });

  it("filled only by someone pending is not called confirmed", () => {
    expect(applyDecisions(filled("U"), [d()]).history[0]!.status).toBe("filled-pending");
  });

  it("a read that didn't complete never turns into confirmation", () => {
    const capture = nov22Capture();
    capture.reads.find(r => r.collection === "needed_positions")!.outcome = "timeout";
    expect(applyDecisions(brief(capture), [d()]).history[0]!.status).toBe("couldnt-recheck");
    const stale = buildSundayBrief(nov22Capture(), rules, "2026-11-20T18:00:00Z");
    expect(applyDecisions(stale, [d()]).history[0]!.status).toBe("couldnt-recheck");
  });

  it("a position Planning Center no longer lists is said plainly, not as filled", () => {
    const capture = nov22Capture();
    const needs = rowsOf(capture, "needed_positions");
    needs.splice(needs.findIndex(n => n.attributes.team_position_name === "Nursery"), 1);
    const members = rowsOf(capture, "team_members");
    members.splice(members.findIndex(m => m.id === "402"), 1);
    expect(applyDecisions(brief(capture), [d()]).history[0]!.status).toBe("not-listed");
  });

  it("a confirmed lead in Planning Center confirms a lead decision", () => {
    const leadRules = { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] };
    const lead = decide(brief(nov22Capture(), leadRules).findings.find(f => f.kind === "lead-missing")!, "lead-expected", "Expected", AT);
    const capture = nov22Capture();
    rowsOf(capture, "team_members").push({ type: "PlanPerson", id: "407", attributes: { status: "C", team_position_name: "Nursery Lead", notification_sent_at: "2026-11-01T12:00:00Z" },
      relationships: { person: { data: { type: "Person", id: PEOPLE.nurseryLeader } }, team: { data: { type: "Team", id: TEAMS.nursery } }, times: { data: [{ type: "PlanTime", id: "9001" }] } } });
    expect(applyDecisions(brief(capture, leadRules), [lead]).history[0]!.status).toBe("source-confirmed");
    // The Church rule was turned off: the note stays stored but there's nothing to show.
    expect(applyDecisions(brief(nov22Capture(), rules), [lead]).history).toEqual([]);
  });
});

describe("kept on this Mac per organization and Sunday", () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: k => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
  };
  it("is keyed by organization and plan, with the fictional example kept apart", () => {
    expect(decisionsStorageKey("live", "1001", "92902197")).not.toBe(decisionsStorageKey("live", "1001", "92902198"));
    expect(decisionsStorageKey("live", "1001", "92902197")).not.toBe(decisionsStorageKey("live", "1002", "92902197"));
    expect(decisionsStorageKey("fictional", "1001", "92902197")).not.toBe(decisionsStorageKey("live", "1001", "92902197"));
    expect(decisionsStorageKey("recording", "1001", "92902197")).toBe(decisionsStorageKey("live", "1001", "92902197"));
  });

  it("round-trips, and ignores anything unreadable or malformed", () => {
    const store = memory();
    const key = decisionsStorageKey("live", "1001", "92902197");
    const d = decide(need(brief(), "Nursery"), "covered-outside", "Jordan will cover", AT);
    expect(saveDecisions(store, key, [d])).toBe(true);
    expect(loadDecisions(store, key)).toEqual([d]);
    store.data.set(key, "{not json");
    expect(loadDecisions(store, key)).toEqual([]);
    store.data.set(key, JSON.stringify([d, { ...d, choice: "approved" }, { ...d, reason: "" }, { ...d, kind: "pending" }, null, 7]));
    expect(loadDecisions(store, key)).toEqual([d]);
    const broken: KeyValueStore = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
    expect(loadDecisions(broken, key)).toEqual([]);
    expect(saveDecisions(broken, key, [d])).toBe(false);
    expect(loadDecisions(null, key)).toEqual([]);
  });

  it("stores no person's name, only ids and the reason the person typed", () => {
    const d = decide(need(brief(), "Nursery"), "covered-outside", "Covered", AT);
    const text = JSON.stringify(d);
    for (const name of Object.values(names)) expect(text).not.toContain(name);
  });
});

describe("plain wording", () => {
  it("lists several names naturally", () => {
    const f: Change = { code: "confirmed-lost", person_ids: [PEOPLE.riley, PEOPLE.sam, PEOPLE.casey] };
    expect(changeText(f, nameOf)).toBe("Riley Thornbury, Sam Whitcombe and Casey Pemberly are no longer confirmed in Planning Center.");
    expect(changeText({ code: "suggestions-changed", added: [PEOPLE.riley], removed: [] }, nameOf)).toBe("Who could help changed: Riley Thornbury could now help, with no overlap found.");
  });
  it("never needs a finding's array position", () => {
    const f: Finding = need(brief(), "Greeter");
    expect(f.key).not.toMatch(/position:\d/);
  });
});
