// Fictional capture shaped like the staged Nov 22 test-organization Sunday.
// Every name and id here is invented test data; no real person is represented.
import type { SundayCapture, SundayRead } from "./sunday-capture.js";

export const SERVICE = { starts_at: "2026-11-22T14:30:00Z", ends_at: "2026-11-22T15:30:00Z" };
export const CHECKED = "2026-11-20T15:00:00Z";
/** The fictional church's zone, as Planning Center Services' Organization gives it. */
export const FICTIONAL_ZONE = "America/New_York";
/**
 * Services gives `sort_date` as the church's local wall-clock time with a misleading `Z` (verified
 * live 2026-11-13): the 9:30 AM Eastern service reads 09:30Z, not the 14:30Z instant it starts at.
 */
const sortDate = (date: string) => `${date}T09:30:00Z`;
const rel = (type: string, id: string | null) => ({ data: id === null ? null : { type, id } });
const rels = (type: string, ids: string[]) => ({ data: ids.map(id => ({ type, id })) });

export const TEAMS = { greeter: "7593350", nursery: "7593352", lyrics: "7593354" };
export const PEOPLE = {
  greeterConfirmed: "501", nurseryConfirmed: "502", lyricsPending: "503",
  riley: "511", sam: "512", morgan: "513", casey: "514", drew: "515",
  /** Nursery's team leader in Planning Center: oversight, never a Sunday assignment. */
  nurseryLeader: "521",
};

function read(collection: string, body: NonNullable<SundayRead["body"]>, extra: Partial<SundayRead> = {}): SundayRead {
  return { collection, offset: 0, checked_at: CHECKED, outcome: "ok", body, ...extra };
}
const member = (id: string, person: string, team: string, position: string, status: string, sent: string | null) => ({
  type: "PlanPerson", id,
  attributes: { status, team_position_name: position, notification_sent_at: sent, notification_prepared_at: null, prepare_notification: false },
  relationships: { person: rel("Person", person), team: rel("Team", team), times: rels("PlanTime", ["9001"]) },
});
const schedule = (id: string, plan: string, status: string, position: string, times: string[], date = "2026-11-22") => ({
  type: "Schedule", id, attributes: { status, team_position_name: position, sort_date: sortDate(date) },
  relationships: { plan: rel("Plan", plan), times: rels("PlanTime", times) },
});
const planTime = (id: string, starts_at: string, ends_at: string) => ({
  type: "PlanTime", id, attributes: { starts_at, ends_at, time_type: "service" },
});
const assignments = (team: string, position: string, positionId: string, people: string[]) => read("team_position_assignments", {
  data: people.map((p, i) => ({ type: "PersonTeamPositionAssignment", id: `${team}${i}`, attributes: {},
    relationships: { person: rel("Person", p), team_position: rel("TeamPosition", positionId) } })),
  included: [{ type: "TeamPosition", id: positionId, attributes: { name: position } }],
  meta: { count: people.length, total_count: people.length },
}, { team_id: team });
const personReads = (person: string, schedules: unknown[], included: unknown[], blockouts: unknown[]): SundayRead[] => [
  read("person_schedules", { data: schedules, included, meta: { count: schedules.length, total_count: schedules.length } }, { person_id: person }),
  read("person_blockouts", { data: blockouts, meta: { count: blockouts.length, total_count: blockouts.length } }, { person_id: person }),
];
const sunday = (id: string, date: string) => planTime(id, `${date}T14:30:00Z`, `${date}T15:30:00Z`);

export function nov22Capture(): SundayCapture {
  return {
    version: 1, kind: "live", organization: "1001", service_type_id: "1500", plan_id: "92902197",
    started_at: "2026-11-20T14:59:50Z", completed_at: "2026-11-20T15:00:10Z",
    names: {
      [PEOPLE.greeterConfirmed]: "Avery Brightwater", [PEOPLE.nurseryConfirmed]: "Blake Ashgrove",
      [PEOPLE.lyricsPending]: "Cameron Larkspur", [PEOPLE.riley]: "Riley Thornbury", [PEOPLE.sam]: "Sam Whitcombe",
      [PEOPLE.morgan]: "Morgan Ellingsworth", [PEOPLE.casey]: "Casey Pemberly", [PEOPLE.drew]: "Drew Halvorsen",
      [PEOPLE.nurseryLeader]: "Jordan Ashdown",
    },
    reads: [
      read("plan", { data: { type: "Plan", id: "92902197", attributes: { dates: "November 22, 2026", sort_date: sortDate("2026-11-22"), title: "Ozzie Demo — Main Sunday (fictional)", series_title: null } } }),
      read("plan_times", { data: [planTime("9001", SERVICE.starts_at, SERVICE.ends_at)], meta: { count: 1, total_count: 1 } }),
      read("needed_positions", { data: [
        { type: "NeededPosition", id: "301", attributes: { quantity: 1, team_position_name: "Greeter" }, relationships: { team: rel("Team", TEAMS.greeter), time: rel("PlanTime", "9001") } },
        { type: "NeededPosition", id: "302", attributes: { quantity: 1, team_position_name: "Nursery" }, relationships: { team: rel("Team", TEAMS.nursery), time: rel("PlanTime", "9001") } },
      ], meta: { count: 2, total_count: 2 } }),
      read("team_members", { data: [
        member("401", PEOPLE.greeterConfirmed, TEAMS.greeter, "Greeter", "C", "2026-11-01T12:00:00Z"),
        member("402", PEOPLE.nurseryConfirmed, TEAMS.nursery, "Nursery", "C", "2026-11-01T12:00:00Z"),
        member("403", PEOPLE.lyricsPending, TEAMS.lyrics, "Lyrics", "U", null),
      ], meta: { count: 3, total_count: 3 } }),
      assignments(TEAMS.greeter, "Greeter", "601", [PEOPLE.greeterConfirmed, PEOPLE.riley, PEOPLE.sam, PEOPLE.morgan, PEOPLE.casey, PEOPLE.drew]),
      read("team_leaders", { data: [], meta: { count: 0, total_count: 0 } }, { team_id: TEAMS.greeter }),
      assignments(TEAMS.nursery, "Nursery", "602", [PEOPLE.nurseryConfirmed]),
      read("team_leaders", { data: [{ type: "TeamLeader", id: "551", attributes: {},
        relationships: { people: rel("Person", PEOPLE.nurseryLeader), team: rel("Team", TEAMS.nursery) } }], meta: { count: 1, total_count: 1 } }, { team_id: TEAMS.nursery }),
      assignments(TEAMS.lyrics, "Lyrics", "603", [PEOPLE.lyricsPending]),
      read("team_leaders", { data: [], meta: { count: 0, total_count: 0 } }, { team_id: TEAMS.lyrics }),
      // Avery: confirmed greeter three Sundays running (Nov 8, 15, 22).
      ...personReads(PEOPLE.greeterConfirmed, [
        schedule("701", "92902586", "C", "Greeter", ["9101"], "2026-11-08"), schedule("702", "92902582", "C", "Greeter", ["9102"], "2026-11-15"),
        schedule("703", "92902197", "C", "Greeter", ["9001"]),
      ], [sunday("9101", "2026-11-08"), sunday("9102", "2026-11-15"), planTime("9001", SERVICE.starts_at, SERVICE.ends_at)], []),
      // Blake: confirmed nursery two Sundays running (Nov 15, 22).
      ...personReads(PEOPLE.nurseryConfirmed, [
        schedule("711", "92902582", "C", "Nursery", ["9102"], "2026-11-15"), schedule("712", "92902197", "C", "Nursery", ["9001"]),
      ], [sunday("9102", "2026-11-15"), planTime("9001", SERVICE.starts_at, SERVICE.ends_at)], []),
      ...personReads(PEOPLE.lyricsPending, [schedule("721", "92902197", "U", "Lyrics", ["9001"])],
        [planTime("9001", SERVICE.starts_at, SERVICE.ends_at)], []),
      // Riley: free — a suggestion, not a ranking and not a promise of willingness.
      ...personReads(PEOPLE.riley, [], [], []),
      // Sam: blockout across the weekend — excluded.
      ...personReads(PEOPLE.sam, [], [], [{ type: "Blockout", id: "801", attributes: { starts_at: "2026-11-21T05:00:00Z", ends_at: "2026-11-23T05:00:00Z", repeat_frequency: "no_repeat" } }]),
      // Morgan: confirmed elsewhere at the same time — excluded.
      ...personReads(PEOPLE.morgan, [schedule("731", "92900001", "C", "Parking", ["9201"])],
        [planTime("9201", "2026-11-22T14:00:00Z", "2026-11-22T15:00:00Z")], []),
      // Casey: unanswered sent request overlapping — possible conflict.
      ...personReads(PEOPLE.casey, [schedule("741", "92900002", "U", "Usher", ["9301"])],
        [planTime("9301", SERVICE.starts_at, SERVICE.ends_at)], []),
      // Drew: repeating blockout — first occurrence alone can't settle it, so it stays unverified.
      ...personReads(PEOPLE.drew, [], [], [{ type: "Blockout", id: "802", attributes: { starts_at: "2026-10-04T13:00:00Z", ends_at: "2026-10-04T17:00:00Z", repeat_frequency: "every_1_week" } }]),
      // The church's time zone, read last among the Services reads, as the native check reads it.
      read("organization", { data: { type: "Organization", id: "1001", attributes: { time_zone: FICTIONAL_ZONE } } }),
    ],
  };
}

/**
 * People background-check reads (kids rules) for the people scheduled on Nursery and Lyrics, as the native
 * check reads them (cleared checks only): Blake has none current on file; Cameron's runs out the day before.
 */
export function withFictionalBackgroundChecks(capture: SundayCapture): SundayCapture {
  const checks = (person: string, data: unknown[]): SundayRead => read("people_background_checks",
    { data, meta: { count: data.length, total_count: data.length } }, { people_person_id: person });
  return { ...capture, reads: [...capture.reads,
    checks(PEOPLE.nurseryConfirmed, []),
    checks(PEOPLE.lyricsPending, [{ type: "BackgroundCheck", id: "951", attributes: { status: "complete_clear", current: true, expires_on: "2026-11-21" },
      relationships: { person: rel("Person", PEOPLE.lyricsPending) } }]),
  ] };
}

export const LATER = "2026-11-20T17:15:00Z";

/**
 * The same Sunday checked again two hours later. Only Nursery changed: the confirmed volunteer
 * declined and Planning Center now reports two remaining requests. Greeter is untouched, so a
 * decision there must stay resolved.
 */
export function nov22LaterCapture(): SundayCapture {
  const capture = nov22Capture();
  capture.started_at = "2026-11-20T17:14:50Z"; capture.completed_at = "2026-11-20T17:15:10Z";
  capture.reads = capture.reads.map(r => ({ ...r, checked_at: LATER }));
  const needs = capture.reads.find(r => r.collection === "needed_positions")!.body!.data as { attributes: { quantity: number; team_position_name: string } }[];
  needs.find(n => n.attributes.team_position_name === "Nursery")!.attributes.quantity = 2;
  const members = capture.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: { status: string } }[];
  members.find(m => m.id === "402")!.attributes.status = "D";
  const blake = capture.reads.find(r => r.collection === "person_schedules" && r.person_id === PEOPLE.nurseryConfirmed)!.body!.data as { id: string; attributes: { status: string } }[];
  blake.find(s => s.id === "712")!.attributes.status = "D";
  return capture;
}
