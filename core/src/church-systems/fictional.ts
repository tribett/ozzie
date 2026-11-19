// The fictional example church for B1 Church and for Breeze, the sibling of core/src/fictional-sunday.ts: what a pastor
// on either system sees from "See a fictional example", in that system's own shape. Every church, person, id and name
// here is invented. Read as of its own check (`completed_at`), so it never goes out of date.
import type { SystemCapture } from "./types.js";

const CHECKED = "2026-11-20T15:00:00Z";
const reads = (words: readonly string[]) => words.map(read => ({ read, checked_at: CHECKED, outcome: "ok" as const }));

/**
 * Cedar Hollow Fellowship on B1 Church, Sunday November 22 at 9:00 AM Central: Vocals needs one more (one said yes, one
 * said no), Guitar has nobody yet, a greeter hasn't been asked yet, and someone who could help is blocked out.
 */
export function fictionalB1(): SystemCapture {
  return {
    version: 1, system: "b1",
    church: { id: "CHU0000cedar", time_zone: "America/Chicago" },
    started_at: "2026-11-20T14:59:58Z", completed_at: "2026-11-20T15:00:04Z",
    reads: reads(["b1.church", "b1.plans", "b1.plans_day", "b1.times", "b1.positions", "b1.assignments", "b1.group_members", "b1.blockouts",
      "b1.groups", "b1.events", "b1.forms", "b1.people"]),
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
    events: [], forms: [],
    names: {
      "PER-rowan": "Rowan Fictional", "PER-tamsin": "Tamsin Fictional", "PER-lark": "Lark Fictional",
      "PER-ember": "Ember Fictional", "PER-bram": "Bram Fictional", "PER-wren": "Wren Fictional",
    },
    labels: {
      church: "Cedar Hollow Fellowship (example)", service: "Sunday Gathering",
      "position:POS-vocals": "Vocals", "position:POS-guitar": "Guitar", "position:POS-greeter": "Greeter",
      "team:GRP-worship": "Worship", "team:GRP-hosp": "Hospitality", "group:GRP-worship": "Worship", "group:GRP-youth": "Youth Night",
    },
  };
}

/**
 * Juniper Street Church on Breeze, Sunday November 22 at 10:30 AM Eastern: a teacher still needed, an usher who hasn't
 * answered, and one volunteer listed with no role. Breeze has no blockouts and ties no team to a role.
 */
export function fictionalBreeze(): SystemCapture {
  return {
    version: 1, system: "breeze",
    church: { id: "juniperstreet", time_zone: "America/New_York" },
    started_at: "2026-11-20T14:59:58Z", completed_at: "2026-11-20T15:00:04Z",
    reads: reads(["breeze.account", "breeze.events", "breeze.roles", "breeze.volunteers", "breeze.tags", "breeze.people"]),
    service: { id: "88120031", day: "2026-11-22", starts_at: "2026-11-22T10:30:00-05:00", ends_at: "2026-11-22T12:00:00-05:00", shared: null },
    busy: null, on_service: ["157803"],
    positions: [{ id: "9627", team_id: null, needed: 2 }, { id: "9628", team_id: null, needed: 1 }],
    assignments: [
      { id: "71001", position_id: "9627", person_id: "157801", status: "accepted", asked: null },
      { id: "71002", position_id: "9628", person_id: "157802", status: "unconfirmed", asked: null },
    ],
    team_members: [], blockouts: null, groups: [], events: [], forms: [],
    names: { "157801": "Juniper Fictional", "157802": "Linden Fictional", "157803": "Sorrel Fictional" },
    labels: { church: "Juniper Street Church (example)", service: "Sunday Worship", "position:9627": "Teacher", "position:9628": "Usher" },
  };
}
