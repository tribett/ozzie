// Issue 45: B1 Church merges a plan's times into one span, from the earliest start to the latest end, and doesn't say
// which time a role serves. On a plan with several start times a role is said by its day, never as the plan's earliest
// time; a plan with one time keeps it. Fictional data only.
import { describe, expect, it } from "vitest";
import { buildSystemBrief } from "../../src/church-systems/brief.js";
import { briefTarget } from "../../src/finding-feedback.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { systemHarnessCapture } from "../../src/church-systems/harness.js";
import { parseSystemCapture, rolesShareOneTime, SYSTEMS, type SystemCapture } from "../../src/church-systems/types.js";
import { blockoutWhen, findingTime } from "../../src/sunday-brief.js";
import { composeAnswer } from "../../src/harness/compose.js";
import { envelopeProblems } from "../../src/harness/fixed.js";
import type { ToolEnvelope } from "../../src/harness/contract.js";
import { buildSpokenBriefing } from "../../src/spoken-briefing.js";
import { asJson, b1Capture, breezeCapture, NOW } from "./fixtures.js";

type Mutable = Record<string, unknown>;
/** The fictional B1 plan with `times` start times: 9:00 AM, and with two, 11:00 AM to 12:30 PM as well. */
const plan = (times: number | undefined, over: Partial<SystemCapture> = {}): SystemCapture => {
  const base = b1Capture(over), service = base.service!;
  return { ...base, service: { ...service, ...(times !== undefined && times > 1 ? { ends_at: "2026-11-22T12:30:00-06:00" } : {}), ...(times === undefined ? {} : { times }) } };
};
const built = (capture: SystemCapture) => {
  const b = buildSystemBrief(capture, { confirmedZone: capture.church.time_zone }, NOW);
  if (!b.ok) throw new Error(b.reason);
  return b.brief;
};
const BLOCKED = { blockouts: [{ person_id: "PER-rowan", starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" }] };

describe("the capture's count of start times", () => {
  it("is kept when sent, from 1 to 100, and may be left out", () => {
    for (const times of [1, 2, 100]) {
      const parsed = parseSystemCapture(asJson(plan(times)));
      expect(parsed.ok && parsed.capture.service?.times, String(times)).toBe(times);
    }
    const without = parseSystemCapture(asJson(plan(undefined)));
    expect(without.ok && "times" in without.capture.service!).toBe(false);
    // Breeze has one time a service and sends none.
    expect(parseSystemCapture(asJson(breezeCapture())).ok).toBe(true);
  });
  it.each<[string, unknown]>([["count", 0], ["count", 101], ["count", -1], ["count", 1.5], ["count", "2"], ["count", null], ["count", [2]]])(
    "refuses (%s) a count of %j", (reason, times) => {
      const value = asJson(plan(2)) as Mutable;
      (value["service"] as Mutable)["times"] = times;
      expect(parseSystemCapture(value)).toEqual({ ok: false, reason });
    });
  it("still refuses any other extra field on the service", () => {
    const value = asJson(plan(2)) as Mutable;
    (value["service"] as Mutable)["name"] = "x";
    expect(parseSystemCapture(value)).toEqual({ ok: false, reason: "shape" });
    const swapped = asJson(plan(undefined)) as Mutable;
    delete (swapped["service"] as Mutable)["shared"];
    (swapped["service"] as Mutable)["times"] = 2;
    expect(parseSystemCapture(swapped)).toEqual({ ok: false, reason: "shape" });
  });
  it("one time, or a check kept before the count was recorded, is one time; more is not", () => {
    expect([plan(undefined), plan(1), plan(2), plan(3)].map(c => rolesShareOneTime(c.service!))).toEqual([true, true, false, false]);
  });
});

describe("a B1 Church plan with several start times", () => {
  it("names no time on a role that needs people or is waiting for an answer; one time names it as before", () => {
    for (const times of [undefined, 1]) {
      const b = built(plan(times));
      expect(b.times, String(times)).toEqual(["2026-11-22T09:00:00-06:00"]);
      for (const f of b.findings.filter(f => f.kind === "needs-people" || f.kind === "pending"))
        expect(f.position?.interval, f.id).toEqual({ starts_at: "2026-11-22T09:00:00-06:00", ends_at: "2026-11-22T10:30:00-06:00" });
    }
    const b = built(plan(2));
    const roles = b.findings.filter(f => f.kind === "needs-people" || f.kind === "pending");
    expect(roles.map(f => f.id)).toEqual(["need:POS-vocals", "need:POS-guitar", "need:POS-greeter", "pending:ASN-lark"]);
    for (const f of roles) {
      expect(f.position?.interval, f.id).toBeNull();
      expect(findingTime(f), f.id).toBeNull();
    }
    // The service's page names no one time for the service either: only the earliest is known here.
    expect(b.times).toEqual([]);
    // The plan's own start is still its earliest time, for what orders services and tells a day from the next.
    expect(b.plan.starts_at).toBe("2026-11-22T09:00:00-06:00");
    expect(JSON.stringify(b.findings)).not.toContain("T09:00");
  });
  it("finds the same needs and answers either way: only how a role's time is said changes", () => {
    const strip = (c: SystemCapture) => built(c).findings.map(f => ({ id: f.id, kind: f.kind, remaining: f.remaining ?? null, person: f.person_id ?? null, why: f.why }));
    const one = b1Capture(), two = { ...one, service: { ...one.service!, times: 2 } };
    expect(strip(two)).toEqual(strip(one));
  });
  it("a blockout over the service names the role and no one time, and can still be marked", () => {
    const one = built(plan(1, BLOCKED)).findings.find(f => f.kind === "blockout")!;
    expect(one.serving).toEqual([expect.objectContaining({ name: "Vocals", interval: { starts_at: "2026-11-22T09:00:00-06:00", ends_at: "2026-11-22T10:30:00-06:00" } })]);
    const two = built(plan(2, BLOCKED)).findings.find(f => f.kind === "blockout")!;
    expect(two).toMatchObject({ person_id: "PER-rowan", serving: [{ name: "Vocals", status: "confirmed", interval: null }] });
    expect(two.position?.interval).toBeNull();
    expect(findingTime(two)).toBeNull();
    expect(() => briefTarget(two, "PLA0000nov22", "Sunday, November 22")).not.toThrow();
    // Review M1: with no time named, the blockout is "during the service", never "at that time" or "at those times".
    expect(blockoutWhen(one)).toBe("at that time");
    expect(blockoutWhen(two)).toBe("during the service");
    expect(blockoutWhen({ serving: [{ ...one.serving![0]! }, { ...one.serving![0]!, name: "Usher", interval: { starts_at: "2026-11-22T11:00:00-06:00", ends_at: "2026-11-22T12:00:00-06:00" } }] })).toBe("at those times");
  });
  it("the spoken briefing says a blockout is during the service, with no time", () => {
    const spoken = buildSpokenBriefing({ attention: null, sunday: built(plan(2, BLOCKED)) }, { timeZone: "America/Chicago" });
    expect(spoken.text).toContain("Someone scheduled for Vocals has a blockout in B1 Church during the service.");
    // (The check's own time, "checked Friday, November 20 at 9:00 AM", is not the service's.)
    expect(spoken.text).not.toMatch(/Vocals at |at that time|at those times/u);
  });
  it("Ask's answer says a blockout is during the service when no role's time is known", () => {
    const overview: ToolEnvelope = { tool: "sunday.overview", source: "B1 Church", check_time: "2026-11-20T15:00:00Z", completeness: "complete",
      payload: { fact: "f1", mode: "live", sunday: "2026-11-22", reads: 9, reads_not_completed: 0, needs_a_decision: 0, worth_a_look: 1, findings: [
        { fact: "f2", kind: "scheduled with a blockout at this time", tone: "worth a look", person: "[Person 1]",
          serving: [{ role: "[Role 1]", status: "confirmed", time: "not known" }] }] } };
    expect(envelopeProblems(overview)).toEqual([]);
    const said = composeAnswer('{"answer":"facts","facts":["f2"]}', [overview]).paragraphs.join(" ");
    expect(said).toContain("[Person 1] is scheduled for [Role 1] (confirmed) and has a blockout in");
    expect(said).toContain("during the service.");
    expect(said).not.toMatch(/that time|those times/u);
  });
  it("Ask is told a role's time isn't known, never the plan's earliest time", async () => {
    const data = (capture: SystemCapture): HarnessData => ({
      capture: systemHarnessCapture(capture, false), brief: built(capture), operations: null, decisions: [],
      rules: { sundayLeads: [], checkInAfterSundaysInARow: 3 }, attention: null, granted: ["services"], mode: "live", connected: false,
      source: SYSTEMS[capture.system].name });
    const rows = async (capture: SystemCapture) => {
      const tools = new HarnessTools(data(capture), new HarnessSession(), { now: () => NOW });
      const signal = new AbortController().signal;
      const pending = await tools.run("sunday.pending_requests", {}, signal);
      const open = await tools.run("sunday.open_needs", {}, signal);
      const overview = await tools.run("sunday.overview", {}, signal);
      return { pending, open, overview };
    };
    const one = await rows(plan(1, BLOCKED));
    expect(JSON.stringify(one)).toContain("2026-11-22T09:00");
    const two = await rows(plan(2, BLOCKED));
    expect(JSON.stringify(two)).not.toMatch(/T09:00|T12:30/u);
    const pending = (two.pending.payload as { pending: Record<string, unknown>[] }).pending;
    expect(pending.map(r => r["time"])).toEqual(["not known"]);
  });
});
