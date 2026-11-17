// "Ask Ozzie to look at who could help" on a Sunday card (audit item 9): the who-could-help procedure, run for real through
// the harness for that one role at one time, beside the fixed list that stays the source of truth. The model still
// returns only fact ids; the card lists everyone the check listed, alphabetically with the same closed labels as the
// fixed list, from the finding itself and never from the AI's copy (review G, M-1), never as the AI's pick, and never
// shows a draft (review H, M3). And
// every Sunday card's "See how this works" says the finding came from Ozzie's own check, with no AI, and the reads it
// used. Fictional data and a scripted model; nothing native runs.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => { throw new Error("NATIVE_CALL_FORBIDDEN"); }) }));
import { bundledSkills } from "../../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../../core/src/harness/session.js";
import type { HarnessData } from "../../../core/src/harness/index.js";
import type { Finding } from "../../../core/src/sunday-brief.js";
import type { SundayCapture, SundayRead, SundayRules } from "../../../core/src/sunday-capture.js";
import { nov22Capture, TEAMS, withFictionalBackgroundChecks } from "../../../core/src/fictional-sunday.js";
import { withFictionalOperations } from "../../../core/src/fictional-operations.js";
import { sundayOperations } from "../../../core/src/operations-capture.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { createAppHarness, LedgerRecorder, localTriggers, lookAtWhoCouldHelp, oneRole, WHO_COULD_HELP, type AskTurn, type Look } from "../src/harness-bridge.js";
import { listedPeople, lookEnded, READS_FOR, readsFor, SundayPage, WhoCouldHelpCard } from "../src/sunday-page.js";
import { calls, facts, fakeNative, fictionalData, HIDDEN_WORDS, payloadOf, RULES, scripted, taskIds, text, type Turn } from "./harness-fakes.js";

const skills = await bundledSkills();
const greeter = (data: HarnessData) => data.brief!.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
type Row = { fact: string; person: string; status: string };
/** Open roles, then that role's team; then every person in the reverse of the order given, and the role's time. */
const lookTurns: Turn[] = [
  () => calls(["sunday.open_needs"]),
  r => calls(["sunday.who_could_help", { role: (payloadOf(r, "sunday.open_needs")!["needs"] as { role: string }[])[0]!.role }]),
  r => { const p = payloadOf(r, "sunday.who_could_help")!; return facts([...(p["people"] as Row[]).map(x => x.fact).reverse(), (p["times"] as { fact: string }[])[0]!.fact]); },
];

async function look(turns = lookTurns) {
  const data = fictionalData();
  const m = scripted(turns);
  const ledger = fakeNative();
  const kept = new Map<string, string>();
  const recorder = new LedgerRecorder({ invoke: ledger.invoke, hashFor: async id => skills.get(id)?.hash, newId: taskIds(), readyMs: 200,
    triggers: localTriggers({ getItem: k => kept.get(k) ?? null, setItem: (k, v) => { kept.set(k, v); } }) });
  const session = new HarnessSession();
  const turn = await lookAtWhoCouldHelp(d => createAppHarness({ workspace_id: "fictional", data: d, skills, session, loop: "ts", step: m.model, recorder }), data, greeter(data),
    { skills, recorder });
  await recorder.idle();
  return { turn, data, m, ledger, kept };
}

describe("Ask Ozzie to look at who could help, from a Sunday card", () => {
  it("runs the who-could-help procedure through the harness for that one role, recorded like any task", async () => {
    const { turn, m, ledger, kept } = await look();
    if (turn.state !== "answered") throw new Error(turn.state);
    // The procedure itself: its pinned text, only its own tools, and only that role in what was read.
    expect(m.requests[0]!.messages[0]!.content).toContain(skills.get(WHO_COULD_HELP)!.body);
    expect(m.requests[0]!.tools.map(t => t.name)).toEqual(["sunday.open_needs", "sunday.who_could_help", "drafts.prepare_note"]);
    const needs = payloadOf(m.requests[1]!, "sunday.open_needs")!["needs"] as { role: string }[];
    expect(needs).toHaveLength(1);
    expect(ledger.log[0]).toEqual(["ledger_admit", expect.objectContaining({ kind: "skill", skillId: WHO_COULD_HELP })]);
    expect([...kept.values()].join("")).toMatch(/"who-could-help","facts"\]\]$/u);
    expect(turn.answer.procedure?.title).toBe("Who could help");
    expect(turn.answer.aiSteps).toBe(3);
  });

  it("lists everyone the check listed for the role, alphabetically under the fixed list's labels, never the AI's pick or order (review H, M3)", async () => {
    // The AI names only one person (the last given), and the role's time: the card still lists everyone, marking no one.
    const { turn, data } = await look([
      () => calls(["sunday.open_needs"]),
      r => calls(["sunday.who_could_help", { role: (payloadOf(r, "sunday.open_needs")!["needs"] as { role: string }[])[0]!.role }]),
      r => { const p = payloadOf(r, "sunday.who_could_help")!; return facts([(p["people"] as Row[]).at(-1)!.fact, (p["times"] as { fact: string }[])[0]!.fact]); },
    ]);
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.look).toEqual({ kind: "lines", looked: true, shortened: 0 });
    const html = card(turn, data);
    expect(namesIn(html)).toEqual([
      ["Riley Thornbury", "No overlap found"], ["Casey Pemberly", "Possible conflict"], ["Drew Halvorsen", "Availability needs confirmation"],
      ["Morgan Ellingsworth", "Left out"], ["Sam Whitcombe", "Left out"],
    ]);
    // What the AI adds is Ozzie's line about the role; no person is a sentence, and nothing says who the AI named.
    expect(turn.answer.body).toBe("Greeter at 9:30 AM on November 22 still needs 1 more person, by Planning Center's count.");
    expect(text(html)).not.toMatch(/chose|picked|suggest|recommend|first to ask|best/iu);
    expect(text(html).split("Morgan Ellingsworth").length - 1).toBe(1);
  });

  it("takes the people from the finding, as the fixed list does, never from the AI's copy cut to fit: 40 and 85 on a team (review G, M-1)", async () => {
    for (const n of [40, 85]) {
      const data = bigTeam(n);
      const finding = greeter(data);
      const m = scripted([
        () => calls(["sunday.open_needs"]),
        r => calls(["sunday.who_could_help", { role: (payloadOf(r, "sunday.open_needs")!["needs"] as { role: string }[])[0]!.role }]),
        r => { const p = payloadOf(r, "sunday.who_could_help")!; return facts([(p["times"] as { fact: string }[])[0]!.fact]); },
      ]);
      const turn = await lookAtWhoCouldHelp(d => createAppHarness({ workspace_id: "x", data: d, skills, session: new HarnessSession(), loop: "ts", step: m.model }), data, finding, { skills });
      if (turn.state !== "answered") throw new Error(turn.state);
      // The AI's copy was cut to fit what it may read; the card's list never is.
      const given = (payloadOf(m.requests[2]!, "sunday.who_could_help")!["people"] as Row[]).length;
      expect(given, `${n}`).toBeLessThan(n + 5);
      expect(turn.answer.look).toEqual({ kind: "lines", looked: true, shortened: n + 5 - given });
      const html = card(turn, data);
      // Exactly the fixed list's people and labels, in its order (left out included).
      const fixed = listedPeople(finding, data.capture!.names).map(x => [data.capture!.names[x.person.person_id]!, x.label]);
      expect(fixed).toHaveLength(n + 5);
      expect(namesIn(html), `${n}`).toEqual(fixed);
      // No read "couldn't be read" here: the card says the AI's list was shortened, and by how many.
      expect(text(html)).not.toMatch(/couldn't be read|Worth a look/u);
      expect(text(html)).toContain(`The AI looked at a shortened list: it wasn't given ${n + 5 - given} of the people Ozzie's check listed.`);
      expect(turn.answer.steps).toContain("Looked at who is on the team for an open role — a shortened list");
    }
  });

  it("adds no mark beside a person beyond the fixed list's own: the same rows, without the fixed list's actions (review G)", async () => {
    const { turn, data } = await look();
    if (turn.state !== "answered") throw new Error(turn.state);
    const ai = rowsIn(card(turn, data));
    const fixed = rowsIn(renderToStaticMarkup(React.createElement(SundayPage, {
      brief: data.brief!, names: data.capture!.names, busy: false, problem: "", sender: "", connected: false, hasRecording: false, configured: false, canReword: false,
      decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    })).replace(/<button[^>]*>Prepare a note<\/button>/gu, ""));
    // Left out is folded on the fixed list; every row it shows is the AI card's row exactly.
    const shown = ai.filter(r => !r.includes("is-left"));
    expect(shown.length).toBeGreaterThan(0);
    for (const row of shown) expect(fixed).toContain(row);
    // And every row, left out too, is one icon, one name, one closed label and its reasons: nothing else.
    const marks: Record<string, string> = { "No overlap found": "b-confirm", "Possible conflict": "b-conflict", "Availability needs confirmation": "b-look", "Left out": "b-muted" };
    for (const row of ai) {
      expect(row.match(/<svg/gu), row).toHaveLength(1);
      expect(row.match(/class="badge/gu), row).toHaveLength(1);
      const [, cls, label] = /<span class="badge ([^"]+)">([^<]+)<\/span>/u.exec(row)!;
      expect(marks[label!], row).toBe(cls);
      expect([...row.matchAll(/class="([^"]+)"/gu)].map(x => x[1]).filter(c => !/^(?:person(?: is-left)?|ic|person-top|person-name|badge b-[a-z]+|person-role)$/u.test(c!)), row).toEqual([]);
      expect(row).not.toMatch(/<(?:button|a|img|strong|em)\b/u);
    }
  });

  it("uses the newest answer from the tool that listed the role's people when it is asked twice in one run (review G)", async () => {
    // The app's session keeps labels across tasks: an earlier question gave every open role one, so the AI can ask about
    // a role this card isn't about, and gets no people for it.
    const data = bigTeam(40);
    const session = new HarnessSession();
    const earlier = scripted([() => calls(["sunday.open_needs"]), r => facts([(payloadOf(r, "sunday.open_needs")!["needs"] as { fact: string }[])[0]!.fact])]);
    await createAppHarness({ workspace_id: "x", data, skills, session, loop: "ts", step: earlier.model }).runSkill("sunday-ready");
    const roles = (payloadOf(earlier.requests[1]!, "sunday.open_needs")!["needs"] as { role: string }[]).map(n => n.role);
    const run = async (order: "other-first" | "other-last") => {
      const own = (r: Parameters<Turn>[0]) => (payloadOf(r, "sunday.open_needs")!["needs"] as { role: string }[])[0]!.role;
      const other = (r: Parameters<Turn>[0]) => roles.find(x => x !== own(r))!;
      const m = scripted([
        () => calls(["sunday.open_needs"]),
        r => calls(["sunday.who_could_help", { role: order === "other-first" ? other(r) : own(r) }]),
        r => calls(["sunday.who_could_help", { role: order === "other-first" ? own(r) : other(r) }]),
        r => facts([(payloadOf(r, "sunday.open_needs")!["needs"] as { fact: string }[])[0]!.fact]),
      ]);
      const turn = await lookAtWhoCouldHelp(d => createAppHarness({ workspace_id: "x", data: d, skills, session, loop: "ts", step: m.model }), data, greeter(data), { skills });
      if (turn.state !== "answered") throw new Error(turn.state);
      const answers = m.requests.at(-1)!.messages.filter(x => x.role === "tool").map(x => JSON.parse(x.content) as { tool: string; payload: { people?: unknown[] } })
        .filter(x => x.tool === "sunday.who_could_help");
      expect(answers.map(x => (x.payload.people ?? []).length > 0), order).toEqual(order === "other-first" ? [false, true] : [true, false]);
      return { look: turn.answer.look!, given: answers.find(x => (x.payload.people ?? []).length)!.payload.people!.length };
    };
    for (const order of ["other-first", "other-last"] as const) {
      const { look, given } = await run(order);
      expect(look, order).toEqual({ kind: "lines", looked: true, shortened: 45 - given });
      expect(given).toBeLessThan(45);
    }
  });

  it("shows the result as a card under the fixed list: what the AI found, everyone listed, where it came from, See how this works", async () => {
    const { turn, data } = await look();
    if (turn.state !== "answered") throw new Error(turn.state);
    const html = card(turn, data);
    const t = text(html);
    expect(t).toMatch(/AI help Greeter What the AI found when asked to look at the list above Greeter at 9:30 AM/u);
    expect(t).toMatch(/Riley Thornbury No overlap found .*Casey Pemberly Possible conflict .*Drew Halvorsen Availability needs confirmation/u);
    expect(t).toContain("Everyone the check listed is shown, alphabetically. Being listed first or last says nothing about anyone, and whether someone is willing is theirs to say.");
    expect(t).not.toContain("this is what the AI chose from it");
    expect(t.split("free or willing").length - 1).toBe(0);
    expect(t).toContain("Based on: fictional example data as of");
    expect(t).toContain("See how this works");
    expect(t).not.toMatch(/shortened/u);
    expect(html).not.toMatch(/Prepare a note|>\s*Send|Approve|\[(?:Person|Role) \d+\]/u);
    expect(t).not.toMatch(HIDDEN_WORDS);
  });

  it("says what the AI did in each case, on the card and in its account (review G, N3, N4)", async () => {
    const open = async (turns: Turn[]) => {
      const { turn, data } = await look(turns);
      if (turn.state !== "answered") throw new Error(turn.state);
      const t = text(card(turn, data));
      return { turn, look: turn.answer.look!, t, ended: lookEnded(turn.answer.look!) };
    };
    const toList: Turn[] = [() => calls(["sunday.open_needs"]), r => calls(["sunday.who_could_help", { role: (payloadOf(r, "sunday.open_needs")!["needs"] as { role: string }[])[0]!.role }])];
    // Asked for the list, and chose a fact about the role.
    const lines = await open([...toList, r => facts([(payloadOf(r, "sunday.who_could_help")!["times"] as { fact: string }[])[0]!.fact])]);
    expect(lines.look).toEqual({ kind: "lines", looked: true, shortened: 0 });
    expect(lines.ended).toBe("Ozzie wrote a line for each fact the AI chose about the role. The people are Ozzie's own list for this role, the same as above.");
    // Asked for the list, and chose nothing about the role (only people).
    const nothing = await open([...toList, r => facts((payloadOf(r, "sunday.who_could_help")!["people"] as Row[]).map(x => x.fact))]);
    expect(nothing.look).toEqual({ kind: "nothing", looked: true, shortened: 0 });
    expect(nothing.t).toContain("The AI looked at the same list and had nothing to add.");
    expect(nothing.t).not.toMatch(/Riley|Casey|Morgan/u);
    expect(nothing.ended).toBe("The AI looked at the list of people and chose nothing beyond it, so Ozzie said so.");
    // Never asked for the list, with a fact about the role: the people are still the finding's own, and it says so.
    const unlisted = await open([() => calls(["sunday.open_needs"]), r => facts([(payloadOf(r, "sunday.open_needs")!["needs"] as { fact: string }[])[0]!.fact])]);
    expect(unlisted.look).toEqual({ kind: "lines", looked: false, shortened: 0 });
    expect(unlisted.t).toMatch(/Riley Thornbury No overlap found/u);
    expect(unlisted.ended).toBe("Ozzie wrote a line for each fact the AI chose about the role. The AI didn't ask for the list of people; the people are Ozzie's own list for this role, the same as above.");
    // Never asked for the list, and nothing about the role (the verifier refuses most such answers; said truly if one passes).
    const none: Look = { kind: "nothing", looked: false, shortened: 0 };
    if (lines.turn.state !== "answered") throw new Error(lines.turn.state);
    const noneCard = text(card({ state: "answered", answer: { ...lines.turn.answer, look: none } }, fictionalData()));
    expect(noneCard).toContain("The AI didn't look at the list of people and had nothing to add.");
    expect(noneCard).not.toContain("The AI looked at the same list");
    expect(lookEnded(none)).toBe("The AI didn't ask for the list of people and chose nothing about the role, so Ozzie said so.");
    // Not covered.
    const notCovered = await open([...toList, r => facts((payloadOf(r, "sunday.who_could_help")!["people"] as Row[]).map(x => x.fact), "not-covered")]);
    expect(notCovered.t).toContain("The AI couldn't tell more than the list above shows.");
    expect(notCovered.t).not.toMatch(/Riley|Casey|free or willing|I can't tell/u);
    expect(notCovered.ended).toBe("The AI answered that it couldn't tell more, so Ozzie said so.");
  });

  it("an answer with a note says the AI asked for one, which isn't prepared here; the note itself is never shown (review G, N4)", async () => {
    const { turn, data } = await look([
      () => calls(["sunday.open_needs"]),
      r => calls(["sunday.who_could_help", { role: (payloadOf(r, "sunday.open_needs")!["needs"] as { role: string }[])[0]!.role }]),
      r => { const p = payloadOf(r, "sunday.who_could_help")!; const pick = (p["people"] as Row[]).find(x => x.status === "no overlap found")!;
        return calls(["drafts.prepare_note", { person: pick.person, role: (p["times"] as { role: string }[])[0]!.role }]); },
      r => { const p = payloadOf(r, "sunday.who_could_help")!; const pick = (p["people"] as Row[]).find(x => x.status === "no overlap found")!;
        return facts([pick.fact], "draft", String(payloadOf(r, "drafts.prepare_note")!["draft_id"])); },
    ]);
    if (turn.state !== "answered") throw new Error(turn.state);
    expect(turn.answer.draft).toBeNull();
    expect(turn.answer.look).toEqual({ kind: "draft", looked: true, shortened: 0 });
    expect(turn.answer.steps.join(" ")).not.toMatch(/draft/iu);
    const html = card(turn, data);
    expect(text(html)).toContain("The AI asked for a note, which isn't prepared here. Use Prepare a note on a person's row above.");
    expect(text(html)).not.toMatch(/had nothing to add|chose nothing/u);
    expect(lookEnded(turn.answer.look!)).toBe("The AI asked for a note, which isn't prepared from this card, so Ozzie said so.");
    expect(html).not.toMatch(/Draft only|Hi Riley|Copy|Open in Mail|>\s*Send/u);
  });

  it("a run that couldn't finish says so in this card's own words, and that the list above is unchanged (review H, L11)", async () => {
    const { turn } = await look([() => calls(["sunday.open_needs"]), () => facts(["f99"])]);
    expect(turn.state).toBe("problem");
    const t = text(renderToStaticMarkup(React.createElement(WhoCouldHelpCard, { turn, finding: greeter(fictionalData()), names: {} })));
    expect(t.trim()).toBe("Ozzie couldn't finish looking at who could help. The list above is unchanged.");
  });

  it("is offered on an open role's card beside the fixed list only while AI help is set up", () => {
    const data = fictionalData();
    const page = (whoCouldHelp?: () => Promise<never>) => renderToStaticMarkup(React.createElement(SundayPage, {
      brief: data.brief!, names: data.capture!.names, busy: false, problem: "", sender: "", connected: false, hasRecording: false, configured: false, canReword: true,
      decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
      ...(whoCouldHelp ? { whoCouldHelp } : {}),
    }));
    const on = page(() => new Promise<never>(() => {}));
    // Once per open role whose card lists people, after its fixed list.
    const listing = data.brief!.findings.filter(f => f.kind === "needs-people" && f.people && (f.people.suggestions.length + f.people.conflicts.length + f.people.unverified.length + f.people.left_out.length) > 0);
    expect(on.match(/Ask Ozzie to look at who could help/gu)).toHaveLength(listing.length);
    expect(on.indexOf("Listed alphabetically, not ranked.")).toBeLessThan(on.indexOf("Ask Ozzie to look at who could help"));
    expect(page()).not.toContain("Ask Ozzie to look at who could help");
  });

  it("narrows what the procedure reads to the card's own finding, and changes nothing else (review H, M2)", () => {
    const data = fictionalData();
    const narrowed = oneRole(data, greeter(data));
    expect(narrowed.brief!.findings.map(f => f.id)).toEqual([greeter(data).id]);
    expect(narrowed.capture).toBe(data.capture);
    expect(narrowed.rules).toBe(data.rules);
    expect(data.brief!.findings.length).toBeGreaterThan(1);
    // The same role on another team, or at another time, is another finding: never kept beside it.
    const other = { ...greeter(data), id: "need:other", position: { ...greeter(data).position!, team_id: "another-team" } };
    expect(oneRole({ ...data, brief: { ...data.brief!, findings: [...data.brief!.findings, other] } }, greeter(data)).brief!.findings.map(f => f.id)).toEqual([greeter(data).id]);
  });

  it("with a role at two service times, the card for one time shows that time's people and labels, as its fixed list does (review H, M2)", async () => {
    const { data, first } = twoTimes();
    const m = scripted([
      () => calls(["sunday.open_needs"]),
      r => calls(["sunday.who_could_help", { role: (payloadOf(r, "sunday.open_needs")!["needs"] as { role: string }[])[0]!.role }]),
      r => { const p = payloadOf(r, "sunday.who_could_help")!; return facts([(p["times"] as { fact: string }[])[0]!.fact]); },
    ]);
    const turn = await lookAtWhoCouldHelp(d => createAppHarness({ workspace_id: "x", data: d, skills, session: new HarnessSession(), loop: "ts", step: m.model }), data, first, { skills });
    if (turn.state !== "answered") throw new Error(turn.state);
    // Only one time was read, and Riley is "No overlap found" at it, as on the 9:30 card's own list.
    expect((payloadOf(m.requests[1]!, "sunday.open_needs")!["needs"] as unknown[])).toHaveLength(1);
    expect(namesIn(card(turn, data, first)).find(([name]) => name === "Riley Thornbury")?.[1]).toBe("No overlap found");
    expect(namesIn(card(turn, data, first))).toEqual(listedPeople(first, data.capture!.names).map(x => [data.capture!.names[x.person.person_id]!, x.label]));
    expect(turn.answer.body).toMatch(/^Greeter at 9:30 AM on November 22 /u);
  });
});

const withoutBody = (r: SundayRead): SundayRead => { const rest = { ...r }; delete rest.body; return rest; };

/** The AI's card for a turn, with the finding's own people (as SundayPage renders it). */
const card = (turn: AskTurn, data: HarnessData, finding = greeter(data)) =>
  renderToStaticMarkup(React.createElement(WhoCouldHelpCard, { turn, finding, names: data.capture!.names }));
/** Each person row's markup, in order. */
const rowsIn = (html: string) => [...html.matchAll(/<div class="person(?: is-left)?">.*?<\/p><\/div><\/div>/gu)].map(m => m[0]);
/** Each person row's name and label, in order. */
const namesIn = (html: string) => rowsIn(html).map(r => [/<span class="person-name">([^<]+)</u.exec(r)![1]!.replace(/&#x27;/gu, "'"), /<span class="badge [^"]+">([^<]+)</u.exec(r)![1]!]);

/**
 * The fictional example with `n` more people on the Greeter team, each with a name: a third with no overlap, a third
 * with a possible conflict, a third left out, with the check's own reasons (review G, M-1: a big team).
 */
function bigTeam(n: number): HarnessData {
  const base = fictionalData();
  const brief = structuredClone(base.brief!);
  const names = { ...base.capture!.names };
  const f = brief.findings.find(x => x.kind === "needs-people" && x.position?.name === "Greeter")!;
  const p = f.people!;
  const [conflict, left] = [p.conflicts[0]!.reasons, p.left_out[0]!.reasons];
  for (let i = 0; i < n; i++) {
    const id = String(9000 + i);
    names[id] = `Avery Helper${String(i).padStart(2, "0")}`;
    (i % 3 === 0 ? p.suggestions : i % 3 === 1 ? p.conflicts : p.left_out).push({ person_id: id, reasons: i % 3 === 0 ? [] : [...conflict, ...left] });
  }
  return { ...base, brief, capture: { ...base.capture!, names } };
}

/** Greeter at a second service time where Riley (511, "No overlap found" at 9:30) has a confirmed overlap (review H). */
function twoTimes(): { data: HarnessData; first: Finding } {
  const base = fictionalData();
  const brief = structuredClone(base.brief!);
  const first = brief.findings.find(f => f.kind === "needs-people" && f.position?.name === "Greeter")!;
  const second: Finding = structuredClone(first);
  second.id = "need:position:9"; second.key = `${first.key}-late`;
  second.position = { ...first.position!, interval: { starts_at: "2026-11-22T16:30:00Z", ends_at: "2026-11-22T17:30:00Z" } };
  const riley = first.people!.suggestions.find(p => p.person_id === "511")!;
  second.people = { ...first.people!, suggestions: [], conflicts: [{ ...riley, reasons: ["Confirmed overlapping serving assignment."] }] } as NonNullable<Finding["people"]>;
  brief.findings.push(second);
  return { data: { ...base, brief }, first };
}

describe("Church rules says what the procedures are for, and that Sunday's own check doesn't use them", () => {
  it("names the three things that run them", async () => {
    const { HowOzzieChecks } = await import("../src/rules-page.js");
    const t = text(renderToStaticMarkup(React.createElement(HowOzzieChecks, { procedures: [...skills.values()] })));
    expect(t).toContain("These are the steps the AI follows when Ozzie asks it for help: answering a question in Ask, writing up a job Ozzie keeps an eye on, and looking at who could help with a role. Ozzie's own checks of Sunday don't use them.");
    expect(t).not.toMatch(HIDDEN_WORDS);
  });
});

describe("every Sunday card's See how this works: Ozzie's own check, no AI (audit item 9a)", () => {
  const capture = nov22Capture();
  const brief = buildSundayBrief(capture, RULES, capture.completed_at, true);
  it("names the reads each kind of finding uses, in What happened's words, and never a procedure", () => {
    const needs = brief.findings.find(f => f.kind === "needs-people")!;
    expect(readsFor(needs)).toEqual(["Read the service times", "Read the open roles", "Read who is scheduled", "Read who is on a team",
      "Read a team's leaders", "Read one person's other schedules", "Read one person's blockouts"]);
    for (const f of brief.findings) expect(readsFor(f).length).toBeGreaterThan(0);
    // "Worth a look" about the check itself names no shorter list than every read.
    expect(readsFor({ kind: "worth-a-look" } as Finding)).toEqual(["Every read in this check, each listed on What happened"]);
  });

  it("names exactly the reads whose failure changes that kind of finding, worked out from the engine itself (review H, L5)", () => {
    // The engine declares no reads per kind, so the table is hand-kept and held here: each read of the fictional check is
    // failed in turn, and a read belongs to a kind exactly when failing it changes that kind's findings.
    const full = withFictionalOperations(withFictionalBackgroundChecks(nov22Capture()));
    const ruleSets = [RULES, { ...RULES, sundayLeads: [{ team_id: TEAMS.greeter, lead_position: "Greeter Lead" }], kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 3 }] }];
    const at = full.completed_at;
    const kindsOf = (c: SundayCapture, rules: SundayRules): Record<string, string> => {
      const b = buildSundayBrief(c, rules, at, true);
      const ops = sundayOperations(c, rules, { now: at });
      const found: Record<string, unknown[]> = {};
      for (const f of b.findings) (found[f.kind] ??= []).push(f);
      found["rooms"] = (ops?.result?.findings ?? []).filter(f => f.kind === "room-overlap");
      found["follow-ups"] = (ops?.result?.findings ?? []).filter(f => f.kind === "unowned-overdue");
      found["group-meetings"] = ops?.group_meetings ?? [];
      return Object.fromEntries(Object.entries(found).map(([k, v]) => [k, JSON.stringify(v)]));
    };
    const collections = [...new Set(full.reads.map(r => r.collection))];
    const derived = new Map<string, Set<string>>();
    for (const rules of ruleSets) {
      const base = kindsOf(full, rules);
      for (const kind of Object.keys(base)) derived.set(kind, derived.get(kind) ?? new Set());
      for (const c of collections) {
        const failed = kindsOf({ ...full, reads: full.reads.map((r): SundayRead => r.collection === c ? { ...withoutBody(r), outcome: "error" } : r) }, rules);
        for (const kind of Object.keys(base)) if (failed[kind] !== base[kind]) derived.get(kind)!.add(c);
      }
    }
    // Every kind the fictional check produces, and the rooms, follow-ups and group meetings cards.
    expect([...derived.keys()].sort()).toEqual(["background-check", "follow-ups", "group-meetings", "lead-missing", "needs-people", "pending", "rooms", "streak", "too-few-confirmed"]);
    for (const [kind, reads] of derived) {
      const inOrder = collections.filter(c => reads.has(c));
      // Follow-up steps only name a step and its owner: failing them leaves the findings as they were, so they are added by hand.
      expect(READS_FOR[kind], kind).toEqual(kind === "follow-ups" ? [...inOrder.slice(0, 1), "people_workflow_steps", ...inOrder.slice(1)] : inOrder);
    }
    expect(READS_FOR["lead-unverified"]).toEqual(READS_FOR["lead-missing"]);
    expect(Object.keys(READS_FOR).sort()).toEqual([...derived.keys(), "lead-unverified"].sort());
  });
});
