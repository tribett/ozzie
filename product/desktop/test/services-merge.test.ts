// Every service watched, counted as one (owner decision 2026-11-19): the count across services is each service's own count
// added up, two services' findings and decisions never meet, and a church with one service sees the very same brief.
// Fixed fictional data.
import { describe, expect, it } from "vitest";
import { fromPartKey, MANY_SERVICES, mergeDecisions, mergedNames, mergeParts, partKey, teamServices } from "../src/services-merge.js";
import { buildSundayBrief, sundayShownCount } from "../../../core/src/sunday-brief.js";
import { applyDecisions, decide } from "../../../core/src/sunday-decisions.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { wednesdayCapture } from "../../../core/test/fixtures/service-days/wednesday.js";
import { HarnessSession, restoreLabels } from "../../../core/src/harness/session.js";

const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const sunday = nov22Capture(), wednesday = { ...wednesdayCapture(), service_type_id: "1700", plan_id: "94000001" };
const main = buildSundayBrief(sunday, rules, sunday.completed_at);
const other = buildSundayBrief(wednesday, rules, wednesday.completed_at);
const count = (b: typeof main, d: Parameters<typeof applyDecisions>[1] = []) => sundayShownCount(applyDecisions(b, d), null);

describe("every service watched, as one count", () => {
  it("with one service, the very same brief and decisions", () => {
    const one = { brief: main, decisions: [] };
    expect(mergeParts(one, [])).toBe(one);
  });

  it("adds each service's own count, the leader's decisions for each applied to it alone", () => {
    const greeter = other.findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;
    const decided = [decide(greeter, "covered-outside", "Asked my neighbour", sunday.completed_at)];
    const m = mergeParts({ brief: main, decisions: [] }, [{ plan_id: "94000001", brief: other, decisions: decided }]);
    const all = count(m.brief, m.decisions);
    expect(all.decisions).toBe(count(main).decisions + count(other, decided).decisions);
    expect(all.looks).toBe(count(main).looks + count(other, decided).looks);
    // The Wednesday Greeter is resolved by the leader; the Sunday Greeter, with the same team and name, is still open.
    expect(count(other, decided).decisions).toBe(count(other).decisions - 1);
    expect(all.decisions).toBe(count(main).decisions + count(other).decisions - 1);
  });

  it("keeps each service's findings apart: the first service's keys unchanged, the other's its own", () => {
    const m = mergeParts({ brief: main, decisions: [] }, [{ plan_id: "94000001", brief: other, decisions: [] }]);
    expect(m.brief.findings.slice(0, main.findings.length)).toEqual(main.findings);
    const keys = m.brief.findings.map(f => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    const theirs = m.brief.findings.slice(main.findings.length);
    expect(theirs.map(f => fromPartKey(f.key))).toEqual(other.findings.map(f => ({ plan_id: "94000001", key: f.key })));
    expect(fromPartKey(main.findings[0]!.key)).toBeNull();
    expect(fromPartKey(partKey("94000001", "x"))).toEqual({ plan_id: "94000001", key: "x" });
    expect(m.brief.sources.reads).toBe(main.sources.reads + other.sources.reads);
    // The first service's plan stays the brief's own; the day is every service's, so no one day is said for all (review M7).
    expect(m.brief.plan).toBe(main.plan);
    expect(m.brief.day).toBe(MANY_SERVICES);
    expect(MANY_SERVICES).toMatchObject({ day: "your services", thisOne: "your services", date: null });
    // The decisions across services are the first service's own list when no other service has any part.
    const own: never[] = [];
    expect(mergeDecisions(own, [])).toBe(own);
  });

  it("knows every service's people by name on this Mac, the first service's names first", () => {
    const named = mergedNames(sunday, [{ ...wednesday, names: { ...wednesday.names, "999": "Quinn Example" } }]);
    expect(named.names["999"]).toBe("Quinn Example");
    expect(named.organization).toBe(sunday.organization);
    expect(named.reads).toBe(sunday.reads);
    expect(mergedNames(sunday, [])).toBe(sunday);
  });

  it("says a role with its service in an answer written on this Mac, only when more than one service is watched", () => {
    expect(teamServices({ brief: main, name: "Sunday Morning" }, [])).toBeUndefined();
    const teams = teamServices({ brief: main, name: "Sunday Morning" }, [{ brief: { ...other, positions: other.positions.map(p => ({ ...p, team_id: `w${p.team_id}` })) }, name: "Youth Night" }])!;
    const session = new HarnessSession();
    const team = main.positions.find(p => p.name === "Greeter")!.team_id;
    const label = session.role("Greeter", team), other_ = session.role("Greeter", `w${team}`);
    const roleService = (_name: string, t?: string) => t && Object.hasOwn(teams, t) ? teams[t]! : null;
    expect(restoreLabels(`${label} and ${other_}`, session, { names: {}, roleService })).toBe("Greeter (Sunday Morning) and Greeter (Youth Night)");
    expect(restoreLabels(label, session, { names: {} })).toBe("Greeter");
  });
});

describe("Ask's overview across services says each item's own date (coordinator's item, 2026-11-19)", () => {
  it("heads the answer with your services and gives every item its own service's date", async () => {
    const { HarnessTools } = await import("../../../core/src/harness/tools.js");
    const { composeAnswer } = await import("../../../core/src/harness/compose.js");
    const m = mergeParts({ brief: main, decisions: [] }, [{ plan_id: "94000001", brief: other, decisions: [] }]);
    const data = { capture: mergedNames(sunday, [wednesday]), brief: m.brief, operations: null, decisions: m.decisions, rules, attention: null,
      granted: ["services"] as ("services" | "operations")[], mode: "live" as const, connected: true };
    const session = new HarnessSession();
    const tools = new HarnessTools(data, session, { now: () => sunday.completed_at });
    const overview = await tools.run("sunday.overview", {}, new AbortController().signal, "t");
    const facts = [(overview.payload as { fact: string }).fact, ...((overview.payload as { findings: { fact: string }[] }).findings.map(f => f.fact))];
    const said = composeAnswer(JSON.stringify({ answer: "facts", facts: facts.slice(0, 24) }), [overview], m.brief.day!).paragraphs
      .map(p => restoreLabels(p, session, { names: data.capture.names, timeZone: m.brief.time_zone }));
    expect(said[0]).toMatch(/^For your services, \d+ things need a decision/u);
    // Each service's Greeter keeps its own date: neither is shortened to a time on "the" day.
    const greeters = said.filter(p => p.startsWith("Greeter"));
    expect(greeters.some(p => p.includes("November 22"))).toBe(true);
    expect(greeters.some(p => p.includes("November 25"))).toBe(true);
    for (const p of said) expect(p).not.toMatch(/Sunday|Wednesday/u);
  });
});
