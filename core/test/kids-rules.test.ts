// Kids safety rules over fixed, fictional data: "N confirmed people at each service time" (Services
// assignments already read) and "a current background check before serving with kids" (the People
// background-check read). Every name and id here is invented.
import { describe, expect, it } from "vitest";
import { buildSundayBrief, type Finding } from "../src/sunday-brief.js";
import { backgroundCheckTeamIds, BACKGROUND_CHECKS, kidsTeams, withKidsBackgroundChecks, withKidsTeam } from "../src/kids-rules.js";
import type { SundayCapture, SundayRead, SundayRules } from "../src/sunday-capture.js";
import { CHECKED, nov22Capture, PEOPLE, TEAMS, withFictionalBackgroundChecks } from "../src/fictional-sunday.js";
import { buildSpokenBriefing } from "../src/spoken-briefing.js";
import { envelopeProblems } from "../src/harness/fixed.js";
import { HarnessSession } from "../src/harness/session.js";
import { HarnessTools } from "../src/harness/tools.js";
import { allEnvelopes, harnessData } from "./harness/fixtures.js";
import { ASK_SYSTEM, AskSession, buildAskContext, prepareAsk } from "../src/ask.js";
import { verifyAnswer } from "../src/harness/verify.js";
import { instructionsFor } from "../src/harness/instructions.js";
import { bundledSkills } from "../src/harness/bundled-skills.js";
import { sharedCheckText, sharedEnvelopes } from "../mcp/snapshot.js";
import { briefTarget, canCorrect, correctionEntry, feedbackOf, kindWords, stopEntry, stopScopes } from "../src/finding-feedback.js";

const NOW = "2026-11-20T15:05:00Z";
const base: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 0 };
const nursery = (min = 2, more: Partial<SundayRules> = {}): SundayRules => ({ ...base, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: min }], ...more });
const SECOND = { starts_at: "2026-11-22T16:30:00Z", ends_at: "2026-11-22T17:30:00Z" };

type Row = { id: string; type: string; attributes: Record<string, unknown>; relationships: Record<string, unknown> };
const rel = (type: string, id: string) => ({ data: { type, id } });
const rowsOf = (capture: SundayCapture, collection: string) => capture.reads.find(r => r.collection === collection)!.body!.data as Row[];
function addMember(capture: SundayCapture, id: string, person: string, status: string, times: string[], sent: string | null = "2026-11-01T12:00:00Z", team = TEAMS.nursery) {
  rowsOf(capture, "team_members").push({
    type: "PlanPerson", id,
    attributes: { status, team_position_name: "Nursery", notification_sent_at: sent, notification_prepared_at: null, prepare_notification: false },
    relationships: { person: rel("Person", person), team: rel("Team", team), times: { data: times.map(t => ({ type: "PlanTime", id: t })) } },
  });
  capture.names[person] = `Fictional Person ${person}`;
}
function addSecondService(capture: SundayCapture) {
  rowsOf(capture, "plan_times").push({ type: "PlanTime", id: "9002", attributes: { ...SECOND, time_type: "service" }, relationships: {} });
}
const check = (id: string, attributes: Record<string, unknown>, person: string) =>
  ({ type: "BackgroundCheck", id, attributes: { status: "complete_clear", current: true, ...attributes }, relationships: { person: rel("Person", person) } });
function checks(person: string, rows: unknown[], extra: Partial<SundayRead> = {}): SundayRead {
  return { collection: BACKGROUND_CHECKS, people_person_id: person, offset: 0, checked_at: "2026-11-20T15:00:05Z", outcome: "ok",
    body: { data: rows, meta: { count: rows.length, total_count: rows.length } }, ...extra };
}
/** A background-check read that didn't answer: no body, as the native check records it. */
const unanswered = (person: string, outcome: string): SundayRead =>
  ({ collection: BACKGROUND_CHECKS, people_person_id: person, offset: 0, checked_at: "2026-11-20T15:00:05Z", outcome });
const withChecks =(capture: SundayCapture, ...reads: SundayRead[]) => { capture.reads.push(...reads); return capture; };
const kinds = (findings: Finding[], kind: Finding["kind"]) => findings.filter(f => f.kind === kind);
const brief = (capture: SundayCapture, rules: SundayRules) => buildSundayBrief(capture, rules, NOW);
/** A cleared current check far past Sunday, for someone else on the team, so "no rows anywhere" doesn't apply. */
const OTHER = "560";
const otherOnFile = (capture: SundayCapture) => {
  addMember(capture, "460", OTHER, "C", ["9001"]);
  return checks(OTHER, [check("960", { expires_on: "2027-06-01" }, OTHER)]);
};

describe("Church rules: kids teams", () => {
  it("assumes no team: without a kids team there is no kids finding and nothing to read", () => {
    const b = brief(nov22Capture(), base);
    expect(b.findings.some(f => f.kind === "too-few-confirmed" || f.kind === "background-check")).toBe(false);
    expect(backgroundCheckTeamIds(base)).toEqual([]);
    expect(b.not_checked.join(" ")).not.toMatch(/kids|background/i);
  });

  it("keeps only valid kids team settings: numeric team ids, whole counts 1 to 10, one entry per team", () => {
    const rules = { ...base, kidsTeams: [
      { team_id: TEAMS.nursery, min_confirmed: 2 }, { team_id: TEAMS.nursery, min_confirmed: 3 }, { team_id: "abc", min_confirmed: 2 },
      { team_id: TEAMS.lyrics, min_confirmed: 0 }, { team_id: TEAMS.greeter, min_confirmed: 2.5 }, { team_id: "77", min_confirmed: 11 },
    ] } as SundayRules;
    expect(kidsTeams(rules)).toEqual([{ team_id: TEAMS.nursery, min_confirmed: 2 }]);
  });

  it("marks and unmarks a kids team, keeping counts whole and within 1 to 10", () => {
    let rules = withKidsTeam(base, TEAMS.nursery, 2);
    expect(kidsTeams(rules)).toEqual([{ team_id: TEAMS.nursery, min_confirmed: 2 }]);
    rules = withKidsTeam(rules, TEAMS.nursery, 14);
    expect(kidsTeams(rules)).toEqual([{ team_id: TEAMS.nursery, min_confirmed: 10 }]);
    rules = withKidsTeam(withKidsTeam(rules, TEAMS.lyrics, 0), TEAMS.nursery, Number.NaN);
    expect(kidsTeams(rules)).toEqual([{ team_id: TEAMS.lyrics, min_confirmed: 1 }, { team_id: TEAMS.nursery, min_confirmed: 2 }]);
    rules = withKidsTeam(rules, TEAMS.lyrics, null);
    expect(kidsTeams(rules)).toEqual([{ team_id: TEAMS.nursery, min_confirmed: 2 }]);
    expect(kidsTeams(withKidsTeam(rules, "not-a-team", 2))).toEqual(kidsTeams(rules));
    expect(withKidsBackgroundChecks(rules, false).kidsBackgroundChecks).toBe(false);
  });

  it("reads background checks only for kids teams, and only while that rule is on", () => {
    expect(backgroundCheckTeamIds(nursery())).toEqual([TEAMS.nursery]);
    expect(backgroundCheckTeamIds(nursery(2, { kidsBackgroundChecks: false }))).toEqual([]);
  });
});

describe("N confirmed people at each service time", () => {
  it("one confirmed in Nursery when the church asks for two is a fact, with nobody else asked", () => {
    const [f, ...rest] = kinds(brief(nov22Capture(), nursery()).findings, "too-few-confirmed");
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ tone: "decision", needed: 2, confirmed: [PEOPLE.nurseryConfirmed], asked: [], not_sent: [],
      position: { team_id: TEAMS.nursery, name: "Nursery", interval: { starts_at: "2026-11-22T14:30:00Z" } } });
    expect(f!.key).toBe(JSON.stringify(["too-few-confirmed", TEAMS.nursery, "2026-11-22T14:30:00Z"]));
    expect(f!.why.join(" ")).toContain("at least 2 confirmed people");
    expect(f!.why.join(" ")).toContain("doesn't check ages");
  });

  it("pending is never counted as confirmed, and an unsent request is never called asked", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "U", ["9001"]);
    addMember(capture, "452", "552", "U", ["9001"], null);
    addMember(capture, "453", "553", "D", ["9001"]);
    const [f] = kinds(brief(capture, nursery()).findings, "too-few-confirmed");
    expect(f).toMatchObject({ tone: "decision", confirmed: [PEOPLE.nurseryConfirmed], asked: ["551"], not_sent: ["552"] });
    expect(f!.why.join(" ")).toContain("1 asked with no answer yet, 1 not sent yet");
  });

  it("enough confirmed people is no finding; the church can ask for more than two", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "C", ["9001"]);
    expect(kinds(brief(capture, nursery()).findings, "too-few-confirmed")).toEqual([]);
    expect(kinds(brief(capture, nursery(3)).findings, "too-few-confirmed")[0]).toMatchObject({ needed: 3, confirmed: [PEOPLE.nurseryConfirmed, "551"].sort() });
  });

  it("checks each service time the team serves on its own", () => {
    const capture = nov22Capture();
    addSecondService(capture);
    addMember(capture, "451", "551", "C", ["9001", "9002"]);
    addMember(capture, "454", "554", "C", ["9002"]);
    addMember(capture, "455", "555", "C", ["9002"]);
    // 9:30 has two confirmed (502, 551); the second service has three (551, 554, 555).
    expect(kinds(brief(capture, nursery()).findings, "too-few-confirmed")).toEqual([]);
    const f = kinds(brief(capture, nursery(3)).findings, "too-few-confirmed");
    expect(f.map(x => x.position!.interval!.starts_at)).toEqual(["2026-11-22T14:30:00Z"]);
  });

  it("no confirmed people at a time the team serves is a fact too", () => {
    const capture = nov22Capture();
    addSecondService(capture);
    addMember(capture, "451", "551", "U", ["9002"]);
    const second = kinds(brief(capture, nursery()).findings, "too-few-confirmed").find(f => f.position!.interval!.starts_at === SECOND.starts_at)!;
    expect(second).toMatchObject({ tone: "decision", confirmed: [], asked: ["551"] });
  });

  it("a confirmed person Planning Center doesn't place at a time makes the count Worth a look, not a fact", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "C", []);
    const [f] = kinds(brief(capture, nursery()).findings, "too-few-confirmed");
    expect(f).toMatchObject({ tone: "look", confirmed: [PEOPLE.nurseryConfirmed] });
    expect(f!.why.join(" ")).toContain("doesn't show which service time 1 confirmed person serves");
  });

  it("when who is scheduled didn't fully load, no count is claimed and the gap is named", () => {
    const capture = nov22Capture();
    capture.reads.find(r => r.collection === "team_members")!.outcome = "truncated";
    const b = brief(capture, nursery());
    expect(kinds(b.findings, "too-few-confirmed")).toEqual([]);
    expect(b.not_checked).toContain("Kids team counts weren't checked, because who is scheduled didn't fully load.");
  });

  it("a kids team that isn't on this plan isn't counted, and says so", () => {
    const b = brief(nov22Capture(), { ...base, kidsTeams: [{ team_id: "7599999", min_confirmed: 2 }] });
    expect(kinds(b.findings, "too-few-confirmed")).toEqual([]);
    expect(b.not_checked).toContain("1 kids team isn't on this Sunday's plan, so it wasn't counted.");
  });

  it("changing the number re-checks what was already read, with no new read", () => {
    const capture = nov22Capture();
    expect(kinds(brief(capture, nursery(1)).findings, "too-few-confirmed")).toEqual([]);
    expect(kinds(brief(capture, nursery(2)).findings, "too-few-confirmed")).toHaveLength(1);
  });
});

describe("Background check before serving with kids", () => {
  it("a current, cleared check that runs past Sunday is no finding", () => {
    const capture = withChecks(nov22Capture(), checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2027-01-01" }, PEOPLE.nurseryConfirmed)]));
    const b = brief(capture, nursery(1));
    expect(kinds(b.findings, "background-check")).toEqual([]);
    expect(b.not_checked.join(" ")).not.toMatch(/background/i);
  });

  it("a cleared check the church entered by hand (manual_clear, seen live) counts the same", () => {
    const capture = withChecks(nov22Capture(), checks(PEOPLE.nurseryConfirmed, [check("901", { status: "manual_clear", expires_on: "2027-01-01" }, PEOPLE.nurseryConfirmed)]));
    const b = brief(capture, nursery(1));
    expect(kinds(b.findings, "background-check")).toEqual([]);
    expect(b.not_checked.join(" ")).not.toMatch(/background/i);
  });

  it("a check with no expiry date on file counts as current", () => {
    const capture = withChecks(nov22Capture(), checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: null }, PEOPLE.nurseryConfirmed)]));
    expect(kinds(brief(capture, nursery(1)).findings, "background-check")).toEqual([]);
  });

  it("missing: no current background check on file is a fact with its source and check time", () => {
    const capture = nov22Capture();
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, []));
    const [f, ...rest] = kinds(brief(capture, nursery(1)).findings, "background-check");
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ tone: "decision", person_id: PEOPLE.nurseryConfirmed, check: "none-current",
      source: "Planning Center People", checked_at: "2026-11-20T15:00:05Z", position: { team_id: TEAMS.nursery, name: "Nursery" } });
    expect(f!.key).toBe(JSON.stringify(["background-check", PEOPLE.nurseryConfirmed]));
    expect(f!.why.join(" ")).toContain("no current background check on file");
  });

  it("expired before today counts as no current check", () => {
    const capture = nov22Capture();
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2026-11-01" }, PEOPLE.nurseryConfirmed)]));
    expect(kinds(brief(capture, nursery(1)).findings, "background-check")[0]).toMatchObject({ check: "none-current", tone: "decision" });
  });

  it("a check that runs out between now and Sunday is said as expiring before Sunday", () => {
    const capture = nov22Capture();
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2026-11-21" }, PEOPLE.nurseryConfirmed)]));
    const [f] = kinds(brief(capture, nursery(1)).findings, "background-check");
    expect(f).toMatchObject({ check: "expires-before-sunday", tone: "decision" });
    expect(f!.why.join(" ")).toContain("expires before this Sunday");
  });

  it("a check that expires on Sunday itself is Worth a look", () => {
    const capture = nov22Capture();
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2026-11-22" }, PEOPLE.nurseryConfirmed)]));
    expect(kinds(brief(capture, nursery(1)).findings, "background-check")[0]).toMatchObject({ check: "expires-on-sunday", tone: "look" });
  });

  it("a cleared check Planning Center doesn't mark current is not counted", () => {
    const capture = nov22Capture();
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, [check("901", { current: false, expires_on: "2027-01-01" }, PEOPLE.nurseryConfirmed)]));
    expect(kinds(brief(capture, nursery(1)).findings, "background-check")[0]).toMatchObject({ check: "none-current" });
  });

  it("pending: a person whose check isn't finished has no current check on file (the read only returns cleared checks)", () => {
    // Planning Center is asked for cleared checks only, so an unfinished check never reaches Ozzie: the person reads like one with none.
    const capture = nov22Capture();
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, []));
    const [f] = kinds(brief(capture, nursery(1)).findings, "background-check");
    expect(f).toMatchObject({ check: "none-current" });
    expect(JSON.stringify(f)).not.toMatch(/pending|processing|review|not.clear|canceled/i);
  });

  it("people pending on a kids team are checked too; people who declined are not", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "U", ["9001"]);
    addMember(capture, "453", "553", "D", ["9001"]);
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, []), checks("551", []));
    expect(kinds(brief(capture, nursery(1)).findings, "background-check").map(f => f.person_id).sort()).toEqual([PEOPLE.nurseryConfirmed, "551"].sort());
  });

  it("only people on kids teams: nobody scheduled there means no finding and nothing unchecked", () => {
    const b = brief(nov22Capture(), { ...base, kidsTeams: [{ team_id: TEAMS.lyrics, min_confirmed: 1 }] });
    // Lyrics' only person is pending; no background-check read for them means it wasn't part of this check.
    expect(b.not_checked).toContain("Background checks weren't part of this check. Check Planning Center again to include them.");
    const none = nov22Capture();
    rowsOf(none, "team_members").splice(0);
    const empty = brief(none, nursery(1));
    expect(kinds(empty.findings, "background-check")).toEqual([]);
    expect(empty.not_checked.join(" ")).not.toMatch(/background/i);
  });

  it("when nobody on the kids teams shows any cleared check, each is Worth a look: that can mean the login can't see them", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "C", ["9001"]);
    withChecks(capture, checks(PEOPLE.nurseryConfirmed, []), checks("551", []));
    const found = kinds(brief(capture, nursery(1)).findings, "background-check");
    expect(found.map(f => f.tone)).toEqual(["look", "look"]);
    expect(found[0]!.why.join(" ")).toContain("your Planning Center login can't see them");
  });

  it("a connection without People says plainly what's missing, and finds nothing", () => {
    const capture = withChecks(nov22Capture(), unanswered(PEOPLE.nurseryConfirmed, "not-requested"));
    const b = brief(capture, nursery(1));
    expect(kinds(b.findings, "background-check")).toEqual([]);
    expect(b.not_checked).toContain("Background checks weren't checked: this Planning Center connection doesn't include People. Reconnect with Calendar, People and Groups in Settings to check them.");
  });

  it("a refused or failed read is never read as no check on file", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "C", ["9001"]);
    withChecks(capture, otherOnFile(capture),
      unanswered(PEOPLE.nurseryConfirmed, "denied"), unanswered("551", "provider-failure"));
    const b = brief(capture, nursery(1));
    expect(kinds(b.findings, "background-check")).toEqual([]);
    expect(b.not_checked).toContain("Background checks for 1 person: Planning Center didn't allow it. Your Planning Center login might not be able to see background checks.");
    expect(b.not_checked).toContain("Background checks for 1 person: couldn't be read.");
  });

  it("a partly read list with a current check counts it; without one it is not a finding", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "C", ["9001"]);
    withChecks(capture, otherOnFile(capture),
      checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2027-01-01" }, PEOPLE.nurseryConfirmed)], { outcome: "truncated" }),
      checks("551", [], { outcome: "truncated" }));
    const b = brief(capture, nursery(1));
    expect(kinds(b.findings, "background-check")).toEqual([]);
    expect(b.not_checked).toContain("Background checks for 1 person: only partly read.");
  });

  it("someone scheduled after the check (no read for them) is named as not checked, never as missing a check", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "C", ["9001"]);
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2027-01-01" }, PEOPLE.nurseryConfirmed)]));
    const b = brief(capture, nursery(1));
    expect(kinds(b.findings, "background-check")).toEqual([]);
    expect(b.not_checked).toContain("Background checks for 1 person weren't part of this check.");
  });

  it("turning the background-check rule off removes those findings without a new read", () => {
    const capture = nov22Capture();
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, []));
    expect(kinds(brief(capture, nursery(1)).findings, "background-check")).toHaveLength(1);
    expect(kinds(brief(capture, nursery(1, { kidsBackgroundChecks: false })).findings, "background-check")).toEqual([]);
  });

  it("background-check reads never count as Services reads or make Sunday's coverage incomplete", () => {
    const capture = withChecks(nov22Capture(), unanswered(PEOPLE.nurseryConfirmed, "denied"));
    const before = brief(nov22Capture(), nursery(1)), after = brief(capture, nursery(1));
    expect(after.sources).toEqual(before.sources);
    expect(after.status).toBe(before.status);
    expect(after.findings.filter(f => f.kind === "worth-a-look")).toEqual(before.findings.filter(f => f.kind === "worth-a-look"));
  });

  it("no finding or line carries a person's name, a check's status words or its dates", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "U", ["9001"]);
    withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2026-11-21" }, PEOPLE.nurseryConfirmed)]), checks("551", []));
    const text = JSON.stringify(brief(capture, nursery(3)));
    for (const name of Object.values(capture.names)) expect(text).not.toContain(name);
    expect(text).not.toContain("complete_clear");
    expect(text).not.toContain("2026-11-21");
    expect(CHECKED).toBe("2026-11-20T15:00:00Z");
  });
});

describe("kids findings flow into the briefing; background checks never leave this Mac", () => {
  const KIDS: SundayRules = { ...base, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }, { team_id: TEAMS.lyrics, min_confirmed: 1 }] };
  const capture = withFictionalBackgroundChecks(nov22Capture());
  const b = brief(capture, KIDS);
  const BACKGROUND = /background|BackgroundCheck|complete_clear|expires/i;

  it("the spoken briefing reads them as decisions, and never names a person for a background check (L3)", () => {
    const spoken = buildSpokenBriefing({ attention: null, sunday: b }, { timeZone: "America/New_York" });
    const decisions = spoken.sections.find(s => s.id === "decisions")!.sentences.join(" ");
    expect(decisions).toContain("Only one confirmed person in Nursery at the 9:30 AM service. Your Church rules ask for at least 2.");
    expect(decisions).toContain("No confirmed people in Lyrics at the 9:30 AM service.");
    expect(spoken.text).not.toMatch(/adults?\b/i);
    // Four items per section are read aloud; the rest are pointed to on screen. The background checks alone, names on:
    const checksOnly = { ...b, findings: b.findings.filter(f => f.kind === "background-check") };
    const named = buildSpokenBriefing({ attention: null, sunday: checksOnly }, { timeZone: "America/New_York", includeNames: true, names: capture.names });
    expect(named.text).toContain("One person on Nursery has no current background check on file.");
    expect(named.text).toContain("One person on Lyrics has a background check on file that expires before Sunday.");
    for (const name of Object.values(capture.names)) expect(spoken.text + named.text).not.toContain(name);
  });

  it("the agent sees kids-team counts as placeholders, and the overview says some findings stay in Ozzie", async () => {
    const data = harnessData({ mode: "live", rules: KIDS, capture });
    const tools = new HarnessTools(data, new HarnessSession(), { now: () => "2026-11-20T15:05:00Z" });
    const env = await tools.run("sunday.overview", {}, new AbortController().signal);
    const payload = env.payload as { findings: Record<string, unknown>[]; needs_a_decision: number; kept_on_this_mac?: string };
    expect(payload.findings.filter(r => r["kind"] === "fewer confirmed than the church rules ask")[0]).toMatchObject({
      tone: "needs a decision", confirmed: 1, needed: 2, asked_no_answer: 0, request_not_sent: 0, ages: "confirmed people counted; ages not checked" });
    expect(payload.kept_on_this_mac).toBe("some findings are shown only in Ozzie on this Mac");
    // The count leaves background checks out too: it is the open roles plus the two kids-team counts.
    expect(payload.needs_a_decision).toBe(b.findings.filter(f => f.tone === "decision" && f.kind !== "background-check").length);
    const wire = JSON.stringify(env);
    for (const name of Object.values(capture.names)) expect(wire).not.toContain(name);
    expect(wire).not.toMatch(/Nursery|Lyrics|2026-11-21/);
    expect(wire).not.toMatch(BACKGROUND);
    expect(envelopeProblems(env)).toEqual([]);
    // "Nothing needs a decision" can't be answered while some findings stay on this Mac.
    const quiet = { ...env, payload: { ...(env.payload as Record<string, unknown>), needs_a_decision: 0 } } as typeof env;
    expect(verifyAnswer('{"answer":"nothing-needs-a-decision"}', [quiet]).ok).toBe(false);
  });

  it("M2/M3: no background-check fact is in any agent tool result, procedure, Ask request or shared-check file", async () => {
    for (const data of [harnessData({ mode: "live", rules: KIDS, capture }), harnessData({ mode: "live", rules: KIDS, capture,
      outcomes: { people_background_checks: "denied" } })]) {
      for (const envelope of await allEnvelopes(data)) expect(JSON.stringify(envelope), envelope.tool).not.toMatch(BACKGROUND);
      const shared = await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => "2026-11-20T15:05:00Z" }));
      expect(shared.length).toBeGreaterThan(5);
      expect(sharedCheckText(shared, [], "2026-11-20T15:06:00Z", "B4K7Q2X9M3T8")).not.toMatch(BACKGROUND);
    }
    const skills = await bundledSkills();
    const build = instructionsFor(skills);
    for (const skill of skills.values()) expect(build({ id: "t", kind: "skill", skill_id: skill.id, workspace_id: "w", created_at: "2026-11-20T15:05:00Z" })).not.toMatch(BACKGROUND);
    const session = new AskSession();
    const context = buildAskContext(session, { brief: b, names: capture.names, organization: capture.organization }, { timeZone: "America/New_York" })!;
    const asked = prepareAsk(session, context, "Is everyone on Nursery cleared to serve?");
    expect(asked.ok).toBe(true);
    if (asked.ok) expect(JSON.stringify(asked.asked.request)).not.toMatch(BACKGROUND);
    expect(ASK_SYSTEM).not.toMatch(BACKGROUND);
    expect(context.facts).toMatch(/\| A \| /);
    expect(context.facts).not.toMatch(/\| B \| /);
  });
});

describe("Church rules feedback on kids findings (finding-feedback.ts)", () => {
  const KIDS: SundayRules = { ...base, kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }, { team_id: TEAMS.lyrics, min_confirmed: 1 }] };
  const AT = "2026-11-20T15:10:00Z";
  const kidsKinds = (fs: Finding[]) => fs.filter(f => f.kind === "too-few-confirmed" || f.kind === "background-check");

  it("never offers \"Stop flagging this\" for a kids finding, for a team or one person; a stored stop entry is dropped", () => {
    const capture = withFictionalBackgroundChecks(nov22Capture());
    const found = kidsKinds(brief(capture, KIDS).findings);
    expect(found.map(f => f.kind).sort()).toEqual(["background-check", "background-check", "too-few-confirmed", "too-few-confirmed"]);
    for (const f of found) {
      const t = briefTarget(f, capture.plan_id);
      expect(stopScopes(t), f.key).toEqual([]);
      expect(() => stopEntry(t, t.scope, AT), f.key).toThrow();
      expect(canCorrect(t), f.key).toBe(true);
    }
    const stops = [
      { type: "stop", id: "s1", kind: "background-check", at: AT, scope: { team_id: TEAMS.nursery }, labels: {} },
      { type: "stop", id: "s2", kind: "background-check", at: AT, scope: { team_id: TEAMS.nursery, position: "Nursery", person_id: PEOPLE.nurseryConfirmed }, labels: {} },
      { type: "stop", id: "s3", kind: "too-few-confirmed", at: AT, scope: { team_id: TEAMS.nursery }, labels: {} },
    ] as unknown as SundayRules["feedback"];
    expect(feedbackOf({ feedback: stops })).toEqual([]);
    expect(kidsKinds(brief(capture, { ...KIDS, feedback: stops! }).findings)).toHaveLength(4);
  });

  it("\"This isn't right\" sets aside one Sunday's occurrence only while what it states stays the same", () => {
    const capture = withFictionalBackgroundChecks(nov22Capture());
    const f = kinds(brief(capture, KIDS).findings, "background-check").find(x => x.person_id === PEOPLE.nurseryConfirmed)!;
    const entry = correctionEntry(briefTarget(f, capture.plan_id), "Their check is on file on paper", AT);
    const set = brief(capture, { ...KIDS, feedback: [entry] });
    expect(kinds(set.findings, "background-check").map(x => x.person_id)).toEqual([PEOPLE.lyricsPending]);
    expect(set.hidden?.map(h => h.finding.key)).toEqual([f.key]);
    // A later check finds a check on file that runs out before Sunday: another fact, so it shows again.
    const later = withFictionalBackgroundChecks(nov22Capture());
    later.reads.find(r => r.collection === BACKGROUND_CHECKS && r.people_person_id === PEOPLE.nurseryConfirmed)!.body!.data =
      [check("952", { expires_on: "2026-11-21" }, PEOPLE.nurseryConfirmed)];
    expect(kinds(brief(later, { ...KIDS, feedback: [entry] }).findings, "background-check").find(x => x.person_id === PEOPLE.nurseryConfirmed))
      .toMatchObject({ check: "expires-before-sunday" });
    // A kids-team count set aside comes back when who is pending changes.
    const nursery = kinds(brief(capture, KIDS).findings, "too-few-confirmed").find(x => x.position!.team_id === TEAMS.nursery)!;
    const count = correctionEntry(briefTarget(nursery, capture.plan_id), "", AT);
    expect(kinds(brief(capture, { ...KIDS, feedback: [count] }).findings, "too-few-confirmed").map(x => x.position!.team_id)).toEqual([TEAMS.lyrics]);
    const asked = withFictionalBackgroundChecks(nov22Capture());
    addMember(asked, "451", "551", "U", ["9001"]);
    expect(kinds(brief(asked, { ...KIDS, feedback: [count] }).findings, "too-few-confirmed").map(x => x.position!.team_id)).toEqual([TEAMS.nursery, TEAMS.lyrics]);
  });

  it("names both kinds in plain words on the Church rules list", () => {
    expect(kindWords("too-few-confirmed")).toBe("kids teams with fewer confirmed people than your rule asks");
    expect(kindWords("background-check")).toBe("missing or expiring background checks");
  });
});

describe("review fixes (2026-11-14)", () => {
  it("H1: when every successful read is empty, each card is Worth a look even if other reads failed", () => {
    const capture = nov22Capture();
    addMember(capture, "451", "551", "C", ["9001"]);
    addMember(capture, "452", "552", "C", ["9001"]);
    withChecks(capture, checks(PEOPLE.nurseryConfirmed, []), checks("551", []), unanswered("552", "denied"));
    const b = brief(capture, nursery(1));
    const found = kinds(b.findings, "background-check");
    expect(found.map(f => [f.person_id, f.tone])).toEqual([[PEOPLE.nurseryConfirmed, "look"], ["551", "look"]]);
    expect(found[0]!.why.join(" ")).toContain("your Planning Center login can't see them");
    expect(b.not_checked).toContain("Background checks for 1 person: Planning Center didn't allow it. Your Planning Center login might not be able to see background checks.");
  });

  it("40 cap: people past the bound have no read and are named as not checked, never as having no check", () => {
    const capture = nov22Capture();
    const reads: SundayRead[] = [checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2027-01-01" }, PEOPLE.nurseryConfirmed)])];
    for (let i = 0; i < 40; i++) {
      const person = String(600 + i);
      addMember(capture, String(4600 + i), person, "C", ["9001"]);
      if (i < 39) reads.push(checks(person, [check(String(9600 + i), { expires_on: "2027-01-01" }, person)]));
    }
    const b = brief(withChecks(capture, ...reads), nursery(1));
    expect(kinds(b.findings, "background-check")).toEqual([]);
    expect(b.not_checked).toContain("Background checks for 1 person weren't part of this check.");
  });

  it("L1: a cleared check without an expiry or current field couldn't be read; it is never counted as on file", () => {
    for (const attributes of [{ status: "complete_clear", current: true }, { status: "complete_clear", expires_on: null }]) {
      const capture = nov22Capture();
      withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed,
        [{ type: "BackgroundCheck", id: "901", attributes, relationships: { person: rel("Person", PEOPLE.nurseryConfirmed) } }]));
      const b = brief(capture, nursery(1));
      expect(kinds(b.findings, "background-check"), JSON.stringify(attributes)).toEqual([]);
      expect(b.not_checked).toContain("Background checks for 1 person: couldn't be read.");
    }
  });

  it("without the church's time zone, today is the UTC date of the check", () => {
    // 02:00Z on Nov 21 is Nov 20 in New York: a check expiring Nov 20 is still current there, expired in UTC.
    const make = (zone: boolean) => {
      const capture = nov22Capture();
      if (!zone) capture.reads = capture.reads.filter(r => r.collection !== "organization");
      return withChecks(capture, otherOnFile(capture), checks(PEOPLE.nurseryConfirmed, [check("901", { expires_on: "2026-11-20" }, PEOPLE.nurseryConfirmed)],
        { checked_at: "2026-11-21T02:00:00Z" }));
    };
    expect(kinds(brief(make(true), nursery(1)).findings, "background-check")[0]).toMatchObject({ check: "expires-before-sunday" });
    expect(kinds(brief(make(false), nursery(1)).findings, "background-check")[0]).toMatchObject({ check: "none-current" });
  });

  it("M1: at most 10 kids teams are kept, in the order marked, so a Sunday check is never refused for too many", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => ({ team_id: String(7600000 + i), min_confirmed: 2 }));
    const rules = { ...base, kidsTeams: twelve };
    expect(kidsTeams(rules).map(t => t.team_id)).toEqual(twelve.slice(0, 10).map(t => t.team_id));
    expect(backgroundCheckTeamIds(rules)).toHaveLength(10);
    const ten = { ...base, kidsTeams: twelve.slice(0, 10) };
    expect(kidsTeams(withKidsTeam(ten, "7700000", 2))).toEqual(kidsTeams(ten));
    // A team marked earlier keeps its name for Church rules, even when it isn't on the Sunday checked last.
    expect(kidsTeams(withKidsTeam(base, TEAMS.nursery, 2, "Nursery"))).toEqual([{ team_id: TEAMS.nursery, min_confirmed: 2, name: "Nursery" }]);
    expect(kidsTeams(withKidsTeam(withKidsTeam(base, TEAMS.nursery, 2, "Nursery"), TEAMS.nursery, 3))).toEqual([{ team_id: TEAMS.nursery, min_confirmed: 3, name: "Nursery" }]);
  });
});
