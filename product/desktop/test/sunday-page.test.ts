import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DecisionForm, DraftBox, LeaderNote, OperationsSection, SundayPage } from "../src/sunday-page.js";
import { DayProvider, SUNDAY_WORDS } from "../src/day-words.js";
import { SystemWordsContext, systemWords } from "../src/church-system.js";
import { wednesdayCapture, wednesdayWords, WEDNESDAY_TITLE } from "../../../core/test/fixtures/service-days/wednesday.js";
import { twoTimes } from "../../../core/test/fixtures/service-days/two-times.js";
import { RulesPage } from "../src/rules-page.js";
import { sundayReadyLine } from "../src/sunday-ready.js";
import { buildSundayBrief, teamLeaders, type SundayBrief } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import { nov22Capture, nov22LaterCapture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import { fictionalOperations, withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { sundayOperations, type SundayOperations } from "../../../core/src/operations-capture.js";
import { decide, type SundayDecision } from "../../../core/src/sunday-decisions.js";
import { refusedRead, sundayProblem } from "../src/sunday-source.js";
import { checkFailure } from "../src/harness-bridge.js";
import { FAILURE_REASONS } from "../src/harness-words.js";

const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const leadRules: SundayRules = { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] };
const AT = "2026-11-20T15:10:00Z";
const brief = (capture: SundayCapture = nov22Capture(), r = rules, now = capture.completed_at) => buildSundayBrief(capture, r, now, true);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
function page(b: SundayBrief, decisions: SundayDecision[] = [], operations: SundayOperations | null = null) {
  return renderToStaticMarkup(React.createElement(SundayPage, {
    brief: b, names: nov22Capture().names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
    canReword: false, decisions, onDecisions: () => undefined, operations, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
  }));
}
const nurseryDecision = (b = brief()) => decide(b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!, "not-needed", "Only two babies registered", AT);
const FORBIDDEN = /\b(approve|block|skills?|sessions?|agent|connector|harness|score|rank(ed|ing)?|at risk|drifting)\b/i;

describe("a read Planning Center refused (audit item 5)", () => {
  const refusedPage = (refused: boolean, onSettings?: () => void) => renderToStaticMarkup(React.createElement(SundayPage, {
    brief: null, names: {}, busy: false, problem: sundayProblem("denied"), sender: "", connected: true, hasRecording: false, configured: true,
    canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    refused, ...(onSettings ? { onSettings } : {}),
  }));
  it("says which access could be missing, who can give it, and the next steps, without guessing which", () => {
    const html = refusedPage(true, () => undefined);
    const t = text(html);
    expect(html).toContain('role="alert"');
    for (const line of [
      // Said of the service, never "this Sunday" (onboarding spec §5); "account" and "connect again", never "login" or "sign in again" (§6).
      "Planning Center didn't let Ozzie read this service's plan.",
      "It's one of these, and Ozzie can't tell which from here:",
      "The Planning Center account you signed in with can't see this service's plans. A Planning Center administrator at your church can give that account access to it in Planning Center Services.",
      "That sign-in is no longer accepted. Connecting again fixes this.",
      "Then connect again, or choose a service this account can see.",
    ]) expect(t).toContain(line);
    expect(html).toContain(">Open Settings to connect again</button>");
    expect(html).toContain(">Open Settings to choose another service</button>");
    expect(t.replaceAll("not ranked", "")).not.toMatch(FORBIDDEN);
  });
  it("is told apart from other problems by the native code alone", () => {
    expect(refusedRead("denied")).toBe(true);
    expect(refusedRead({ "sunday-check": "denied" })).toBe(true);
    for (const other of ["rate-limited", "not-connected", "provider-failure", "organization-unverified", undefined]) expect(refusedRead(other), String(other)).toBe(false);
    expect(sundayProblem("denied")).toBe("Planning Center didn't let Ozzie read this service's plan. Either the account you signed in with can't see this service's plans, or that sign-in is no longer accepted. A Planning Center administrator at your church can give your account access; then connect again under Settings, or choose another service.");
    // Any other problem stays one plain line.
    const other = text(refusedPage(false));
    expect(other).not.toContain("It's one of these");
  });
});

describe("a sign-in that was running out and wasn't renewed (native main.rs renewed_auth)", () => {
  const notRenewed = (reason: string) => ({ "sign-in-not-renewed": reason });
  it("says why, true to the cause, and what to do next", () => {
    for (const reason of ["invalid-credentials", "missing-credentials"]) {
      expect(sundayProblem(notRenewed(reason))).toBe("Ozzie's sign-in to Planning Center needed renewing and couldn't be renewed, so nothing was read. Connect again in Settings.");
    }
    // No answer, a 429 or a 5xx (review N, 8): the connection stays as it was and the next check tries again.
    expect(sundayProblem(notRenewed("provider-failure"))).toBe("Ozzie's sign-in to Planning Center needed renewing, and Planning Center didn't renew it just now, so nothing was read. Ozzie tries again at the next check.");
    // The Keychain, before Planning Center was asked (review N, 4): locked comes right by itself; refused or missing needs the leader.
    expect(sundayProblem(notRenewed("locked"))).toBe("Ozzie's sign-in to Planning Center needed renewing, and this Mac's credential storage was locked, so nothing was read. Ozzie tries again at the next check.");
    expect(sundayProblem(notRenewed("denied"))).toBe("Ozzie's sign-in to Planning Center needed renewing, and this Mac didn't let Ozzie use it, so nothing was read. Allow access when macOS asks, then check again.");
    expect(sundayProblem(notRenewed("store-unavailable"))).toBe("Ozzie's sign-in to Planning Center needed renewing, and this Mac's credential storage couldn't be read, so nothing was read. Check again in a moment; if it keeps happening, connect again in Settings.");
    for (const reason of ["busy", "cancelled"]) {
      expect(sundayProblem(notRenewed(reason)), reason).toBe("Ozzie's sign-in to Planning Center needed renewing and couldn't be renewed just now, so nothing was read. Try again in a moment, or connect again in Settings.");
    }
    // Never the refused-read card, whose causes are a login's access or a sign-in Planning Center refused at a read.
    for (const reason of ["busy", "cancelled", "locked", "denied", "store-unavailable", "invalid-credentials"]) expect(refusedRead(notRenewed(reason)), reason).toBe(false);
    // "Check now" when the saved sign-in can't be renewed: no sign-in Ozzie can use.
    expect(sundayProblem({ authentication: "invalid-token" })).toBe("Ozzie has no sign-in to Planning Center it can use, so nothing was read. Connect again in Settings.");
    for (const reason of ["invalid-credentials", "provider-failure", "busy", "denied"]) expect(sundayProblem(notRenewed(reason))).not.toMatch(FORBIDDEN);
  });
  it("is never what What happened says for Planning Center out of reach, unless it was", () => {
    expect(FAILURE_REASONS[checkFailure(notRenewed("invalid-credentials"))]).toBe("Planning Center access wasn't available");
    expect(FAILURE_REASONS[checkFailure(notRenewed("provider-failure"))]).toBe("Planning Center couldn't be reached");
  });
});

describe("Sunday page", () => {
  it("offers Sunday-only decisions and the leader note when nobody on the team qualifies", () => {
    const t = text(page(brief()));
    expect(t).toContain("Covered outside Planning Center");
    expect(t).toContain("Not needed this Sunday");
    expect(t).toContain("Prepare a note to the team's leader");
    // Under More choices since audit item 29: the card's main actions come first.
    expect(t).toMatch(/More choices For this Sunday only: Covered outside Planning Center Not needed this Sunday/u);
  });

  it("each service's cards say that service's own day, whatever day is around the page (polish 2026-11-21, item 2)", () => {
    // Several services watched: a Wednesday service's part shown where the Sunday words are around it.
    const wed = buildSundayBrief(wednesdayCapture(), rules, AT);
    for (const part of [undefined, { name: "Youth Night", waiting: null }]) {
      const t = text(renderToStaticMarkup(React.createElement(DayProvider, { value: SUNDAY_WORDS }, React.createElement(SundayPage, {
        brief: wed, names: wednesdayCapture().names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
        canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
        ...(part ? { part } : {}),
      }))));
      expect(t).toMatch(/More choices For this Wednesday only: Covered outside Planning Center Not needed this Wednesday/u);
      expect(t).not.toContain("this Sunday");
    }
  });

  it("a church on another system: the decision's words and its earlier answer name that system, never Planning Center", () => {
    const covered = decide(brief().findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!, "covered-outside", "A parent is covering", AT);
    const t = text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords("breeze") },
      React.createElement(SundayPage, {
        brief: brief(nov22LaterCapture()), names: nov22Capture().names, busy: false, problem: "", sender: "Pat", connected: false, hasRecording: false, configured: false,
        canReword: false, decisions: [covered], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
      }))));
    expect(t).toContain("Earlier, you said covered outside Breeze");
    expect(t).toContain("Covered outside Breeze");
    expect(t).not.toContain("covered outside Planning Center");
    const form = text(renderToStaticMarkup(React.createElement(SystemWordsContext.Provider, { value: systemWords("b1") },
      React.createElement(DecisionForm, { choice: "covered-outside", onSave: () => undefined, onCancel: () => undefined }))));
    expect(form).toContain("Kept on this Mac. It applies to this Sunday only, and this comes back if B1 Church changes.");
    expect(text(renderToStaticMarkup(React.createElement(DecisionForm, { choice: "not-needed", onSave: () => undefined, onCancel: () => undefined }))))
      .toContain("and this comes back if Planning Center changes.");
  });

  it("a role not tied to a service time: the card says which role couldn't be checked, with the reason in view (polish 2026-11-21, item 6)", () => {
    const c = nov22Capture();
    const members = c.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; relationships: Record<string, { data: unknown }> }[];
    members.find(m => m.id === "403")!.relationships.times = { data: [] };
    const b = brief(c);
    const html = page(b);
    const t = text(html);
    const reason = "Lyrics isn't tied to a service time in Planning Center, so Ozzie can't tell when it serves. Set the role's time in Planning Center to have it checked.";
    // Title, then the plain reasons (not only under Why I flagged this), then what Ozzie won't call covered.
    expect(t).toContain(`One role couldn't be checked. ${reason} Ozzie couldn't tell from Planning Center who said yes for Lyrics, or when they serve. Ozzie won't call Sunday covered until that role can be checked.`);
    expect(html).toMatch(/<h3 class="find-title"[^>]*>One role couldn(?:&#x27;|')t be checked\.<\/h3><ul class="list role-facts"><li>/u);
    expect(t).toContain("One role couldn't be checked, so this isn't a full picture.");
    // Nothing implies a read failed, or that checking again would help.
    expect(t).not.toContain("Part of this Sunday couldn't be checked");
    expect(t).not.toContain("until every part is read");
    expect(sundayReadyLine(b.findings.find(f => f.kind === "worth-a-look")!, {})).toBe("One role couldn't be checked, so it isn't a full picture.");
    // A read that truly failed keeps its own words.
    c.reads = c.reads.map(r => r.collection === "person_blockouts" ? { ...r, outcome: "timeout" as const } : r);
    const failed = text(page(brief(c)));
    expect(failed).toContain("Part of this Sunday couldn't be checked. Ozzie won't call Sunday covered until every part is read.");
    expect(failed).toContain("Part of this Sunday couldn't be checked, so this isn't a full picture.");
    expect(failed).not.toContain("One role couldn't be checked");
  });

  it("uses no forbidden wording anywhere on the page", () => {
    // "not ranked" is the one allowed use: it says the list is unranked.
    for (const html of [page(brief(nov22LaterCapture()), [nurseryDecision()], fictionalOperations()), page(brief(), [nurseryDecision()]), page(brief(nov22Capture(), leadRules))])
      expect(text(html).replaceAll("not ranked", "")).not.toMatch(FORBIDDEN);
  });

  it("a decision shows as resolved by you for this Sunday only, never as confirmed coverage", () => {
    const t = text(page(brief(), [nurseryDecision()]));
    expect(t).toContain("Resolved by you — this Sunday only");
    expect(t).toContain("Nursery isn't needed this Sunday.");
    expect(t).toContain("“Only two babies registered”");
    expect(t).toContain("Planning Center still shows 1 remaining request; your decision here didn't change anything there.");
    expect(t).not.toContain("Confirmed in Planning Center");
    expect(t).toContain("1 thing needs a decision");
    expect(t).toContain("You resolved 1 yourself.");
  });

  it("a later check that changes the facts brings it back, says what changed and keeps the reason", () => {
    const t = text(page(brief(nov22LaterCapture()), [nurseryDecision()]));
    expect(t).toContain("This needs attention again");
    expect(t).toContain("What changed since you decided");
    expect(t).toContain("Planning Center now shows 2 remaining requests; it was 1 when you decided.");
    expect(t).toContain("Blake Ashgrove is no longer confirmed in Planning Center.");
    expect(t).toContain("Earlier, you said not needed this Sunday");
    expect(t).toContain("“Only two babies registered”");
    expect(t).not.toContain("Resolved by you — this Sunday only");
  });

  it("a gap Planning Center shows filled is source-confirmed, with the manual note kept", () => {
    const capture = nov22Capture();
    const needs = capture.reads.find(r => r.collection === "needed_positions")!.body!.data as { attributes: { team_position_name: string } }[];
    needs.splice(needs.findIndex(n => n.attributes.team_position_name === "Nursery"), 1);
    const t = text(page(brief(capture), [nurseryDecision()]));
    expect(t).toContain("Confirmed in Planning Center");
    expect(t).toContain("Nursery is now filled in Planning Center.");
    expect(t).toContain("Earlier, you said not needed this Sunday");
  });

  it("asks the lead question when a team leader exists but no one is scheduled to lead", () => {
    const t = text(page(brief(nov22Capture(), leadRules)));
    expect(t).toContain("Ozzie found the team's leader in Planning Center, but no one scheduled to lead this Sunday. Is that expected?");
    expect(t).toContain("Yes, that's expected");
    expect(t).toContain("Prepare a note to the leader");
  });

  it("an incomplete check is Worth a look, listed first, and names what wasn't read", () => {
    const capture = nov22Capture();
    const read = capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.riley)!;
    read.outcome = "timeout"; delete read.body;
    const t = text(page(brief(capture)));
    expect(t).toContain("Part of this Sunday couldn't be checked.");
    expect(t).toContain("Blockouts for 1 person: took too long.");
    expect(t.indexOf("Part of this Sunday couldn't be checked.")).toBeLessThan(t.indexOf("Greeter still needs"));
    expect(t).toContain("Part of this Sunday couldn't be checked, so this isn't a full picture.");
    // Riley's blockout read failed; that is not the same as having a blockout.
    expect(t).toContain("Their blockouts couldn't be checked (one repeats, or the read didn't finish).");
    expect(t).not.toContain("Has a blockout Ozzie can't check");
    expect(t).not.toContain("Recorded availability couldn't be verified.");
  });

  it("never says nothing needs a decision when the check is incomplete", () => {
    const capture = nov22Capture();
    capture.reads.find(r => r.collection === "needed_positions")!.outcome = "timeout";
    const t = text(page(brief(capture)));
    expect(t).not.toContain("Nothing needs a decision");
    expect(t).toContain("Nothing in what was read needs a decision");
  });

  it("with only a possible conflict, says no one is clear rather than '0 people'", () => {
    const capture = nov22Capture();
    const riley = capture.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.riley)!;
    riley.body = { data: [{ type: "Blockout", id: "803", attributes: { starts_at: "2026-11-22T13:00:00Z", ends_at: "2026-11-22T17:00:00Z", repeat_frequency: "no_repeat" } }] };
    const t = text(page(brief(capture)));
    expect(t).toContain("No one else on the team is clear with no overlap found; one person has a possible conflict.");
    expect(t).not.toMatch(/\b0 people\b/);
  });

  it("an old live check says it's out of date", () => {
    const t = text(renderToStaticMarkup(React.createElement(SundayPage, {
      brief: buildSundayBrief(nov22Capture(), rules, "2026-11-20T18:00:00Z"), names: {}, busy: false, problem: "", sender: "", connected: true, hasRecording: false,
      configured: true, canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    })));
    expect(t).toContain("This check is out of date.");
    expect(t).toContain("This check is out of date, so it isn't a current picture.");
    expect(t).toContain("Check Planning Center again before relying on it.");
    expect(t).not.toContain("Nothing needs a decision");
  });

  it("What I didn't check says rooms and follow-ups weren't checked until there's a result", () => {
    expect(text(page(brief()))).toContain("Room bookings and follow-ups weren't part of this check.");
    const t = text(page(brief(), [], fictionalOperations()));
    expect(t).not.toContain("Room bookings and follow-ups weren't part of this check.");
    expect(t).toContain("Group events weren't part of this check.");
  });
});

describe("one count for what the page shows, and what it is showing", () => {
  const example = withFictionalOperations(nov22Capture());
  const exampleBrief = buildSundayBrief(example, rules, example.completed_at, true);
  const exampleOps = sundayOperations(example, rules, {})!;

  it("the headline counts every card the page shows: Services, rooms, follow-ups and group meetings", () => {
    const html = page(exampleBrief, [], exampleOps);
    const t = text(html);
    // Two open roles and the follow-up without an owner need a decision; the pending request, the streak, the unconfirmed room
    // overlap, the card saying why it can't be confirmed and the group meeting are worth a look.
    expect(t).toContain("3 things need a decision and 5 are worth a look.");
    const tags = (h: string, tone: string) => h.match(new RegExp(`<div class="find-top"><span class="badge ${tone}">`, "gu"))?.length ?? 0;
    expect([tags(html, "b-attn"), tags(html, "b-look")]).toEqual([3, 5]);
    // A room the Church rules say isn't shared: its overlap needs a decision too.
    const ruled = page(brief(), [], fictionalOperations());
    expect(text(ruled)).toContain("4 things need a decision and 2 are worth a look.");
    expect([tags(ruled, "b-attn"), tags(ruled, "b-look")]).toEqual([4, 2]);
    // What the person resolved leaves the count and is said apart.
    expect(text(page(exampleBrief, [nurseryDecision(exampleBrief)], exampleOps))).toContain("2 things need a decision and 5 are worth a look. You resolved 1 yourself.");
  });

  it("always says whether it shows a live read, the saved copy of a check or the fictional example, and labels the switch", () => {
    const live = buildSundayBrief(nov22Capture(), rules, nov22Capture().completed_at);
    const recording = buildSundayBrief({ ...nov22Capture(), kind: "recording" }, rules, nov22Capture().completed_at);
    const modes: [SundayBrief, string, string | null][] = [
      [live, "Live read from Planning Center Services", null],
      // A live check with no Services read time still says what it is, at the time it finished.
      [{ ...live, checked_at: null }, "Live read from Planning Center Services", null],
      // "Recording" read as audio (audit item 28): a person sees "the saved copy of a check".
      [recording, "Saved copy of a check of Planning Center Services", "This is not a current check."],
      // The example's own band is App's, on every page (audit item 2); the page's line still says what this is.
      [brief(), "Fictional example data", null],
    ];
    for (const [b, line, banner] of modes) {
      const html = page(b);
      expect(text(html)).toMatch(new RegExp(`${line} · \\d+ reads · `, "u"));
      if (banner) expect(text(html)).toContain(banner);
      expect(html).toContain('role="group" aria-label="What this page shows: a live check, the last saved check or the fictional example"');
      expect(text(html)).not.toMatch(/recording/iu);
    }
  });

  it("every card has where its facts came from, when they were read, and Why I flagged this", () => {
    const html = page(exampleBrief, [], exampleOps);
    const cards = html.split(/<article class="find/u).slice(1);
    expect(cards.length).toBeGreaterThanOrEqual(8);
    for (const card of cards) {
      expect(card).toContain("Why I flagged this");
      expect(card).toMatch(/class="badge b-muted">[^<]+<\/span>/u);
      expect(text(card)).toMatch(/Checked [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, /u);
    }
    // The card about room details that couldn't be confirmed, and the out-of-date rooms card, have them too.
    const unconfirmed = text(cards.find(c => c.includes("Some room or follow-up details couldn&#x27;t be confirmed."))!);
    expect(unconfirmed).toMatch(/Why I flagged this Calendar Church rules People follow-ups Checked /u);
    const stale = text(renderToStaticMarkup(React.createElement(OperationsSection, {
      operations: { ...exampleOps, result: null, group_meetings: [], stale: true, checked_at: null, clear: [] }, checkedAt: exampleBrief.checked_at, whyOpen: true,
    })));
    expect(stale).toMatch(/Out of date .* Why I flagged this Planning Center Checked /u);
    expect(stale).toContain("doesn't treat its rooms, follow-ups or group meetings as current");
  });

  it("someone scheduled with a blockout is a Worth a look card with its source and check time, and a covered Sunday no longer reads as covered", () => {
    // Every role filled, no check-ins, nothing else to look at: the one Sunday the page calls covered.
    const covered = () => {
      const c = nov22Capture();
      const read = (collection: string, person?: string) => c.reads.find(r => r.collection === collection && (!person || r.person_id === person))!;
      read("person_blockouts", PEOPLE.drew).body = { data: [], meta: { count: 0, total_count: 0 } };
      read("needed_positions").body = { data: [], meta: { count: 0, total_count: 0 } };
      read("team_members").body!.data = (read("team_members").body!.data as { id: string }[]).filter(m => m.id !== "403");
      for (const r of c.reads.filter(x => x.collection === "team_position_assignments")) {
        r.body!.data = (r.body!.data as { relationships: { person: { data: { id: string } } } }[]).filter(a => [PEOPLE.greeterConfirmed, PEOPLE.nurseryConfirmed].includes(a.relationships.person.data.id));
      }
      return c;
    };
    const quiet = { ...rules, checkInAfterSundaysInARow: 0 };
    expect(text(page(brief(covered(), quiet)))).toContain("Everything Ozzie checked is covered.");
    const c = covered();
    c.reads.find(r => r.collection === "person_blockouts" && r.person_id === PEOPLE.greeterConfirmed)!.body = {
      data: [{ type: "Blockout", id: "b1", attributes: { starts_at: "2026-11-22T05:00:00Z", ends_at: "2026-11-23T04:59:59Z", repeat_frequency: "no_repeat" } }], meta: { count: 1, total_count: 1 } };
    const html = page(brief(c, quiet));
    const t = text(html);
    expect(t).not.toContain("Everything Ozzie checked is covered.");
    expect(t).toContain("Nothing needs a decision and 1 is worth a look.");
    const card = html.split(/<article class="find/u).slice(1).find(x => x.includes("has a blockout"))!;
    expect(card).toContain('<span class="badge b-look">');
    const shown = text(card);
    expect(shown).toContain("Worth a look");
    expect(shown).toMatch(/Avery Brightwater is scheduled for Greeter at \d{1,2}:30\s?[AP]M and has a blockout in Planning Center at that time\./u);
    expect(shown).toContain("Planning Center still counts them as confirmed for Greeter, so it isn't an open spot. Only they can say whether they'll be there.");
    expect(shown).toMatch(/Why I flagged this Planning Center Checked [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, /u);
    expect(shown).not.toMatch(FORBIDDEN);
  });

  it("Resolved by you looks neutral, never like confirmed coverage", () => {
    const html = page(brief(), [nurseryDecision()]);
    const resolved = html.slice(html.indexOf('aria-label="Resolved by you"'));
    expect(resolved).toContain('class="badge b-you"');
    expect(resolved).not.toMatch(/b-ok|b-confirm|panel-ok/u);
  });
});

describe("the plan's own title is beside its date, never glued to the count (click-through, 2026-11-19)", () => {
  const live = buildSundayBrief(nov22Capture(), rules, nov22Capture().completed_at);
  const head = (html: string) => /^<div class="col"><p class="eyebrow">(.*?)<\/p><h1 class="h1">([^<]+)<\/h1>/u.exec(html);
  const lede = (html: string) => text(/<p class="lede">(.*?)<\/p>/u.exec(html)![1]!).trim();
  const titled = (title: string | null) => ({ ...live, plan: { ...live.plan, title } });

  it("the eyebrow names the day and date, the service times, then the plan; the count leads the page alone", () => {
    const html = page(live);
    const m = head(html);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('Sunday, November 22 · 9:30 AM · <span class="eyebrow-plan">Ozzie Demo — Main Sunday (fictional)</span>');
    expect(m![2]).toBe("Are your services covered?");
    expect(lede(html)).toMatch(/^\d+ things need a decision and \d+ are worth a look\.$/u);
    // Said once on the page, and still the page's only h1.
    expect(text(html).match(/Ozzie Demo — Main Sunday \(fictional\)/gu)).toHaveLength(1);
    expect(html.match(/<h1\b/gu)).toHaveLength(1);
  });

  it("a plan with no title shows the date alone", () => {
    for (const title of [null, "", "   "]) {
      const html = page(titled(title));
      expect(head(html)![1], JSON.stringify(title)).toBe("Sunday, November 22 · 9:30 AM");
      expect(html).not.toContain("eyebrow-plan");
    }
  });

  it("a very long title is there whole, for VoiceOver too, and wraps rather than running off the page", () => {
    const long = `${"Advent ".repeat(20)}${"Candlelight".repeat(12)} — Lessons and Carols`;
    const html = page(titled(long));
    expect(head(html)![1]).toBe(`Sunday, November 22 · 9:30 AM · <span class="eyebrow-plan">${long}</span>`);
    expect(lede(html)).not.toContain("Advent");
    const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.oz \.eyebrow-plan \{[^}]*overflow-wrap: anywhere;[^}]*\}/u);
    // In its own case: the eyebrow's capitals are for the date.
    expect(css).toMatch(/\.oz \.eyebrow-plan \{[^}]*text-transform: none;[^}]*\}/u);
  });

  it("a Wednesday plan, the example and a service not checked yet are headed the same way", () => {
    const wed = buildSundayBrief(wednesdayCapture(), rules, wednesdayCapture().completed_at);
    const html = renderToStaticMarkup(React.createElement(DayProvider, { value: wednesdayWords() }, React.createElement(SundayPage, {
      brief: wed, names: wednesdayCapture().names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true,
      canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    })));
    expect(head(html)![1]).toBe(`Wednesday, November 25 · 9:30 AM · <span class="eyebrow-plan">${WEDNESDAY_TITLE}</span>`);
    expect(head(html)![2]).toBe("Are your services covered?");
    expect(lede(html)).not.toContain(WEDNESDAY_TITLE);
    expect(head(page(brief()))![1]).toBe('Sunday, November 22 · 9:30 AM · <span class="eyebrow-plan">Ozzie Demo — Main Sunday (fictional)</span>');
    const unchecked = renderToStaticMarkup(React.createElement(SundayPage, {
      brief: null, names: {}, busy: false, problem: "", sender: "", connected: true, hasRecording: false, configured: true,
      canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    }));
    expect(head(unchecked)![1]).toBe("Sunday");
  });
});

describe("rooms and follow-ups slot", () => {
  it("renders the operations findings with their labels, next steps and check times", () => {
    const t = text(renderToStaticMarkup(React.createElement(OperationsSection, { operations: fictionalOperations() })));
    expect(t).toContain("Room use needs review");
    expect(t).toContain("Fellowship Hall has overlapping bookings from");
    expect(t).toContain("counting the 30 minutes of setup your Church rules set for this room");
    // The next step names where to do it: these were read from Planning Center Calendar and People (polish pass).
    expect(t).toContain("Next step Review these room bookings in Planning Center Calendar.");
    expect(t).toContain("Follow-up needs an owner");
    expect(t).toContain("“Call a first-time guest” has no owner.");
    expect(t).toContain("Why I flagged this");
    expect(t).toContain("Next step Choose who will handle this follow-up in Planning Center People.");
    expect(t).not.toContain("church tools");
    expect(t).toContain("Checked");
  });
  it("keeps the general next step when a card doesn't say where it was read", () => {
    const operations = fictionalOperations();
    const unsourced = { ...operations, result: { ...operations.result, findings: operations.result.findings.map(f => ({ ...f, evidence: [] })) } };
    const t = text(renderToStaticMarkup(React.createElement(OperationsSection, { operations: unsourced })));
    expect(t).toContain("Next step Review these room bookings in your church tools.");
    expect(t).toContain("Next step Choose who will handle this follow-up in your church tools.");
    expect(t).not.toContain("in Planning Center Calendar.");
    expect(t).not.toContain("in Planning Center People.");
  });
  it("uncertain operations are Worth a look, never a clear", () => {
    const operations = fictionalOperations();
    const t = text(renderToStaticMarkup(React.createElement(OperationsSection, { operations: { ...operations, result: { ...operations.result, status: "unverified", findings: [],
      uncertainties: [{ code: "unknown-rule", scope_id: "hall-rule", subject_id: "hall", label: "Worth a look" }] } } })));
    expect(t).toContain("Worth a look");
    expect(t).toContain("A room isn't set as not shared in Church rules");
    expect(t).not.toContain("No room overlaps");
  });
});

describe("drafts and decision form", () => {
  it("the note to the leader is a draft only, addressed by first name, with no send action", () => {
    const nursery = brief().findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    const html = renderToStaticMarkup(React.createElement(LeaderNote, { finding: nursery, leader: PEOPLE.nurseryLeader, names: nov22Capture().names, sender: "Pat", onClose: () => undefined }));
    const t = text(html);
    expect(t).toContain("Draft only. Nothing has been sent.");
    expect(t).toContain("To Jordan Ashdown (team leader in Planning Center)");
    expect(t).toContain("Hi Jordan,");
    expect(t).toContain("Copy draft");
    expect(t).toContain("Change the wording");
    expect(t).not.toMatch(/\bSend\b|Ask Ozzie to reword/);
  });
  it("the wording, open to change, is a labelled text box", () => {
    const html = renderToStaticMarkup(React.createElement(DraftBox, { label: "Draft note", body: "Hi Riley,", onBody: () => undefined, onClose: () => undefined, footer: "", startEditing: true }));
    const id = /<textarea id="([^"]+)"/u.exec(html)?.[1];
    expect(id).toBeTruthy();
    expect(html).toContain(`<label class="sr-only" for="${id}">Draft note: change the wording</label>`);
    expect(text(html)).toContain("Done changing");
  });
  it("names the Sunday's own date when the service time wasn't read, and is signed with the sender", () => {
    const nursery = brief().findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    const untimed = { ...nursery, position: { ...nursery.position!, interval: null } };
    const t = text(renderToStaticMarkup(React.createElement(LeaderNote, { finding: untimed, leader: PEOPLE.nurseryLeader, names: nov22Capture().names, sender: "Pat", sunday: "2026-11-29", onClose: () => undefined })));
    expect(t).toContain("Nursery on Sunday, November 29 still needs one more person.");
    expect(t).toContain("Thank you, Pat");
    expect(t).not.toMatch(/this week|this Sunday/u);
  });
  it("a decision needs a reason before it can be saved", () => {
    const html = renderToStaticMarkup(React.createElement(DecisionForm, { choice: "covered-outside", onSave: () => undefined, onCancel: () => undefined }));
    expect(html).toMatch(/<button type="submit"[^>]*disabled[^>]*>Mark it covered for this Sunday<\/button>/);
    expect(text(html)).toContain("It applies to this Sunday only");
  });
});

describe("Church rules page", () => {
  it("shows the team's leader as oversight, separate from a scheduled lead", () => {
    const capture = nov22Capture();
    const positions = [{ position_id: "position:2", team_id: TEAMS.nursery, name: "Nursery", interval: null }, { position_id: "position:1", team_id: TEAMS.greeter, name: "Greeter", interval: null }];
    const t = text(renderToStaticMarkup(React.createElement(RulesPage, { rules: leadRules, onChange: () => undefined, positions, leaders: teamLeaders(capture), names: capture.names })));
    expect(t).toContain("Planning Center lists Jordan Ashdown as this team's leader. That's oversight, not someone scheduled to lead on Sunday.");
    expect(t).toContain("Planning Center doesn't list a leader for this team.");
  });
  it("offers the team's position names for its Sunday lead, and typing another still works", () => {
    const positions = [{ position_id: "p2", team_id: TEAMS.nursery, name: "Nursery", interval: null }, { position_id: "p3", team_id: TEAMS.nursery, name: "Nursery Lead", interval: null }];
    const html = renderToStaticMarkup(React.createElement(RulesPage, { rules: leadRules, onChange: () => undefined, positions }));
    expect(html).toMatch(new RegExp(`<input id="lead-${TEAMS.nursery}" list="lead-options-${TEAMS.nursery}"[^>]*value="Nursery Lead"`, "u"));
    expect(html).toContain(`<datalist id="lead-options-${TEAMS.nursery}"><option value="Nursery"></option><option value="Nursery Lead"></option></datalist>`);
    expect(text(html)).toContain("choose the lead's position from the team's positions, or type its name as it appears in Planning Center");
  });
});

describe("one service with two service times: each time is its own section (owner decision 2026-11-19)", () => {
  const two = brief(twoTimes());
  const html = page(two);
  const t = text(html);
  const at = (s: string) => t.indexOf(s);

  it("names both times under the question, and heads each time's findings with it, in order", () => {
    expect(/<p class="eyebrow">([^<]*)</u.exec(html)![1]).toBe("Sunday, November 22 · 9:30 AM and 11:00 AM · ");
    const heads = [...html.matchAll(/<h2 id="service-time-\d+" class="h3">([^<]+)<\/h2>/gu)].map(m => m[1]);
    expect(heads).toEqual(["9:30 AM service", "11:00 AM service", "Not tied to one service time"]);
    // Greeter and the pending Lyrics request at 9:30, Nursery at 11:00, the weeks-in-a-row check-in under neither.
    expect(at("9:30 AM service")).toBeLessThan(at("Greeter still needs"));
    expect(at("Greeter still needs")).toBeLessThan(at("11:00 AM service"));
    expect(at("11:00 AM service")).toBeLessThan(at("Nursery still needs"));
    expect(at("Nursery still needs")).toBeLessThan(at("Not tied to one service time"));
    expect(at("Not tied to one service time")).toBeLessThan(at("3 weeks in a row"));
  });

  it("the lead still counts across both times, and nothing is lost or said twice", () => {
    expect(text(/<p class="lede">(.*?)<\/p>/u.exec(html)![1]!)).toMatch(/^ ?2 things need a decision and 2 are worth a look\. ?$/u);
    expect(t.match(/Greeter still needs/gu)).toHaveLength(1);
    expect(t.match(/Nursery still needs/gu)).toHaveLength(1);
  });

  it("one service time: no time headings, the page as before", () => {
    expect(page(brief())).not.toContain("service-time-");
  });
});


describe("several services' cards say every role's time the same way (coordinator's live read of 0.5.0)", () => {
  const wed = buildSundayBrief(wednesdayCapture(), rules, wednesdayCapture().completed_at);
  // One of Youth Night's roles with no serving time of its own, as the live test church's was.
  const at = wed.findings.findIndex(f => f.position?.interval);
  const untimed: SundayBrief = { ...wed, findings: wed.findings.map((f, i) => i === at ? { ...f, position: { ...f.position!, interval: null } } : f) };
  const role = wed.findings[at]!.position!.name;
  const show = (b: SundayBrief, part: boolean) => text(renderToStaticMarkup(React.createElement(DayProvider, { value: wednesdayWords() }, React.createElement(SundayPage, {
    brief: b, names: wednesdayCapture().names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true,
    canReword: false, decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    ...(part ? { part: { name: "Youth Night", waiting: null, opsWith: "Sunday Morning" } } : {}),
  }))));
  const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  it("beside another service, a role with no time of its own says its service's date, never the plan's one time as if it were the role's", () => {
    // 0.5.3: "Greeter · Wednesday, November 25 at 7:00 PM" sat beside "Greeter isn't tied to a service time in Planning
    // Center, so Ozzie can't tell when it serves." The service's times are in the part's own line above (polish 3, item 4).
    expect(wed.times).toHaveLength(1);
    const t = show(untimed, true);
    expect(t).toContain(`${role} · Wednesday, November 25 `);
    expect(t).not.toContain(`${role} · Wednesday, November 25 at`);
    expect(t).not.toContain(`${role} · this Wednesday`);
    // The part's own line gives the service's time in the church's time zone, whatever zone this machine is in.
    expect(t).toMatch(/Wednesday, November 25 · \d{1,2}:\d{2} [AP]M/u);
    // A timed role still says its own date and time.
    expect(show(wed, true)).toContain(`${role} · Wednesday, November 25 at ${clock(wed.findings[at]!.position!.interval!.starts_at)}`);
  });

  it("with more than one service time it says the date alone, and one service's own page keeps its day's words", () => {
    expect(show({ ...untimed, times: [...wed.times!, "2026-11-25T16:30:00Z"] }, true)).toContain(`${role} · Wednesday, November 25 `);
    expect(show({ ...untimed, times: [...wed.times!, "2026-11-25T16:30:00Z"] }, true)).not.toContain(`${role} · Wednesday, November 25 at`);
    expect(show(untimed, false)).toContain(`${role} · this Wednesday`);
  });
});
