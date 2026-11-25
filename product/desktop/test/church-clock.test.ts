// Every time from the church's system that says when something happens at church (a service, a role, a room booking, a
// group meeting, a follow-up's due date) is said on the church's clock, the one the service's own heading already used,
// whatever zone this Mac is on; a time that says when Ozzie or the person did something (checked, decided) stays on this
// Mac's clock. 0.5.4, on CI in UTC, headed the fictional Wednesday "9:30 AM" and said "Nursery · Wednesday, November 25
// at 2:30 PM" on its card. Each check draws the same fixed data with this process on the church's own zone (New York),
// and on others (UTC, as CI runs; Tokyo, a day ahead), set per render through process.env.TZ (zone.ts). Fictional data.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { openExample } from "../src/example-now.js";
import { installFakeDom } from "./fake-dom.js";
import { inZone, inZoneAsync } from "./zone.js";
import { PREPARE_NOTE, SundayPage } from "../src/sunday-page.js";
import { SundayReadyBrief } from "../src/sunday-ready.js";
import { DayProvider } from "../src/day-words.js";
import { decisionLines } from "../src/today-groups.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { FICTIONAL_ZONE, nov22Capture, PEOPLE, TEAMS, withFictionalBackgroundChecks } from "../../../core/src/fictional-sunday.js";
import { FICTIONAL_ROOM, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { sundayOperations, type SundayOperations } from "../../../core/src/operations-capture.js";
import { applyDecisions, decide, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { otherClock, SUNDAY_WORDS } from "../../../core/src/service-day.js";
import { buildRewordRequest, templateDraft } from "../../../core/src/draft-request.js";
import { escalationDraft } from "../../../core/src/escalation-draft.js";
import { reminderDraft } from "../../../core/src/reminder-draft.js";
import type { FeedbackEntry } from "../../../core/src/finding-feedback.js";
import { wednesdayCapture, wednesdayWords } from "../../../core/test/fixtures/service-days/wednesday.js";
import { twoTimes } from "../../../core/test/fixtures/service-days/two-times.js";
import { exampleRequest } from "../src/ai-parts.js";
// The example as written (its own week): these tests read its fixed November 22 dates (example-now.ts).
openExample("2026-11-21T12:00:00Z");

const dom = installFakeDom({ focus: true });
type El = NonNullable<ReturnType<typeof dom.button>>;

/** The fictional church's zone, and this Mac on it, on CI's clock, and a day ahead of it. */
const CHURCH = FICTIONAL_ZONE;
const ZONES = [CHURCH, "UTC", "Asia/Tokyo"] as const;
/** How the heading names the church's clock on a Mac whose clock reads its times differently (zoneLabel). */
const NAMED = " Eastern Time (New York)";
const AT = "2026-11-20T15:10:00Z";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const eyebrow = (html: string) => /<p class="eyebrow">(.*?)<\/p>/u.exec(html)![1]!;

const kids: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3, rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 0 }],
  kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }, { team_id: TEAMS.lyrics, min_confirmed: 1 }] };
/** Avery (Greeter, confirmed) has a blockout all that Sunday in New York, so the page has a blockout card too. */
function withBlockout(capture: SundayCapture): SundayCapture {
  capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.greeterConfirmed)!.body = {
    data: [{ type: "Blockout", id: "b1", attributes: { repeat_frequency: "no_repeat", starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T04:59:59Z" } }],
    meta: { count: 1, total_count: 1 } };
  return capture;
}
/** The fictional Sunday with every kind of card that has a time: roles, kids rules, a background check, a blockout, a room overlap, a follow-up and a group meeting. */
const everything = () => withBlockout(withFictionalOperations(withFictionalBackgroundChecks(nov22Capture())));
function page(b: SundayBrief, names: Record<string, string>, operations: SundayOperations | null = null, decisions: SundayDecision[] = [], entries: FeedbackEntry[] = []) {
  return renderToStaticMarkup(React.createElement(SundayPage, {
    brief: b, names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
    canReword: false, decisions, onDecisions: () => undefined, operations, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    ...(entries.length ? { feedback: { entries, onEntries: () => undefined } } : {}),
  }));
}
/** A time on this Mac's clock as the page says one ("Fri, Nov 20, 10:00 AM"), after the words that say it's a check's. */
const MAC_TIME = /(Checked|checked|reads ·|You decided this) ([A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2}\s[AP]M)/gu;
const macTimes = (t: string) => [...t.matchAll(MAC_TIME)].map(m => `${m[1]} ${m[2]}`);
/** The page's words with this Mac's times and the heading's zone name taken out: what must read the same on every clock. */
const churchPart = (t: string) => t.replace(MAC_TIME, "$1 <this Mac's clock>").replace(NAMED, "");

describe("the Services page says every service and role time on the church's clock, whatever zone this Mac is on", () => {
  const capture = everything();
  const b = buildSundayBrief(capture, kids, capture.completed_at, true);
  const ops = sundayOperations(capture, kids, {});
  const drawn = Object.fromEntries(ZONES.map(z => [z, inZone(z, () => text(page(b, capture.names, ops)))])) as Record<typeof ZONES[number], string>;

  it("each kind of card says the church's time, the same on every clock", () => {
    for (const z of ZONES) {
      const t = drawn[z];
      for (const said of [
        "Sunday, November 22 · 9:30 AM",
        "Greeter · Sunday, November 22 at 9:30 AM", "Nursery · Sunday, November 22 at 9:30 AM", "Lyrics · Sunday, November 22 at 9:30 AM",
        "Only 1 confirmed person in Nursery at 9:30 AM.", "No confirmed people in Lyrics at 9:30 AM.",
        "Scheduled for Nursery at 9:30 AM. Your Church rules ask for a current background check",
        "Avery Brightwater is scheduled for Greeter at 9:30 AM and has a blockout in Planning Center at that time.",
        "Sanctuary (fictional) · Sunday, November 22 at 10:45 AM", "Sanctuary (fictional) has overlapping bookings from 10:45 AM–11:00 AM.",
        "One booking (9:00 AM–11:00 AM) and another booking (10:45 AM–11:15 AM) overlap",
        "It was due Mon, Oct 26, 5:27 PM.",
        "Their group meets 9:30 AM–10:30 AM, while they're pending for Lyrics.",
      ]) expect(t, `${z}: ${said}`).toContain(said);
    }
  });

  it("apart from when Ozzie checked and the zone's name, the page reads word for word the same on every clock", () => {
    expect(churchPart(drawn.UTC)).toBe(churchPart(drawn[CHURCH]));
    expect(churchPart(drawn["Asia/Tokyo"])).toBe(churchPart(drawn[CHURCH]));
  });

  it("when Ozzie checked is on this Mac's clock", () => {
    expect(new Set(macTimes(drawn[CHURCH]).map(m => m.replace(/^\S+( ·)? /u, "")))).toEqual(new Set(["Fri, Nov 20, 10:00 AM"]));
    expect(new Set(macTimes(drawn.UTC).map(m => m.replace(/^\S+( ·)? /u, "")))).toEqual(new Set(["Fri, Nov 20, 3:00 PM"]));
    expect(new Set(macTimes(drawn["Asia/Tokyo"]).map(m => m.replace(/^\S+( ·)? /u, "")))).toEqual(new Set(["Sat, Nov 21, 12:00 AM"]));
    expect(drawn.UTC).toContain("Fictional example data · ");
    expect(drawn.UTC).toMatch(/ reads · Fri, Nov 20, 3:00 PM /u);
  });

  it("a decision the leader made says when on this Mac's clock, beside its role's time on the church's", () => {
    const nursery = b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    const made = [decide(nursery, "not-needed", "Only two babies registered", AT)];
    const say = (z: string) => inZone(z, () => text(page(b, capture.names, null, made)));
    expect(say(CHURCH)).toContain("You decided this Fri, Nov 20, 10:10 AM.");
    expect(say("UTC")).toContain("You decided this Fri, Nov 20, 3:10 PM.");
    for (const z of ZONES) expect(say(z)).toMatch(/Resolved by you — this Sunday only Nursery · Sunday, November 22 at 9:30 AM/u);
  });
});

describe("the heading names the church's zone only when this Mac's clock reads its times differently", () => {
  const live = buildSundayBrief(nov22Capture(), kids, nov22Capture().completed_at);
  const head = (z: string) => inZone(z, () => eyebrow(page(live, nov22Capture().names)));
  const plan = '<span class="eyebrow-plan">Ozzie Demo — Main Sunday (fictional)</span>';

  it("on the church's own clock: no zone, as before", () => {
    expect(head(CHURCH)).toBe(`Sunday, November 22 · 9:30 AM · ${plan}`);
    // Another zone's name, the same clock on the service's day: nothing to tell apart.
    expect(head("America/Toronto")).toBe(`Sunday, November 22 · 9:30 AM · ${plan}`);
  });
  it("on another clock: the church's zone after its times, in the words Keeping watch and Settings use", () => {
    expect(head("UTC")).toBe(`Sunday, November 22 · 9:30 AM${NAMED} · ${plan}`);
    expect(head("America/Los_Angeles")).toBe(`Sunday, November 22 · 9:30 AM${NAMED} · ${plan}`);
  });
  it("whose times are on no known clock name none", () => {
    expect(inZone("UTC", () => eyebrow(page({ ...live, time_zone: null }, nov22Capture().names)))).toBe(`Sunday, November 22 · 2:30 PM · ${plan}`);
  });
  it("two service times: the zone is named once, after both", () => {
    const two = buildSundayBrief(twoTimes(), kids, twoTimes().completed_at, true);
    const head = (z: string) => inZone(z, () => /<p class="eyebrow">([^<]*)</u.exec(page(two, twoTimes().names))![1]);
    expect(head(CHURCH)).toBe("Sunday, November 22 · 9:30 AM and 11:00 AM · ");
    expect(head("UTC")).toBe(`Sunday, November 22 · 9:30 AM and 11:00 AM${NAMED} · `);
  });
});

describe("several services: a part's heading and its cards agree on every clock (CI's 0.5.4 case)", () => {
  const wed = buildSundayBrief(wednesdayCapture(), kids, wednesdayCapture().completed_at);
  const show = (z: string) => inZone(z, () => renderToStaticMarkup(React.createElement(DayProvider, { value: wednesdayWords() }, React.createElement(SundayPage, {
    brief: wed, names: wednesdayCapture().names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true,
    canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    part: { name: "Youth Night", waiting: null, opsWith: "Sunday Morning" },
  }))));

  it("in New York, as before; in UTC, the same times with the zone named, never 2:30 PM", () => {
    expect(text(eyebrow(show(CHURCH)))).toBe("Wednesday, November 25 · 9:30 AM · Youth Night (fictional) ");
    expect(text(eyebrow(show("UTC")))).toBe(`Wednesday, November 25 · 9:30 AM${NAMED} · Youth Night (fictional) `);
    for (const z of ZONES) {
      const t = text(show(z));
      expect(t, z).toContain("Nursery · Wednesday, November 25 at 9:30 AM");
      expect(t, z).toContain("Greeter · Wednesday, November 25 at 9:30 AM");
      expect(t, z).not.toContain("2:30 PM");
    }
  });
});

describe("notes say the service's time on the church's clock, on every clock", () => {
  const capture = nov22Capture();
  const names = capture.names;
  /** Lyrics' request was sent and has no answer: its card offers a reminder. */
  const sent = () => {
    const c = nov22Capture();
    (c.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[])
      .find(m => m.id === "403")!.attributes.notification_sent_at = "2026-11-18T12:00:00Z";
    return c;
  };
  const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
  const always: FeedbackEntry[] = [
    { type: "always", id: "a", kind: "pending", at: AT, action: "prepare-reminder", scope: { team_id: TEAMS.lyrics, position: "Lyrics" }, labels: {} },
    { type: "always", id: "b", kind: "needs-people", at: AT, action: "prepare-leader-note", scope: { team_id: TEAMS.nursery, position: "Nursery" }, labels: {} },
  ];

  it("a reminder and a note to the team's leader a Church rule prepared", () => {
    const b = buildSundayBrief(sent(), { ...rules, feedback: always }, AT, true);
    for (const z of ZONES) {
      const t = inZone(z, () => text(page(b, names, null, [], always)));
      expect(t, z).toContain("Just following up on the request to serve as Lyrics on Sunday, November 22 at 9:30 AM.");
      expect(t, z).toContain("Nursery on Sunday, November 22 at 9:30 AM still needs one more person.");
    }
  });

  it("the drafts themselves, and the note an AI may reword: the same words, the church's clock", () => {
    const b = buildSundayBrief(sent(), rules, AT, true);
    const greeter = b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;
    const nursery = b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    const lyrics = b.findings.find(f => f.kind === "pending")!;
    const words = (z: string) => inZone(z, () => [
      buildRewordRequest(templateDraft({ finding: greeter, person_id: greeter.people!.suggestions[0]!.person_id, sunday: b.plan.date, zone: b.time_zone }, names), "warmer", names).user,
      escalationDraft({ finding: nursery, leader_id: nursery.leaders![0]!, sunday: b.plan.date, zone: b.time_zone }).text,
      reminderDraft(lyrics, b.plan.date, b.time_zone).text,
    ]);
    const atChurch = words(CHURCH);
    expect(atChurch[0]).toContain("We still need one more person for Greeter on Sunday, November 22 at 9:30 AM. Would you be able to help?");
    expect(atChurch[1]).toContain("[Role] on Sunday, November 22 at 9:30 AM still needs one more person.");
    expect(atChurch[2]).toContain("serve as [Role] on Sunday, November 22 at 9:30 AM.");
    for (const z of ZONES) expect(words(z), z).toEqual(atChurch);
  });

  it("See exactly what is sent shows the same note the page sends, on the church's clock", () => {
    const sent = (z: string) => inZone(z, () => exampleRequest()!.user);
    expect(sent(CHURCH)).toContain("on Sunday, November 22 at 9:30 AM. Would you be able to help?");
    for (const z of ZONES) expect(sent(z), z).toBe(sent(CHURCH));
  });

  let unmount: (() => Promise<void>) | null = null;
  afterEach(async () => { await unmount?.(); unmount = null; });
  const isEl = (n: unknown): n is El => Boolean(n && (n as El).nodeType === 1);
  const all = (n: El): El[] => [n, ...(n.childNodes as unknown[]).filter(isEl).flatMap(all)];

  it("a note to one person, prepared from their row", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    for (const z of ZONES) {
      const said = await inZoneAsync(z, async () => {
        const host = dom.root.appendChild((dom.root.ownerDocument as unknown as { createElement(t: string): El }).createElement("div"));
        const root = createRoot(host as unknown as Element);
        await act(async () => {
          root.render(React.createElement(SundayPage, {
            brief: buildSundayBrief(capture, rules, capture.completed_at), names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false,
            configured: true, canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined,
            onExample: () => undefined, people: { granted: true },
          }));
        });
        unmount = async () => { await act(async () => { root.unmount(); }); dom.root.removeChild(host); };
        const greeter = all(dom.root).find(n => n.tagName === "ARTICLE" && (n.textContent ?? "").includes("Greeter still needs"))!;
        await act(async () => { dom.press(all(greeter).find(n => n.tagName === "BUTTON" && n.textContent === PREPARE_NOTE)!); });
        const note = all(greeter).find(n => n.getAttribute("role") === "region" && n.getAttribute("aria-label") === "Draft note")!;
        const t = note.textContent ?? "";
        await unmount(); unmount = null;
        return t;
      });
      expect(said, z).toContain("We still need one more person for Greeter on Sunday, November 22 at 9:30 AM.");
    }
  });
});

describe("Thursday's brief and Today say a role's time as its card does", () => {
  const capture = withFictionalBackgroundChecks(nov22Capture());
  const b = buildSundayBrief(capture, kids, "2026-11-20T15:05:00Z");

  it("the kids rule's line on the church's clock, and when it was read on this Mac's", () => {
    const say = (z: string) => inZone(z, () => text(renderToStaticMarkup(React.createElement(SundayReadyBrief, { brief: b, names: capture.names, onSunday: () => undefined }))));
    for (const z of ZONES) expect(say(z), z).toContain("Only 1 confirmed person in Nursery at 9:30 AM.");
    expect(say(CHURCH)).toContain("Read from Planning Center Fri, Nov 20, 10:00 AM.");
    expect(say("UTC")).toContain("Read from Planning Center Fri, Nov 20, 3:00 PM.");
  });

  it("Today's decision lines, already on the church's clock, agree with the cards in UTC", () => {
    const lines = inZone("UTC", () => decisionLines(applyDecisions(b, []).items, { rooms: 0, followUps: 0 }, b.time_zone!, SUNDAY_WORDS).named.map(l => l.text));
    expect(lines).toContain("Greeter: 1 more person needed, Sun 9:30 AM. 1 on the team is clear for that time.");
  });
});

describe("the week the clocks change", () => {
  const DAY = 86_400_000;
  /**
   * The same check three weeks earlier: its service on Sunday, November 1, 2026, the morning New York's clocks went back
   * (9:30 AM Eastern Standard Time), checked on the Friday before, still on daylight time. Every instant moves by the same
   * 21 days; Planning Center's local `sort_date` moves with them.
   */
  function weeksEarlier(capture: SundayCapture): SundayCapture {
    const shift = (iso: string) => new Date(Date.parse(iso) - 21 * DAY).toISOString();
    return JSON.parse(JSON.stringify(capture)
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})/gu, shift)
      .replace(/"(\d{4}-\d{2}-\d{2})"/gu, (_, d: string) => `"${shift(`${d}T00:00:00Z`).slice(0, 10)}"`)) as SundayCapture;
  }
  const capture = weeksEarlier(nov22Capture());
  const b = buildSundayBrief(capture, kids, capture.completed_at, true);

  it("a service just after the change is on the church's standard time, and the check before it on this Mac's daylight time", () => {
    expect(b.times).toEqual(["2026-11-01T14:30:00.000Z"]);
    const drawn = (z: string) => inZone(z, () => page(b, capture.names));
    for (const z of [CHURCH, "UTC", "Europe/London"]) {
      const t = text(drawn(z));
      expect(t, z).toContain("Greeter · Sunday, November 1 at 9:30 AM");
      expect(text(eyebrow(drawn(z))), z).toMatch(z === CHURCH ? /^Sunday, November 1 · 9:30 AM · Ozzie Demo/u : /^Sunday, November 1 · 9:30 AM Eastern Time \(New York\) · /u);
    }
    expect(text(drawn(CHURCH))).toContain("Checked Fri, Oct 30, 11:00 AM");
    expect(text(drawn("UTC"))).toContain("Checked Fri, Oct 30, 3:00 PM");
    expect(text(drawn("Europe/London"))).toContain("Checked Fri, Oct 30, 3:00 PM");
  });

  it("whose clock differs is worked out at each service time, not from today's offset", () => {
    // Phoenix keeps standard time all year; Denver's matches it only once its own clocks have gone back (November 1, 2 AM).
    expect(otherClock(["2026-11-01T16:30:00Z"], "America/Phoenix", "America/Denver")).toBe(false);
    expect(otherClock(["2026-10-25T16:30:00Z"], "America/Phoenix", "America/Denver")).toBe(true);
    // Any one time that reads differently is enough; no church zone, or one this Mac doesn't know, is none.
    expect(otherClock(["2026-11-01T16:30:00Z", "2026-10-25T16:30:00Z"], "America/Phoenix", "America/Denver")).toBe(true);
    expect(otherClock(["2026-11-22T14:30:00Z"], null, "UTC")).toBe(false);
    expect(otherClock(["2026-11-22T14:30:00Z"], "Not/AZone", "UTC")).toBe(false);
    expect(otherClock([], CHURCH, "UTC")).toBe(false);
  });
});
