// The church reads (People forms, Check-Ins, Registrations) stay on this Mac: they are never Services
// reads in the Sunday brief, and none of their labels, counts or submitters' names reaches an agent
// tool result, an Ask request or the copy shared with other AI apps. Fictional data only.
import { describe, expect, it } from "vitest";
import { buildSundayBrief } from "../src/sunday-brief.js";
import { CHURCH_COLLECTIONS, isChurchRead, type SundayCapture, type SundayRead, type SundayRules } from "../src/sunday-capture.js";
import { CHECKED, nov22Capture, TEAMS } from "../src/fictional-sunday.js";
import { HarnessSession } from "../src/harness/session.js";
import { HarnessTools } from "../src/harness/tools.js";
import { sharedCheckText, sharedEnvelopes } from "../mcp/snapshot.js";
import { AskSession, buildAskContext, prepareAsk } from "../src/ask.js";
import { allEnvelopes, harnessData, RULES } from "./harness/fixtures.js";

const CANARY = /Canary|Quill|Juniper/u;
const WINDOW = { starts_at: "2026-11-12T14:59:50Z", ends_at: "2026-11-20T14:59:50Z" };
const rel = (type: string, id: string) => ({ data: { type, id } });
const page = (data: unknown[], included?: unknown[]) => ({ data, ...(included ? { included } : {}), meta: { count: data.length, total_count: data.length } });
const read = (collection: string, body: SundayRead["body"] | undefined, extra: Partial<SundayRead> = {}, outcome = "ok"): SundayRead =>
  ({ collection, offset: 0, checked_at: CHECKED, outcome, ...(body ? { body } : {}), ...extra });

/** The fictional Sunday, plus every church read (some refused or failed), canary labels and a submitter's name. */
function withChurch(capture: SundayCapture): SundayCapture {
  const reads: SundayRead[] = [
    read("people_forms", page([{ type: "Form", id: "610", attributes: { archived: false } }])),
    read("people_form_submissions", page([{ type: "FormSubmission", id: "700", attributes: { created_at: "2026-11-15T15:00:00Z" },
      relationships: { form: rel("Form", "610"), person: rel("Person", "190") } }]), { form_id: "610", window: WINDOW }),
    read("checkins_events", page([{ type: "Event", id: "620", attributes: { archived_at: null } }])),
    read("checkins_locations", page([{ type: "Location", id: "650", attributes: { kind: "Location" }, relationships: { parent: { data: null } } }]), { checkins_event_id: "620" }),
    read("checkins_event_periods", page([{ type: "EventPeriod", id: "660", attributes: { starts_at: "2026-11-15T06:00:00Z", ends_at: "2026-11-16T06:00:00Z" },
      relationships: { event: rel("Event", "620") } }],
    [{ type: "EventTime", id: "630", attributes: { starts_at: "2026-11-15T14:00:00Z" }, relationships: { event: rel("Event", "620"), event_period: rel("EventPeriod", "660") } }]),
    { checkins_event_id: "620", window: WINDOW }),
    read("checkins_location_counts", page([{ type: "LocationEventTime", id: "670", attributes: { regular_count: 8, guest_count: 1, volunteer_count: 1 },
      relationships: { location: rel("Location", "650") } }]), { checkins_event_time_id: "630" }),
    read("registrations_signups", page([{ type: "Signup", id: "640", attributes: { archived: false, closed: false, close_at: "2026-11-27T00:00:00Z", maximum_capacity: 40 } }])),
    read("registrations_attendees", undefined, { signup_id: "640" }, "denied"),
    read("registrations_signups", undefined, { offset: 100 }, "timeout"),
  ];
  return {
    ...capture, reads: [...capture.reads, ...reads], forms: ["610"],
    names: { ...capture.names, "190": "Quill Fictional-Canary" },
    labels: { ...capture.labels, "form:610": "Canary Volunteer Form", "checkins_event:620": "Canary Kids", "checkins_location:650": "Juniper Nursery",
      "signup:640": "Canary Retreat" },
  };
}
const CHURCH_RULES: SundayRules = {
  ...RULES, forms: { on: true, watched: ["610"] }, checkIns: { rooms: [{ location_id: "650", team_id: TEAMS.nursery }] },
  kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2, name: "Juniper Nursery" }],
};

describe("Church reads stay on this Mac", () => {
  it("every church read is one of the eight church collections, and none is a Services read in the brief", () => {
    const plain = nov22Capture(), church = withChurch(nov22Capture());
    expect(church.reads.filter(isChurchRead).map(r => r.collection).every(c => CHURCH_COLLECTIONS.has(c))).toBe(true);
    const now = "2026-11-20T15:05:00Z";
    // Refused, failed or complete, church reads change nothing in the Sunday brief: same reads, failures, findings.
    expect(JSON.stringify(buildSundayBrief(church, CHURCH_RULES, now))).toBe(JSON.stringify(buildSundayBrief(plain, CHURCH_RULES, now)));
  });

  it("no church label, count or submitter's name is in any agent tool result, Ask request or shared-check file", async () => {
    const data = harnessData({ mode: "live", rules: CHURCH_RULES, capture: withChurch(nov22Capture()) });
    for (const envelope of await allEnvelopes(data)) expect(JSON.stringify(envelope), envelope.tool).not.toMatch(CANARY);
    const shared = await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => "2026-11-20T15:05:00Z" }));
    expect(shared.length).toBeGreaterThan(5);
    expect(sharedCheckText(shared, [], "2026-11-20T15:06:00Z", "B4K7Q2X9M3T8")).not.toMatch(CANARY);
    const session = new AskSession();
    const context = buildAskContext(session, { brief: data.brief!, names: data.capture!.names, organization: data.capture!.organization }, { timeZone: "America/New_York" })!;
    for (const question of ["Who is on Nursery this Sunday?", "How many checked in to the nursery last Sunday?", "How many signed up for the retreat?"]) {
      const asked = prepareAsk(session, context, question);
      if (asked.ok) expect(JSON.stringify(asked.asked.request), question).not.toMatch(CANARY);
    }
  });
});
