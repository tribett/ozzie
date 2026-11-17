// What Siri and Shortcuts hear from Ozzie (core/mcp/shortcuts.ts, ADR 0006): exact answers over the fictional Sunday in
// every state a saved check can be in, the switch and a missing or foreign copy saying nothing, and a sweep over every
// harness fixture proving an answer never holds a name, a label, a contact detail or background-check wording, and is
// made only of Ozzie's own words, numbers and dates. Fictional data only.
import { describe, expect, it } from "vitest";
import { hasContactDetail } from "../../src/ask.js";
import { backgroundWording } from "../../src/harness/background-wording.js";
import type { ToolEnvelope } from "../../src/harness/contract.js";
import { namedIn } from "../../src/harness/names.js";
import { HarnessSession } from "../../src/harness/session.js";
import { HarnessTools, type HarnessData } from "../../src/harness/tools.js";
import { sharedCheckText, sharedEnvelopes, type SharedTask } from "../../mcp/snapshot.js";
import { NO_CHECK, OFF, QUESTIONS, SHORTCUT_TOOLS, shortcutsAnswer, shortcutsEnvelopes, UNKNOWN_QUESTION } from "../../mcp/shortcuts.js";
import { FIXTURES, FRESH, harnessData, KIDS_RULES, LEAD_RULES, sourceStrings } from "../harness/fixtures.js";
import { decide } from "../../src/sunday-decisions.js";
import { CHECKED, nov22Capture, PEOPLE, withFictionalBackgroundChecks } from "../../src/fictional-sunday.js";

const COPY = "B4K7Q2X9M3T8";
const ZONE = "America/New_York";
const ms = (iso: string) => Date.parse(iso);

/** The overview the tools give for `data` at `now`, as native writes the copy for Shortcuts (no tasks). */
async function copyFor(data: HarnessData, now = FRESH): Promise<{ text: string; envelopes: ToolEnvelope[] }> {
  const envelopes = shortcutsEnvelopes(await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => now })));
  return { text: sharedCheckText(envelopes, [], now, COPY), envelopes };
}
const ask = (text: string | null, now: string, on = true, timeZone = ZONE) => shortcutsAnswer("sunday", { on, text, nowMs: ms(now), timeZone });
/** The overview envelope with its payload changed by `edit`, as a copy's text. */
function edited(envelope: ToolEnvelope, edit: (payload: Record<string, unknown>) => void, completeness = envelope.completeness): string {
  const copy = structuredClone(envelope) as ToolEnvelope & { payload: Record<string, unknown> };
  edit(copy.payload);
  return sharedCheckText([{ ...copy, completeness }], [], FRESH, COPY);
}

describe("the questions", () => {
  it("are a fixed list, and the copy holds only the Sunday overview", () => {
    expect(QUESTIONS).toEqual(["sunday"]);
    expect(SHORTCUT_TOOLS).toEqual(["sunday.overview"]);
  });

  it("says only that it's turned off while the switch is off, whatever the copy holds", async () => {
    const { text } = await copyFor(harnessData({ mode: "live" }));
    expect(ask(text, FRESH, false)).toBe(OFF);
    expect(ask(null, FRESH, false)).toBe(OFF);
    expect(OFF).toBe("Asking Ozzie from Siri and Shortcuts is turned off in Ozzie's Settings.");
  });

  it("answers a question it doesn't know with the same fixed words, on or off", async () => {
    const { text } = await copyFor(harnessData({ mode: "live" }));
    for (const question of ["", "Sunday", "rooms", "sunday ", "who is serving", "../sunday"]) {
      expect(shortcutsAnswer(question, { on: true, text, nowMs: ms(FRESH), timeZone: ZONE })).toBe(UNKNOWN_QUESTION);
      expect(shortcutsAnswer(question, { on: false, text, nowMs: ms(FRESH), timeZone: ZONE })).toBe(UNKNOWN_QUESTION);
    }
  });

  it("says there's no saved check for a missing copy, one outside the format, or one holding anything but the overview", async () => {
    const data = harnessData({ mode: "live" });
    const { text } = await copyFor(data);
    const all = sharedCheckText(await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => FRESH })), [], FRESH, COPY);
    const task: SharedTask = { kind: "check", skill_id: "sunday-ready", state: "verified", created_at: FRESH, updated_at: FRESH, failure: null, events: [] };
    const withTask = sharedCheckText(JSON.parse(text).envelopes, [task], FRESH, COPY);
    const notOverview = sharedCheckText((await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => FRESH }))).filter(e => e.tool === "rules.current"), [], FRESH, COPY);
    for (const bad of [null, "", "{", "null", "[]", all, withTask, notOverview, text.replace("[Role 1]", "Avery Brightwater"),
      text.replace("\"mode\":\"live\"", "\"mode\":\"pretend\""), text.replace(COPY, "AVERY1234567")]) {
      expect(ask(bad, FRESH)).toBe(NO_CHECK);
    }
    expect(NO_CHECK).toBe("Ozzie has no saved check to answer from. Open Ozzie to check Sunday.");
  });
});

describe("the answer to \"sunday\"", () => {
  it("gives open spots across roles and who is pending, with when it was checked", async () => {
    const { text } = await copyFor(harnessData({ mode: "live" }));
    expect(ask(text, FRESH)).toBe("Sunday, November 22 has 2 open spots across 2 roles. 1 person is pending, and Planning Center shows the request hasn't been sent yet. "
      + "Checked in Planning Center today at 10:00 AM.");
  });

  it("speaks of a check more than 30 minutes old in the past tense and says things may have changed", async () => {
    // Written while it was current; Ozzie was closed and nothing rewrote it.
    const { text } = await copyFor(harnessData({ mode: "live" }));
    expect(ask(text, "2026-11-20T15:31:00Z")).toBe("When Ozzie last checked, Sunday, November 22 had 2 open spots across 2 roles. "
      + "1 person was pending, and Planning Center showed the request hadn't been sent yet. Checked in Planning Center today at 10:00 AM. Things may have changed since then; open Ozzie to see the latest.");
    expect(ask(text, "2026-11-21T14:00:00Z")).toContain("Checked in Planning Center yesterday at 10:00 AM.");
    expect(ask(text, "2026-11-21T14:00:00Z")).toMatch(/^When Ozzie last checked, /u);
    // At exactly 30 minutes it is still current, as in Ozzie.
    expect(ask(text, "2026-11-20T15:30:00Z")).toMatch(/^Sunday, November 22 has /u);
  });

  it("gives no counts from a check Ozzie itself marked out of date", async () => {
    const { text } = await copyFor(harnessData({ mode: "live", now: "2026-11-20T17:00:00Z" }), "2026-11-20T17:00:00Z");
    expect(ask(text, "2026-11-20T17:01:00Z")).toBe("Ozzie's last look at Planning Center is too old to say how Sunday, November 22 stands. "
      + "Checked in Planning Center today at 10:00 AM. Open Ozzie to check again.");
  });

  it("says a saved copy of a check is one, in the past tense", async () => {
    const { text } = await copyFor(harnessData({ mode: "recording" }));
    expect(ask(text, "2026-11-21T14:00:00Z")).toBe("This is from a saved copy of a check, not a live look at Planning Center. "
      + "Sunday, November 22 had 2 open spots across 2 roles. 1 person was pending, and Planning Center showed the request hadn't been sent yet. Checked in Planning Center yesterday at 10:00 AM.");
  });

  it("says the fictional example is an example, whenever it's asked", async () => {
    const { text } = await copyFor(harnessData());
    // No check of Planning Center is behind it, so no check time is said, whatever the clock (review K2 N2).
    const answer = "This is Ozzie's fictional example, not a real church; no check of Planning Center is behind it. "
      + "Sunday, November 22 has 2 open spots across 2 roles. 1 person is pending, and Planning Center shows the request hasn't been sent yet.";
    for (const now of ["2026-11-15T18:00:00Z", "2026-11-20T18:00:00Z", "2026-12-01T18:00:00Z"]) {
      expect(ask(text, now)).toBe(answer);
      expect(ask(text, now)).not.toMatch(/Checked|November 20|today|yesterday/u);
    }
  });

  it("says when the Sunday it checked has passed, instead of how it stood", async () => {
    const { text } = await copyFor(harnessData({ mode: "live" }));
    expect(ask(text, "2026-11-23T15:00:00Z")).toBe("Ozzie's last check was for Sunday, November 22, which has passed. "
      + "Checked in Planning Center on Friday, November 20 at 10:00 AM. Open Ozzie to check the next Sunday.");
  });

  it("labels a check with reads that didn't complete as worth a look", async () => {
    const data = FIXTURES.find(([label]) => label === "a read that didn't complete")![1]();
    const { text } = await copyFor(data);
    expect(ask(text, FRESH)).toBe("Sunday, November 22 has 2 open spots across 2 roles. 1 person is pending, and Planning Center shows the request hasn't been sent yet. "
      + "Worth a look: part of the check couldn't be read, so this may be incomplete. Checked in Planning Center today at 10:00 AM.");
  });

  it("leaves out what the leader marked as handled, and counts teams without a confirmed lead", async () => {
    const need = harnessData({ rules: LEAD_RULES }).brief!.findings.find(f => f.kind === "needs-people")!;
    const data = harnessData({ mode: "live", rules: LEAD_RULES, decisions: [decide(need, "covered-outside", "Avery's sister said yes, call 555-201-3344", CHECKED)] });
    const { text } = await copyFor(data);
    expect(ask(text, FRESH)).toBe("Sunday, November 22 has 1 open spot across 1 role. 1 team doesn't have a confirmed lead. 1 person is pending, and Planning Center shows the request hasn't been sent yet. "
      + "You marked 1 as handled yourself. Checked in Planning Center today at 10:00 AM.");
  });

  it("counts kids teams short of confirmed people and says some findings are shown only in Ozzie, never what they are", async () => {
    const data = harnessData({ mode: "live", rules: KIDS_RULES, capture: withFictionalBackgroundChecks(nov22Capture()) });
    const { text } = await copyFor(data);
    expect(ask(text, FRESH)).toBe("Sunday, November 22 has 2 open spots across 2 roles. 2 kids teams have fewer confirmed people than your Church rules ask. "
      + "1 person is pending, and Planning Center shows the request hasn't been sent yet. Some findings are shown only in Ozzie. Checked in Planning Center today at 10:00 AM.");
  });

  it("says when no role still needs people, and counts roles when Planning Center's spot count isn't known", async () => {
    const { envelopes } = await copyFor(harnessData({ mode: "live" }));
    const overview = envelopes[0]!;
    const none = edited(overview, p => { p["findings"] = []; p["needs_a_decision"] = 0; p["worth_a_look"] = 0; });
    expect(ask(none, FRESH)).toBe("No roles for Sunday, November 22 still need people. Checked in Planning Center today at 10:00 AM.");
    const unknown = edited(overview, p => { for (const f of p["findings"] as Record<string, unknown>[]) if (f["kind"] === "needs people") f["remaining"] = "not known"; });
    expect(ask(unknown, FRESH)).toMatch(/^Sunday, November 22 has 2 roles that still need people\. /u);
    const one = edited(overview, p => { p["findings"] = (p["findings"] as Record<string, unknown>[]).filter(f => f["role"] !== "[Role 2]"); });
    expect(ask(one, FRESH)).toMatch(/^Sunday, November 22 has 1 open spot across 1 role\. /u);
    // The same role at two times is one role.
    const twice = edited(overview, p => { for (const f of p["findings"] as Record<string, unknown>[]) if (f["role"] === "[Role 2]") f["role"] = "[Role 1]"; });
    expect(ask(twice, FRESH)).toMatch(/^Sunday, November 22 has 2 open spots across 1 role\. /u);
    const noDate = edited(overview, p => { p["sunday"] = "not known"; });
    expect(ask(noDate, FRESH)).toMatch(/^The chosen Sunday has 2 open spots across 2 roles\. /u);
  });

  it("says who is pending once, with requests sent apart from those not sent yet, in the Sunday page's words (review K M1, K2 N3)", async () => {
    const { envelopes } = await copyFor(harnessData({ mode: "live" }));
    const pending = (request: string, n: number) => ({ fact: `f${40 + n}`, kind: "pending", tone: "worth a look", role: "[Role 3]",
      time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" }, person: `[Person ${n}]`, request });
    const mixed = edited(envelopes[0]!, p => {
      p["findings"] = [...(p["findings"] as Record<string, unknown>[]).filter(f => f["kind"] !== "pending"),
        pending("request sent, no answer yet", 1), pending("request sent, no answer yet", 2), pending("request not sent yet", 3)];
    });
    expect(ask(mixed, FRESH)).toBe("Sunday, November 22 has 2 open spots across 2 roles. 3 people are pending: 2 requests were sent with no answer yet, "
      + "and Planning Center shows 1 request hasn't been sent yet. Checked in Planning Center today at 10:00 AM.");
    expect(ask(mixed, "2026-11-20T16:00:00Z")).toContain("3 people were pending: 2 requests had been sent with no answer yet, "
      + "and Planning Center showed 1 request hadn't been sent yet.");
    // One person pending for two roles is one person; only requests sent.
    const twice = edited(envelopes[0]!, p => {
      p["findings"] = [...(p["findings"] as Record<string, unknown>[]).filter(f => f["kind"] !== "pending"),
        pending("request sent, no answer yet", 1), { ...pending("request sent, no answer yet", 1), fact: "f49", role: "[Role 1]" }];
    });
    expect(ask(twice, FRESH)).toContain("1 person is pending: the requests were sent and there's no answer yet.");
    const one = edited(envelopes[0]!, p => {
      p["findings"] = [...(p["findings"] as Record<string, unknown>[]).filter(f => f["kind"] !== "pending"), pending("request sent, no answer yet", 1)];
    });
    expect(ask(one, FRESH)).toContain("1 person is pending: the request was sent and there's no answer yet.");
    expect(ask(one, "2026-11-20T16:00:00Z")).toContain("1 person was pending: the request had been sent and there was no answer yet.");
    // Never that anyone was asked when no request went out.
    const unsent = await copyFor(harnessData({ mode: "live" }));
    expect(ask(unsent.text, FRESH)).not.toMatch(/accepted|answered|sent and/u);
  });

  it("warns that a recording with reads that didn't complete may be incomplete (review K M2)", async () => {
    const capture = nov22Capture();
    capture.reads = capture.reads.map(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.drew ? { ...r, outcome: "timeout" } : r);
    const { text } = await copyFor(harnessData({ mode: "recording", capture }));
    expect(JSON.parse(text).envelopes[0].completeness).toBe("stale");
    expect(ask(text, "2026-11-21T14:00:00Z")).toBe("This is from a saved copy of a check, not a live look at Planning Center. "
      + "Sunday, November 22 had 2 open spots across 2 roles. 1 person was pending, and Planning Center showed the request hadn't been sent yet. "
      + "Worth a look: part of the check couldn't be read, so this may be incomplete. Checked in Planning Center yesterday at 10:00 AM.");
  });

  it("says a list too long to say in full was too long, with every count as a least, never that it couldn't be read (review K M2)", async () => {
    const { envelopes } = await copyFor(harnessData({ mode: "live" }));
    const cut = edited(envelopes[0]!, p => { p["left_out_for_length"] = 30; }, "partial");
    expect(ask(cut, FRESH)).toBe("Sunday, November 22 has at least 2 open spots across at least 2 roles. At least 1 person is pending, and Planning Center shows the request hasn't been sent yet. "
      + "Worth a look: the list was too long to say in full, so there may be more than this. Checked in Planning Center today at 10:00 AM.");
    expect(ask(cut, FRESH)).not.toContain("couldn't be read");
    // A recording cut for length (completeness stays "stale") says the same.
    const recording = (await copyFor(harnessData({ mode: "recording" }))).envelopes[0]!;
    expect(ask(edited(recording, p => { p["left_out_for_length"] = 3; }), "2026-11-21T14:00:00Z"))
      .toContain("Worth a look: the list was too long to say in full, so there may be more than this.");
    // With no open role in the part that fit, it doesn't claim none need people.
    const none = edited(envelopes[0]!, p => { p["findings"] = []; p["left_out_for_length"] = 12; }, "partial");
    expect(ask(none, FRESH)).toMatch(/^None of the roles Ozzie could count for Sunday, November 22 still need people\. /u);
    expect(ask(none, "2026-11-20T16:00:00Z")).toMatch(/^When Ozzie last checked, none of the roles Ozzie could count for Sunday, November 22 still needed people\. /u);
  });

  it("says a check time later than this Mac's clock can't be trusted to be current, with no counts (review K L1)", async () => {
    const { text } = await copyFor(harnessData({ mode: "live" }));
    const ahead = "The time on Ozzie's last check is later than this Mac's clock, so Ozzie can't tell how current it is. "
      + "Checked in Planning Center on Friday, November 20 at 10:00 AM. Open Ozzie to check again.";
    expect(ask(text, "2026-11-19T15:00:00Z")).toBe(ahead);
    expect(ask(text, "2026-11-20T14:54:00Z")).toBe(ahead.replace("on Friday, November 20", "today"));
    // Within five minutes it is the same clock.
    expect(ask(text, "2026-11-20T14:56:00Z")).toMatch(/^Sunday, November 22 has /u);
    const recording = await copyFor(harnessData({ mode: "recording" }));
    expect(ask(recording.text, "2026-11-19T15:00:00Z")).toBe(ahead);
  });

  it("says kids teams and leads Ozzie isn't sure of as worth a look, never as fact (review K L2)", async () => {
    const data = harnessData({ mode: "live", rules: KIDS_RULES, capture: withFictionalBackgroundChecks(nov22Capture()) });
    const { envelopes } = await copyFor(data);
    const unsure = edited(envelopes[0]!, p => {
      const findings = p["findings"] as Record<string, unknown>[];
      for (const f of findings) if (f["kind"] === "fewer confirmed than the church rules ask" && f["role"] === "[Role 3]") f["tone"] = "worth a look";
      findings.push({ fact: "f30", kind: "lead couldn't be confirmed", tone: "worth a look", role: "[Role 1]",
        time: { starts_at: "2026-11-22T09:30-05:00", ends_at: "2026-11-22T10:30-05:00" } });
    });
    expect(ask(unsure, FRESH)).toBe("Sunday, November 22 has 2 open spots across 2 roles. 1 kids team has fewer confirmed people than your Church rules ask. "
      + "1 person is pending, and Planning Center shows the request hasn't been sent yet. Worth a look: 1 kids team may have fewer confirmed people than your Church rules ask. "
      + "Worth a look: 1 team has a lead scheduled whose answer or serving time couldn't be confirmed. Some findings are shown only in Ozzie. "
      + "Checked in Planning Center today at 10:00 AM.");
    expect(ask(unsure, "2026-11-20T16:00:00Z")).toContain("Worth a look: 1 kids team may have had fewer confirmed people than your Church rules ask. "
      + "Worth a look: 1 team had a lead scheduled whose answer or serving time couldn't be confirmed.");
    expect(ask(unsure, FRESH)).not.toMatch(/teams? (?:doesn't|don't) have a confirmed lead/u);
  });

  it("counts a kids team short for certain at one time and unsure at another once, as the fact (review K2 N1)", async () => {
    const data = harnessData({ mode: "live", rules: KIDS_RULES, capture: withFictionalBackgroundChecks(nov22Capture()) });
    const { envelopes } = await copyFor(data);
    const both = edited(envelopes[0]!, p => {
      (p["findings"] as Record<string, unknown>[]).push({ fact: "f31", kind: "fewer confirmed than the church rules ask", tone: "worth a look", role: "[Role 2]",
        time: { starts_at: "2026-11-22T11:00-05:00", ends_at: "2026-11-22T12:00-05:00" }, confirmed: 1, needed: 2, asked_no_answer: 0, request_not_sent: 0,
        ages: "confirmed people counted; ages not checked" });
    });
    const said = ask(both, FRESH);
    expect(said).toContain("2 kids teams have fewer confirmed people than your Church rules ask.");
    expect(said).not.toContain("kids team may");
  });

  it("says the time in UTC when the Mac's time zone isn't one it knows", async () => {
    const { text } = await copyFor(harnessData({ mode: "live" }));
    expect(ask(text, FRESH, true, "Not/AZone")).toContain("Checked in Planning Center today at 3:00 PM UTC.");
  });
});

/** Every word an answer may hold: Ozzie's own, the names of months and days. Anything else would have come from the copy. */
const OWN_WORDS = new Set(`
  asking ozzie from siri and shortcuts is turned off in ozzie's settings has no saved check to answer open sunday
  answers only here the setup steps are under
  has had open spot spots across role roles that still need needs needed people request requests hasn't haven't hadn't been accepted yet
  team teams doesn't don't didn't have a confirmed lead kids fewer than your church rules ask you marked as handled yourself
  some findings shown worth look part of the couldn't be read so this may incomplete checked planning center today yesterday at on am pm utc
  when last things changed since then see latest is too old to say how stands again copy not live fictional example real church
  ozzie's was for which passed next chosen
  pending person is are was were with request sent no least list long full more whose answer or serving time
  later mac's clock tell current could can't it there's there shows showed none of count behind
  monday tuesday wednesday thursday friday saturday
  january february march april may june july august september october november december
`.split(/\s+/u).filter(Boolean));

describe("what an answer can hold", () => {
  const nows = ["2026-11-19T15:00:00Z", FRESH, "2026-11-20T16:00:00Z", "2026-11-21T14:00:00Z", "2026-11-23T15:00:00Z", "2026-12-01T18:00:00Z"];

  it.each(FIXTURES)("%s: no name, place name, typed reason, label, contact detail or background-check wording, only Ozzie's own words", async (_label, make) => {
    const data = make();
    const { text } = await copyFor(data);
    const names = data.capture!.names;
    for (const now of nows) for (const timeZone of [ZONE, "Europe/London", "Pacific/Auckland", "Not/AZone"]) {
      const answer = shortcutsAnswer("sunday", { on: true, text, nowMs: ms(now), timeZone });
      expect(answer).not.toBe(NO_CHECK);
      expect(namedIn(answer, names, "strict"), answer).toBe(false);
      expect(namedIn(answer, names, "capitalized-common-words"), answer).toBe(false);
      for (const s of sourceStrings(data)) expect(answer.toLowerCase()).not.toContain(s.toLowerCase());
      expect(answer).not.toMatch(/[[\]{}"@]/u);
      expect(hasContactDetail(answer)).toBe(false);
      expect(backgroundWording(answer), answer).toBe(false);
      for (const word of answer.toLowerCase().replace(/[.,:;]/gu, " ").split(/\s+/u).filter(Boolean)) {
        expect(OWN_WORDS.has(word) || /^\d{1,4}(?::\d{2})?$/u.test(word), `${word} in: ${answer}`).toBe(true);
      }
    }
  });

  it("the fixed answers hold no background-check wording either", () => {
    for (const text of [OFF, NO_CHECK, UNKNOWN_QUESTION]) expect(backgroundWording(text)).toBe(false);
  });
});
