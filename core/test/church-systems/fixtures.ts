// Fictional captures from other church systems, shaped as native code hands them to the page.
// Every church, person, id and name here is invented.
import type { ReadOutcome, SystemCapture, SystemId, SystemRead } from "../../src/church-systems/types.js";

export const CHECKED = "2026-11-20T15:00:00Z";
/** Ten minutes after the check: inside the freshness window. */
export const NOW = "2026-11-20T15:10:00Z";

/** All of `system`'s reads, each read once and ok, unless `outcomes` says otherwise. */
export function readsOf(words: readonly string[], outcomes: Record<string, ReadOutcome> = {}): SystemRead[] {
  return words.map(read => ({ read, checked_at: CHECKED, outcome: outcomes[read] ?? "ok" }));
}
/** The reads native code makes for B1 Church (it reads no attendance and no form submission counts). */
export const B1_READS = ["b1.church", "b1.plans", "b1.plans_day", "b1.times", "b1.positions", "b1.assignments", "b1.group_members",
  "b1.blockouts", "b1.groups", "b1.events", "b1.forms", "b1.people"] as const;

/**
 * Cedar Hollow Fellowship on B1 Church, Sunday November 22 at 9:00 AM Central (90 minutes):
 * - Vocals (worship team) needs 2: Rowan accepted, Tamsin declined. One still needed.
 * - Guitar (worship team) needs 1: nobody scheduled. An open role.
 * - Greeter (hospitality team) needs 2: Lark hasn't answered. One still needed.
 * - Worship team also has Ember (blocked out all weekend) and Bram (blocked out the weekend before only).
 * - Hospitality team also has Wren, who has no blockout.
 * - Rowan is also on another plan at 11:00 that morning; nobody offered as help is busy elsewhere.
 */
export function b1Capture(over: Partial<SystemCapture> = {}): SystemCapture {
  return {
    version: 1, system: "b1",
    church: { id: "CHU0000cedar", time_zone: "America/Chicago" },
    started_at: "2026-11-20T14:59:58Z", completed_at: "2026-11-20T15:00:04Z",
    reads: readsOf(B1_READS),
    service: { id: "PLA0000nov22", day: "2026-11-22", starts_at: "2026-11-22T09:00:00-06:00", ends_at: "2026-11-22T10:30:00-06:00", shared: true },
    busy: [{ person_id: "PER-rowan", starts_at: "2026-11-22T11:00:00-06:00", ends_at: "2026-11-22T12:00:00-06:00", answer: "accepted" }],
    on_service: [],
    positions: [
      { id: "POS-vocals", team_id: "GRP-worship", needed: 2 },
      { id: "POS-guitar", team_id: "GRP-worship", needed: 1 },
      { id: "POS-greeter", team_id: "GRP-hosp", needed: 2 },
    ],
    assignments: [
      { id: "ASN-rowan", position_id: "POS-vocals", person_id: "PER-rowan", status: "accepted", asked: true },
      { id: "ASN-tamsin", position_id: "POS-vocals", person_id: "PER-tamsin", status: "declined", asked: true },
      // Lark's request hasn't been sent yet.
      { id: "ASN-lark", position_id: "POS-greeter", person_id: "PER-lark", status: "unconfirmed", asked: false },
    ],
    team_members: [
      { team_id: "GRP-worship", person_id: "PER-rowan" }, { team_id: "GRP-worship", person_id: "PER-tamsin" },
      { team_id: "GRP-worship", person_id: "PER-ember" }, { team_id: "GRP-worship", person_id: "PER-bram" },
      { team_id: "GRP-hosp", person_id: "PER-lark" }, { team_id: "GRP-hosp", person_id: "PER-wren" },
    ],
    blockouts: [
      { person_id: "PER-ember", starts_at: "2026-11-21T00:00:00-06:00", ends_at: "2026-11-23T00:00:00-06:00" },
      { person_id: "PER-bram", starts_at: "2026-11-14T00:00:00-06:00", ends_at: "2026-11-16T00:00:00-06:00" },
    ],
    groups: [{ id: "GRP-worship", members: 4 }, { id: "GRP-youth", members: null }],
    events: [{ id: "SES-nov15", starts_at: "2026-11-15T09:00:00-06:00", ends_at: "2026-11-15T10:30:00-06:00", attendance: null }],
    forms: [{ id: "FRM-serve", submissions: null }],
    names: {
      "PER-rowan": "Rowan Fictional", "PER-tamsin": "Tamsin Fictional", "PER-lark": "Lark Fictional",
      "PER-ember": "Ember Fictional", "PER-bram": "Bram Fictional", "PER-wren": "Wren Fictional",
    },
    labels: {
      church: "Cedar Hollow Fellowship", service: "Sunday Gathering",
      "position:POS-vocals": "Vocals", "position:POS-guitar": "Guitar", "position:POS-greeter": "Greeter",
      "team:GRP-worship": "Worship", "team:GRP-hosp": "Hospitality",
      "group:GRP-worship": "Worship", "group:GRP-youth": "Youth Night", "event:SES-nov15": "Sunday Gathering", "form:FRM-serve": "Serve Sign-up",
    },
    ...over,
  };
}

/**
 * Juniper Street Church on Breeze, Sunday November 22 at 10:30 AM Eastern. Breeze has no blockouts and no teams tied
 * to roles. Answers here are unknown; Breeze's real codes (no response, declined, accepted) are tested separately.
 */
export function breezeCapture(over: Partial<SystemCapture> = {}): SystemCapture {
  return {
    version: 1, system: "breeze",
    church: { id: "juniperstreet", time_zone: "America/New_York" },
    started_at: "2026-11-20T14:59:58Z", completed_at: "2026-11-20T15:00:04Z",
    reads: readsOf(["breeze.account", "breeze.events", "breeze.roles", "breeze.volunteers", "breeze.tags", "breeze.people"]),
    service: { id: "88120031", day: "2026-11-22", starts_at: "2026-11-22T10:30:00-05:00", ends_at: "2026-11-22T12:00:00-05:00", shared: null },
    busy: null, on_service: [],
    positions: [{ id: "9627", team_id: null, needed: 2 }, { id: "9628", team_id: null, needed: 1 }],
    assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "unknown", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "unknown", asked: null },
    ],
    team_members: [],
    blockouts: null,
    groups: [], events: [], forms: [],
    names: { "157801": "Juniper Fictional", "157802": "Linden Fictional" },
    labels: { church: "Juniper Street Church", "position:9627": "Teacher", "position:9628": "Usher" },
    ...over,
  };
}

/** The reads native code makes for a Breeze check of a service that hasn't ended (attendance waits for its end). */
export const BREEZE_READS = ["breeze.account", "breeze.events", "breeze.roles", "breeze.volunteers", "breeze.people", "breeze.tags",
  "breeze.forms", "breeze.form_entries"] as const;

/**
 * A Breeze church as the live test church showed it (round 4; every name invented): the event Ozzie watches has no
 * time of day, which Breeze writes as midnight; its roles come with no number needed (Breeze's older volunteers page);
 * Sound and Usher have someone who said yes, Greeter someone who hasn't answered, one Usher said no, and one person is
 * on the service with no role.
 */
export function breezeUntimedCapture(over: Partial<SystemCapture> = {}): SystemCapture {
  return breezeCapture({
    church: { id: "perlandera", time_zone: "America/Chicago" },
    reads: readsOf(BREEZE_READS, { "breeze.form_entries": "truncated" }),
    service: { id: "90001", day: "2026-11-22", starts_at: "2026-11-22T00:00:00-06:00", ends_at: "2026-11-22T23:59:00-06:00", shared: null },
    positions: [{ id: "R1", team_id: null, needed: null }, { id: "R2", team_id: null, needed: null }, { id: "R3", team_id: null, needed: null }],
    assignments: [
      { id: "V1", position_id: "R1", person_id: "P-wren", status: "unconfirmed", asked: null },
      { id: "V2", position_id: "R2", person_id: "P-sam", status: "accepted", asked: null },
      { id: "V3", position_id: "R3", person_id: "P-ivy", status: "accepted", asked: null },
      { id: "V4", position_id: "R2", person_id: "P-lee", status: "declined", asked: null },
    ],
    on_service: ["P-kit"],
    names: { "P-wren": "Wren Fictional", "P-sam": "Sam Fictional", "P-ivy": "Ivy Fictional", "P-lee": "Lee Fictional", "P-kit": "Kit Fictional" },
    labels: { church: "Perlandera Fictional Church", service: "Event Location limit", "position:R1": "Greeter", "position:R2": "Usher", "position:R3": "Sound" },
    ...over,
  });
}

/** A Genesis capture: no service, no positions, no people; groups, events and forms only. */
export function factsCapture(system: Extract<SystemId, "genesis">, over: Partial<SystemCapture> = {}): SystemCapture {
  const words = ["genesis.me", "genesis.groups", "genesis.events", "genesis.forms", "genesis.form_submissions"];
  return {
    version: 1, system,
    church: { id: "ORG-maple", time_zone: "America/Denver" },
    started_at: "2026-11-20T14:59:58Z", completed_at: "2026-11-20T15:00:04Z",
    reads: readsOf(words),
    service: null, busy: null, on_service: [], positions: [], assignments: [], team_members: [], blockouts: null,
    groups: [{ id: "G1", members: 12 }, { id: "G2", members: null }],
    events: [
      { id: "E1", starts_at: "2026-11-15T09:00:00-07:00", ends_at: null, attendance: 140 },
      { id: "E2", starts_at: "2026-11-01T09:00:00-07:00", ends_at: "2026-11-01T10:00:00-07:00", attendance: 0 },
    ],
    forms: [{ id: "F1", submissions: 5 }, { id: "F2", submissions: null }],
    names: {},
    labels: { church: "Maple Crossing Church", "group:G1": "Tuesday Group", "event:E1": "Sunday Service", "form:F1": "Prayer Card" },
    ...over,
  };
}

/** Round-trips a value through JSON, as native code's text would arrive. */
export const asJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
