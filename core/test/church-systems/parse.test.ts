// A capture from another church system is taken whole or refused whole, with one closed reason word: an unknown or
// missing field, a wrong type, a time without an explicit offset, a duplicate id, an assignment to a position that
// isn't there, a bad count, a label key outside the grammar or anything over its cap. Fictional data only.
import { describe, expect, it } from "vitest";
import { labelsOf, namesOf } from "../../src/church-systems/placeholders.js";
import { MAX, parseSystemCapture, parseSystemCaptureText, READ_OUTCOMES, REFUSALS, SYSTEMS, type SystemCapture } from "../../src/church-systems/types.js";
import { asJson, b1Capture, breezeCapture, factsCapture } from "./fixtures.js";

type Mutable = Record<string, unknown>;
/** The B1 fixture as plain JSON, changed by `change`, then parsed. */
function refusal(change: (c: Mutable) => void, base: SystemCapture = b1Capture()) {
  const value = asJson(base) as Mutable;
  change(value);
  const parsed = parseSystemCapture(value);
  return parsed.ok ? "accepted" : parsed.reason;
}
const at = (c: Mutable, key: string, index = 0) => (c[key] as Mutable[])[index]!;

describe("parseSystemCapture", () => {
  it("takes each fixture whole, equal to what was sent", () => {
    for (const capture of [b1Capture(), breezeCapture(), factsCapture("genesis")]) {
      const parsed = parseSystemCapture(asJson(capture));
      expect(parsed).toEqual({ ok: true, capture });
    }
  });

  it("returns a deeply frozen capture that shares nothing with the value sent", () => {
    const sent = asJson(b1Capture()) as Mutable;
    const parsed = parseSystemCapture(sent);
    if (!parsed.ok) throw new Error(parsed.reason);
    const c = parsed.capture;
    for (const part of [c, c.church, c.reads, c.reads[0], c.service, c.busy, c.busy![0], c.positions, c.positions[0], c.assignments[0], c.team_members[0],
      c.blockouts, c.blockouts![0], c.groups[0], c.events[0], c.forms[0], c.names, c.labels]) expect(Object.isFrozen(part)).toBe(true);
    (at(sent, "positions") as Mutable)["needed"] = 99;
    expect(c.positions[0]!.needed).toBe(2);
    expect(() => { (c.positions as unknown as unknown[]).push({}); }).toThrow();
  });

  it("keeps a name keyed __proto__ as data, never a prototype", () => {
    const value = asJson(b1Capture()) as Mutable;
    (value["team_members"] as Mutable[]).push({ team_id: "GRP-hosp", person_id: "__proto__" });
    value["names"] = JSON.parse('{"__proto__":"Fictional Person"}');
    const parsed = parseSystemCapture(value);
    if (!parsed.ok) throw new Error(parsed.reason);
    expect(Object.getPrototypeOf(parsed.capture.names)).toBeNull();
    expect(Object.hasOwn(parsed.capture.names, "__proto__")).toBe(true);
    expect(namesOf(parsed.capture)["__proto__"]).toBe("Fictional Person");
  });

  it("an id such as constructor with no name has no name, never something inherited (L1)", () => {
    const value = asJson(b1Capture()) as Mutable;
    (value["team_members"] as Mutable[]).push({ team_id: "GRP-hosp", person_id: "constructor" });
    const parsed = parseSystemCapture(value);
    if (!parsed.ok) throw new Error(parsed.reason);
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      expect(namesOf(parsed.capture)[key], key).toBeUndefined();
      expect(labelsOf(parsed.capture)[key], key).toBeUndefined();
    }
  });

  it.each([
    ["not-json", () => { const v = asJson(b1Capture()) as Mutable; v["church"] = { get id() { return "x"; }, time_zone: null }; return v; }],
    ["not-json", () => undefined],
    ["shape", () => [b1Capture()]],
  ])("refuses %s values that aren't plain JSON objects", (reason, make) => {
    const parsed = parseSystemCapture(make());
    expect(parsed).toEqual({ ok: false, reason });
  });

  it.each<[string, (c: Mutable) => void]>([
    ["shape", c => { c["extra"] = 1; }],
    ["shape", c => { delete c["labels"]; }],
    ["shape", c => { (c["church"] as Mutable)["name"] = "x"; }],
    ["shape", c => { at(c, "reads")["page"] = 2; }],
    ["shape", c => { delete (c["service"] as Mutable)["ends_at"]; }],
    ["shape", c => { delete (c["service"] as Mutable)["day"]; }],
    ["shape", c => { delete c["busy"]; }],
    ["shape", c => { delete c["on_service"]; }],
    ["shape", c => { c["on_service"] = null; }],
    ["id", c => { c["on_service"] = ["not ok"]; }],
    ["duplicate", c => { c["on_service"] = ["PER-wren", "PER-wren"]; }],
    // Everyone on the service with no role has a name entry.
    ["unknown-reference", c => { c["on_service"] = ["PER-nobody"]; }],
    // Nobody is both in a role and on the service with no role.
    ["duplicate", c => { c["on_service"] = ["PER-lark"]; }],
    ["shape", c => { delete (c["service"] as Mutable)["shared"]; }],
    ["status", c => { (c["service"] as Mutable)["shared"] = "no"; }],
    ["shape", c => { at(c, "busy")["status"] = "accepted"; }],
    ["shape", c => { delete at(c, "busy")["answer"]; }],
    ["status", c => { at(c, "busy")["answer"] = "declined"; }],
    ["status", c => { at(c, "busy")["answer"] = "unknown"; }],
    ["shape", c => { at(c, "positions")["name"] = "Vocals"; }],
    ["shape", c => { delete at(c, "assignments")["status"]; }],
    ["shape", c => { at(c, "team_members")["leader"] = true; }],
    ["shape", c => { delete at(c, "blockouts")["ends_at"]; }],
    ["shape", c => { at(c, "groups")["name"] = "Worship"; }],
    ["shape", c => { delete at(c, "events")["attendance"]; }],
    ["shape", c => { at(c, "forms")["name"] = "x"; }],
    ["shape", c => { c["positions"] = {}; }],
    ["shape", c => { c["names"] = []; }],
    ["shape", c => { c["service"] = "PLA0000nov22"; }],
    ["version", c => { c["version"] = 2; }],
    ["version", c => { c["version"] = "1"; }],
    ["system", c => { c["system"] = "planning-center"; }],
    // The system on hold: its name is assembled only so a search for it finds nothing (no check enforces that).
    ["system", c => { c["system"] = ["sub", "splash"].join(""); }],
    ["id", c => { (c["church"] as Mutable)["id"] = "has space"; }],
    ["id", c => { (c["church"] as Mutable)["id"] = "x".repeat(65); }],
    ["id", c => { at(c, "positions")["id"] = ""; }],
    ["id", c => { at(c, "positions")["team_id"] = "a/b"; }],
    ["id", c => { at(c, "assignments")["person_id"] = 42; }],
    ["id", c => { c["names"] = { "not ok": "Fictional" }; }],
    ["time", c => { c["started_at"] = "2026-11-20T14:59:58-06:00"; }],
    ["time", c => { c["completed_at"] = "2026-11-20T14:00:00Z"; }],
    ["time", c => { at(c, "reads")["checked_at"] = "2026-11-20T15:00:00"; }],
    ["time", c => { (c["service"] as Mutable)["starts_at"] = "2026-11-22 09:00"; }],
    ["time", c => { (c["service"] as Mutable)["starts_at"] = "2026-02-30T09:00:00Z"; }],
    ["time", c => { (c["service"] as Mutable)["ends_at"] = "2026-11-22T09:00:00-06:00"; }],
    ["time", c => { at(c, "blockouts")["ends_at"] = "2026-11-20T00:00:00-06:00"; }],
    ["time", c => { at(c, "events")["starts_at"] = 1763218800; }],
    ["time", c => { at(c, "events")["ends_at"] = "2026-11-15T08:00:00-06:00"; }],
    ["time", c => { (c["service"] as Mutable)["day"] = "2026-11-22T00:00:00Z"; }],
    ["time", c => { (c["service"] as Mutable)["day"] = "2026-02-30"; }],
    ["time", c => { (c["service"] as Mutable)["day"] = "20261122"; }],
    ["time", c => { at(c, "busy")["ends_at"] = "2026-11-22T11:00:00-06:00"; }],
    ["time", c => { at(c, "busy")["starts_at"] = "2026-11-22T11:00:00"; }],
    ["time", c => { at(c, "reads")["checked_at"] = "2027-01-01T00:00:00Z"; }],
    ["time", c => { at(c, "reads")["checked_at"] = "2001-01-01T00:00:00Z"; }],
    ["time-zone", c => { (c["church"] as Mutable)["time_zone"] = "Central Time"; }],
    ["time-zone", c => { (c["church"] as Mutable)["time_zone"] = "America/"; }],
    ["time-zone", c => { (c["church"] as Mutable)["time_zone"] = "x".repeat(65); }],
    ["read", c => { at(c, "reads")["read"] = "b1.donations"; }],
    ["read", c => { at(c, "reads")["read"] = "breeze.volunteers"; }],
    ["outcome", c => { at(c, "reads")["outcome"] = "denied"; }],
    ["status", c => { at(c, "assignments")["status"] = "Accepted"; }],
    ["status", c => { at(c, "assignments")["asked"] = "yes"; }],
    ["status", c => { at(c, "assignments")["asked"] = 1; }],
    ["shape", c => { delete at(c, "assignments")["asked"]; }],
    ["count", c => { at(c, "positions")["needed"] = -1; }],
    ["count", c => { at(c, "positions")["needed"] = 1.5; }],
    ["count", c => { at(c, "groups")["members"] = "4"; }],
    ["count", c => { at(c, "events")["attendance"] = -3; }],
    ["count", c => { at(c, "forms")["submissions"] = 2 ** 60; }],
    ["duplicate", c => { (c["positions"] as Mutable[]).push({ ...at(c, "positions") }); }],
    ["duplicate", c => { (c["assignments"] as Mutable[]).push({ ...at(c, "assignments"), position_id: "POS-guitar" }); }],
    ["duplicate", c => { (c["team_members"] as Mutable[]).push({ ...at(c, "team_members") }); }],
    ["duplicate", c => { (c["groups"] as Mutable[]).push({ id: "GRP-worship", members: 1 }); }],
    ["duplicate", c => { (c["events"] as Mutable[]).push({ ...at(c, "events") }); }],
    ["duplicate", c => { (c["forms"] as Mutable[]).push({ ...at(c, "forms") }); }],
    ["unknown-position", c => { at(c, "assignments")["position_id"] = "POS-drums"; }],
    ["label-key", c => { (c["labels"] as Mutable)["person:PER-rowan"] = "Rowan Fictional"; }],
    ["label-key", c => { (c["labels"] as Mutable)["position:"] = "x"; }],
    ["label-key", c => { (c["labels"] as Mutable)["Church"] = "x"; }],
    ["unknown-reference", c => { (c["labels"] as Mutable)["position:NOPE"] = "Fictional Class"; }],
    ["unknown-reference", c => { (c["labels"] as Mutable)["team:ZZZ"] = "x"; }],
    ["unknown-reference", c => { (c["labels"] as Mutable)["group:ZZZ"] = "x"; }],
    ["unknown-reference", c => { (c["labels"] as Mutable)["event:ZZZ"] = "x"; }],
    ["unknown-reference", c => { (c["labels"] as Mutable)["form:ZZZ"] = "x"; }],
    ["unknown-reference", c => { (c["names"] as Mutable)["PER-nobody"] = "Nobody Fictional"; }],
    ["text", c => { (c["labels"] as Mutable)["church"] = ""; }],
    ["text", c => { (c["names"] as Mutable)["PER-rowan"] = "x".repeat(MAX.text + 1); }],
    ["text", c => { (c["names"] as Mutable)["PER-rowan"] = null; }],
  ])("refuses the whole capture with %s", (reason, change) => {
    expect(refusal(change)).toBe(reason);
  });

  it.each<[string, number, (n: number) => unknown]>([
    ["reads", MAX.reads, () => ({ read: "b1.people", checked_at: "2026-11-20T15:00:00Z", outcome: "ok" })],
    ["positions", MAX.positions, n => ({ id: `P${n}`, team_id: null, needed: 1 })],
    ["team_members", MAX.team_members, n => ({ team_id: "GRP-worship", person_id: `PER${n}` })],
    ["blockouts", MAX.blockouts, () => ({ person_id: "PER-ember", starts_at: "2026-11-21T00:00:00Z", ends_at: "2026-11-22T00:00:00Z" })],
    ["busy", MAX.busy, () => ({ person_id: "PER-ember", starts_at: "2026-11-22T11:00:00Z", ends_at: "2026-11-22T12:00:00Z", answer: "accepted" })],
    ["groups", MAX.groups, n => ({ id: `G${n}`, members: 1 })],
    ["events", MAX.events, n => ({ id: `E${n}`, starts_at: "2026-11-15T09:00:00Z", ends_at: null, attendance: null })],
    ["forms", MAX.forms, n => ({ id: `F${n}`, submissions: 1 })],
  ])("takes exactly the cap of %s (%i) and refuses one more as too-many", (key, cap, item) => {
    const fill = (n: number) => (c: Mutable) => { c[key] = Array.from({ length: n }, (_, i) => item(i)); c["labels"] = {}; c["names"] = {}; };
    expect(refusal(c => { fill(cap)(c); if (key === "positions") c["assignments"] = []; })).toBe("accepted");
    expect(refusal(c => { fill(cap + 1)(c); if (key === "positions") c["assignments"] = []; })).toBe("too-many");
  });

  it("caps assignments at 500, and refuses more than 3000 names or labels", () => {
    const assignments = (n: number) => (c: Mutable) => {
      c["assignments"] = Array.from({ length: n }, (_, i) => ({ id: `A${i}`, position_id: "POS-vocals", person_id: `PER${i}`, status: "accepted", asked: null }));
    };
    expect(refusal(assignments(MAX.assignments))).toBe("accepted");
    expect(refusal(assignments(MAX.assignments + 1))).toBe("too-many");
    const names = (n: number) => (c: Mutable) => { c["names"] = Object.fromEntries(Array.from({ length: n }, (_, i) => [`PER${i}`, "Fictional"])); };
    expect(refusal(names(MAX.names + 1))).toBe("too-many");
    const labels = (n: number) => (c: Mutable) => { c["labels"] = Object.fromEntries(Array.from({ length: n }, (_, i) => [`group:G${i}`, "Fictional"])); };
    expect(refusal(labels(MAX.labels + 1))).toBe("too-many");
    // Within the caps, every name and label must point at something in the capture.
    expect(refusal(c => {
      c["team_members"] = Array.from({ length: MAX.team_members }, (_, i) => ({ team_id: "GRP-worship", person_id: `PER${i}` }));
      names(MAX.team_members)(c);
    })).toBe("accepted");
  });

  it("refuses a sparse list rather than skipping its holes", () => {
    const value = asJson(b1Capture()) as Mutable;
    const sparse: unknown[] = [];
    sparse[1] = { id: "GRP-x", members: 1 };
    value["groups"] = sparse;
    expect(parseSystemCapture(value)).toEqual({ ok: false, reason: "not-json" });
  });

  it("takes whether each request was sent from B1 Church, and only 'doesn't say' from Breeze", () => {
    for (const asked of [true, false, null]) expect(refusal(c => { at(c, "assignments")["asked"] = asked; }), String(asked)).toBe("accepted");
    expect(refusal(c => { at(c, "assignments")["asked"] = true; }, breezeCapture())).toBe("not-supplied");
    expect(refusal(c => { at(c, "assignments")["asked"] = false; }, breezeCapture())).toBe("not-supplied");
    expect(SYSTEMS.breeze.asked).toBe(false);
    expect(SYSTEMS.b1.asked).toBe(true);
  });

  it("takes whether the plan is shared with volunteers from B1 Church only", () => {
    for (const shared of [true, false, null]) expect(refusal(c => { (c["service"] as Mutable)["shared"] = shared; }), String(shared)).toBe("accepted");
    expect(refusal(c => { (c["service"] as Mutable)["shared"] = true; }, breezeCapture())).toBe("not-supplied");
    expect(refusal(c => { (c["service"] as Mutable)["shared"] = false; }, breezeCapture())).toBe("not-supplied");
  });

  it("takes people on the service with no role, at most 500, and none from Genesis", () => {
    const withNames = (n: number) => (c: Mutable) => {
      const ids = Array.from({ length: n }, (_, i) => `PER-on${i}`);
      c["on_service"] = ids;
      c["names"] = Object.fromEntries(ids.map(id => [id, "Fictional"]));
    };
    expect(refusal(withNames(MAX.on_service))).toBe("accepted");
    expect(refusal(withNames(MAX.on_service + 1))).toBe("too-many");
    expect(refusal(c => { c["on_service"] = ["157899"]; c["names"] = { ...(c["names"] as Mutable), "157899": "Fictional" }; }, breezeCapture())).toBe("accepted");
    expect(refusal(c => { c["on_service"] = ["P1"]; c["names"] = { P1: "Fictional" }; }, factsCapture("genesis"))).toBe("not-supplied");
  });

  it("refuses anything a system doesn't supply: a service from Genesis, blockouts from Breeze, attendance from B1 Church", () => {
    const service = { id: "S1", day: "2026-11-22", starts_at: "2026-11-22T09:00:00-07:00", ends_at: null, shared: null };
    expect(refusal(c => { c["service"] = service; }, factsCapture("genesis"))).toBe("not-supplied");
    expect(refusal(c => { c["positions"] = [{ id: "P1", team_id: null, needed: 1 }]; }, factsCapture("genesis"))).toBe("not-supplied");
    expect(refusal(c => { c["blockouts"] = []; }, breezeCapture())).toBe("not-supplied");
    // Genesis documents attendance counts on events.
    expect(refusal(c => { at(c, "events")["attendance"] = 3; }, factsCapture("genesis"))).toBe("accepted");
    // Ozzie doesn't read B1 Church attendance, so a count can't arrive from it; Breeze's service head count can.
    expect(refusal(c => { at(c, "events")["attendance"] = 212; })).toBe("not-supplied");
    const breezeEvent = { id: "88120031", starts_at: "2026-11-22T10:30:00-05:00", ends_at: null, attendance: 40 };
    expect(refusal(c => { c["events"] = [breezeEvent]; }, breezeCapture())).toBe("accepted");
    // Busy times: B1 reads them; Genesis has none; Breeze sends null today but a list isn't refused.
    const busy = [{ person_id: "157801", starts_at: "2026-11-22T08:00:00-05:00", ends_at: "2026-11-22T09:00:00-05:00", answer: "unconfirmed" }];
    expect(refusal(c => { c["busy"] = []; }, factsCapture("genesis"))).toBe("not-supplied");
    expect(refusal(c => { c["busy"] = busy; }, breezeCapture())).toBe("accepted");
    expect(refusal(c => { c["busy"] = null; })).toBe("accepted");
    // Team members only where the system ties a team to each role (L3).
    const member = [{ team_id: "y_16681", person_id: "157801" }];
    expect(refusal(c => { c["team_members"] = member; }, breezeCapture())).toBe("not-supplied");
    expect(refusal(c => { c["team_members"] = [{ team_id: "G1", person_id: "P1" }]; }, factsCapture("genesis"))).toBe("not-supplied");
    // A service's own day may be absent; a label for the service needs a service.
    expect(refusal(c => { (c["service"] as Mutable)["day"] = null; })).toBe("accepted");
    expect(refusal(c => { c["labels"] = { service: "Sunday Gathering" }; }, factsCapture("genesis"))).toBe("unknown-reference");
  });

  it("keeps a time zone with the right shape that this Mac doesn't know, rather than refusing the whole capture", () => {
    for (const zone of ["America/Nowhere", "Mars/Olympus_Mons"]) {
      const value = asJson(b1Capture()) as Mutable;
      (value["church"] as Mutable)["time_zone"] = zone;
      const parsed = parseSystemCapture(value);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.capture.church.time_zone).toBe(zone);
    }
  });

  it("takes Breeze answers now that a live read confirmed its codes (no response, declined, accepted)", () => {
    expect(SYSTEMS.breeze.answers).toBe(true);
    expect(Object.entries(SYSTEMS).filter(([, s]) => !s.answers).map(([k]) => k)).toEqual([]);
    for (const status of ["accepted", "unconfirmed", "declined", "unknown"]) {
      expect(refusal(c => { at(c, "assignments")["status"] = status; }, breezeCapture()), status).toBe("accepted");
    }
    expect(refusal(c => { at(c, "assignments")["status"] = "unconfirmed"; })).toBe("accepted");
  });

  it("reads a capture from its text: text that isn't JSON is not-json, with nothing quoted from it (review D L2)", () => {
    const broken = parseSystemCaptureText('{"names":{"p1":Avery Fictional}}');
    expect(broken).toEqual({ ok: false, reason: "not-json" });
    expect(JSON.stringify(broken)).not.toMatch(/Avery/u);
    expect(parseSystemCaptureText(JSON.stringify(b1Capture()))).toEqual({ ok: true, capture: b1Capture() });
    expect(parseSystemCaptureText(42 as unknown as string)).toEqual({ ok: false, reason: "not-json" });
    expect(parseSystemCaptureText("[1]")).toEqual({ ok: false, reason: "shape" });
  });

  it("knows every outcome and refusal word, and no system claims background checks", () => {
    expect(READ_OUTCOMES).toEqual(["ok", "truncated", "not-requested", "refused", "not-found", "rate-limited", "timeout", "unreachable",
      "too-large", "invalid-response", "key-refused"]);
    expect(new Set(REFUSALS).size).toBe(REFUSALS.length);
    expect(Object.values(SYSTEMS).map(s => s.name)).toEqual(["B1 Church", "Breeze", "Genesis"]);
    expect(Object.values(SYSTEMS).every(s => s.backgroundChecks === false)).toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    const hostile = new Proxy({}, { ownKeys() { throw new Error("boom"); }, getPrototypeOf() { throw new Error("boom"); } });
    for (const value of [null, 1, "x", hostile, Object.create({ version: 1 }), new Map()]) {
      expect(() => parseSystemCapture(value)).not.toThrow();
      expect(parseSystemCapture(value).ok).toBe(false);
    }
  });
});
