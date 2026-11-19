// A note opens where it was asked for (click-through of 0.3.3, 2026-11-19): "Prepare a note" on the first of two people
// opened the draft under the whole list, off screen, and the button didn't change, so it seemed to do nothing. Now each
// note opens right under the button that prepared it (a person's row, or the card's buttons for the team's leader and a
// reminder), takes the keyboard focus so VoiceOver reads it, scrolls the page pane only as far as it must, and its button
// says it's open and closes it on a second press; the note's X gives the focus back to that button. Mounted on the fake
// document (test/fake-dom.ts) with fixed fictional data; the Mac is a fake.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { text } from "./harness-fakes.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { closeLabel, DRAFT_FOOTER, Draft, LOOKS_GOOD, LOOKS_GOOD_HELP, PREPARE_NOTE, PREPARE_REMINDER, showNote, SundayPage } from "../src/sunday-page.js";
import { HAND_OFF_NOTE, HAND_OFF_TO_SHORT, handOffToNote, HOW_OPEN } from "../src/draft-actions.js";
import { DraftCard } from "../src/ask-panel.js";
import { buildSundayBrief, type Finding, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture, PEOPLE, TEAMS } from "../../../core/src/fictional-sunday.js";
import type { SundayCapture, SundayRules } from "../../../core/src/sunday-capture.js";
import type { FeedbackEntry } from "../../../core/src/finding-feedback.js";

const dom = installFakeDom({ focus: true });
type El = NonNullable<ReturnType<typeof dom.button>>;
const rules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
const names = nov22Capture().names;
/** A live check (not the example), so a note for one person has its addressee, as on the owner's own church. */
const live = (capture: SundayCapture = nov22Capture(), r: SundayRules = rules) => buildSundayBrief(capture, r, capture.completed_at);
/** Lyrics' request was sent and has no answer: its card offers a reminder (as in draft-actions.test.ts). */
const sentRequest = () => {
  const capture = nov22Capture();
  const members = capture.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[];
  members.find(m => m.id === "403")!.attributes.notification_sent_at = "2026-11-18T12:00:00Z";
  return capture;
};

// Nothing is laid out on the fake document: a note is placed below the window (the pane is 840 high) and taller than
// it, as in the report.
const proto = Object.getPrototypeOf(dom.root) as { getBoundingClientRect(this: El): unknown };
const flat = proto.getBoundingClientRect;
const box = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top });
proto.getBoundingClientRect = function (this: El) {
  return this.getAttribute("role") === "region" && /^Draft/u.test(this.getAttribute("aria-label") ?? "") ? box(900, 2000) : flat.call(this);
};
const pane = () => ({ scrollTop: 0, getBoundingClientRect: () => box(0, 840), scrollBy: vi.fn() });

const isEl = (n: unknown): n is El => Boolean(n && (n as El).nodeType === 1);
const kids = (n: El) => (n.childNodes as unknown[]).filter(isEl);
const all = (n: El): El[] => [n, ...kids(n).flatMap(all)];
const classes = (n: El) => (n.getAttribute("class") ?? "").split(" ");
/** The words a person sees under `n`: nothing inside a hidden element. */
const visible = (n: El): string => n.hasAttribute("hidden") ? ""
  : (n.childNodes as unknown[]).map(c => isEl(c) ? visible(c) : (c as { nodeType: number; nodeValue: string | null }).nodeType === 3 ? (c as { nodeValue: string }).nodeValue : "").join("");
const isNote = (n: El | undefined) => Boolean(n && n.getAttribute("role") === "region" && /^Draft/u.test(n.getAttribute("aria-label") ?? ""));
const notesIn = (n: El) => all(n).filter(isNote);
const buttonsIn = (n: El, label: string) => all(n).filter(b => b.tagName === "BUTTON" && b.textContent === label);
const card = (words: string) => {
  const found = all(dom.root).find(n => n.tagName === "ARTICLE" && (n.textContent ?? "").includes(words));
  if (!found) throw new Error(`no card with "${words}" in: ${dom.seen().slice(0, 400)}`);
  return found;
};
const nameIn = (row: El) => all(row).find(n => classes(n).includes("person-name"))!.textContent;
/** Which element, in a few words: a failure names it rather than printing the whole fake document. */
const named = (n: El | null | undefined) => n ? `<${n.tagName.toLowerCase()} ${n.getAttribute("aria-label") ?? n.getAttribute("class") ?? ""}> ${(n.textContent ?? "").slice(0, 50)}` : "nothing";
const same = (actual: El | null | undefined, expected: El | null | undefined, what: string) =>
  expect(actual === expected, `${what}: ${named(actual)}, expected ${named(expected)}`).toBe(true);

let unmount: (() => Promise<void>) | null = null;
afterEach(async () => { await unmount?.(); unmount = null; vi.unstubAllGlobals(); });

async function mount(props: Partial<React.ComponentProps<typeof SundayPage>> & { brief: SundayBrief }) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = dom.root.appendChild((dom.root.ownerDocument as unknown as { createElement(t: string): El }).createElement("div"));
  const root = createRoot(host as unknown as Element);
  const element = () => React.createElement(SundayPage, {
    names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false,
    decisions: [], onDecisions: () => undefined, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    people: { granted: true }, ...props,
  });
  await act(async () => { root.render(element()); });
  unmount = async () => { await act(async () => { root.unmount(); }); dom.root.removeChild(host); };
  return { press: async (b: El | undefined) => { if (!b) throw new Error("no such button"); await act(async () => { dom.press(b); }); } };
}

describe("a note to one person opens right under their row", () => {
  it("the first person's note follows their row and comes before the next person, and their button says it's open", async () => {
    const page = await mount({ brief: live() });
    const greeter = card("Greeter still needs");
    const prepare = buttonsIn(greeter, PREPARE_NOTE);
    expect(prepare.length).toBeGreaterThanOrEqual(2);
    expect(prepare.map(b => b.getAttribute("aria-expanded"))).toEqual(prepare.map(() => "false"));
    await page.press(prepare[0]);
    const list = all(greeter).find(n => classes(n).includes("people"))!;
    const order = kids(list);
    const rows = order.filter(n => classes(n).includes("person"));
    const first = order.indexOf(rows[0]!);
    // Row, its note, then the next person: never the list first and the note under it.
    expect(isNote(order[first + 1])).toBe(true);
    same(order[first + 2], rows[1], "after the note");
    expect(order[first + 1]!.textContent).toContain(`To ${nameIn(rows[0]!)}`);
    expect(notesIn(greeter)).toHaveLength(1);
    expect(prepare[0]!.textContent).toBe("Close the note");
    expect(prepare[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(prepare[1]!.textContent).toBe(PREPARE_NOTE);
    expect(prepare[1]!.getAttribute("aria-expanded")).toBe("false");
  });

  it("takes the focus and scrolls only the page pane, only as far as it must, smoothly; its X gives the focus back to the button", async () => {
    const at = pane();
    const page = await mount({ brief: live(), pane: { current: at as unknown as HTMLElement } });
    const greeter = card("Greeter still needs");
    const button = buttonsIn(greeter, PREPARE_NOTE)[0]!;
    await page.press(button);
    const note = notesIn(greeter)[0]!;
    same(dom.focused(), note, "focus");
    expect(note.getAttribute("tabindex")).toBe("-1");
    // A note from 900 to 2000 in an 840-high pane: up until its top is 16 under the pane's top, never further.
    expect(at.scrollBy.mock.calls).toEqual([[{ top: 900 - 16, behavior: "smooth" }]]);
    await page.press(all(note).find(n => n.getAttribute("aria-label") === "Close the draft"));
    expect(notesIn(greeter)).toHaveLength(0);
    same(dom.focused(), button, "focus");
    expect(button.textContent).toBe(PREPARE_NOTE);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("a second press closes it; another person's button moves the one note to them", async () => {
    const page = await mount({ brief: live() });
    const greeter = card("Greeter still needs");
    const [a, b] = buttonsIn(greeter, PREPARE_NOTE);
    await page.press(a);
    await page.press(a);
    expect(notesIn(greeter)).toHaveLength(0);
    expect(a!.textContent).toBe(PREPARE_NOTE);
    await page.press(a);
    await page.press(b);
    const notes = notesIn(greeter);
    expect(notes).toHaveLength(1);
    const list = all(greeter).find(n => classes(n).includes("people"))!;
    const order = kids(list), rows = order.filter(n => classes(n).includes("person"));
    expect(order.indexOf(notes[0]!)).toBe(order.indexOf(rows[1]!) + 1);
    expect(notes[0]!.textContent).toContain(`To ${nameIn(rows[1]!)}`);
    same(dom.focused(), notes[0], "focus");
    expect([a!.textContent, b!.textContent]).toEqual([PREPARE_NOTE, "Close the note"]);
  });

  it("Hide people hides the note with them and keeps it: shown again, it is the same note, and the focus isn't moved again", async () => {
    const at = pane();
    const page = await mount({ brief: live(), pane: { current: at as unknown as HTMLElement } });
    const greeter = card("Greeter still needs");
    await page.press(buttonsIn(greeter, PREPARE_NOTE)[0]);
    const note = notesIn(greeter)[0]!;
    const list = all(greeter).find(n => classes(n).includes("people"))!;
    await page.press(buttonsIn(greeter, "Hide people")[0]);
    expect(list.hasAttribute("hidden")).toBe(true);
    expect(notesIn(greeter)).toHaveLength(1);
    same(notesIn(greeter)[0], note, "the note");
    await page.press(buttonsIn(greeter, "See who could help")[0]);
    expect(list.hasAttribute("hidden")).toBe(false);
    expect(notesIn(greeter)).toHaveLength(1);
    same(notesIn(greeter)[0], note, "the note");
    expect(at.scrollBy).toHaveBeenCalledTimes(1);
  });

  it("a mark you made shows once: on the row, then in their note under it, then on the card while the people are hidden", async () => {
    const b = live();
    const greeter = b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;
    const person = [...greeter.people!.suggestions, ...greeter.people!.conflicts][0]!.person_id;
    const LINE = "On Mon, Nov 16 you said you'd ask about Greeter.";
    const page = await mount({ brief: b, asked: { lines: [{ key: greeter.key, person_id: person, text: LINE, undo: () => undefined }], onMark: () => undefined } });
    const el = card("Greeter still needs");
    const times = () => visible(el).split(LINE).length - 1;
    expect(times()).toBe(1);
    const row = all(el).find(n => classes(n).includes("person") && nameIn(n) === names[person])!;
    await page.press(buttonsIn(row, PREPARE_NOTE)[0]);
    expect(times()).toBe(1);
    expect(visible(notesIn(el)[0]!)).toContain(LINE);
    await page.press(buttonsIn(el, "Hide people")[0]);
    expect(times()).toBe(1);
    expect(notesIn(el)).toHaveLength(1);
  });

  it("opened from Today's See who could help: the page moves to the card, and Prepare a note opens under the row there too", async () => {
    const b = live();
    const greeterKey = b.findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!.key;
    const page = await mount({ brief: b, focus: greeterKey, onFocused: () => undefined, pane: { current: pane() as unknown as HTMLElement } });
    const greeter = card("Greeter still needs");
    same(dom.focused(), all(greeter).find(n => n.tagName === "H3"), "focus");
    await page.press(buttonsIn(greeter, PREPARE_NOTE)[0]);
    const list = all(greeter).find(n => classes(n).includes("people"))!;
    const order = kids(list);
    expect(isNote(order[order.indexOf(order.filter(n => classes(n).includes("person"))[0]!) + 1])).toBe(true);
    same(dom.focused(), notesIn(greeter)[0], "focus");
  });
});

describe("a note to the team's leader, and a reminder, open right under the card's buttons", () => {
  /** Nursery, whose leader Planning Center lists, with one person to show whose availability isn't confirmed. */
  const withPeople = () => {
    const b = live();
    const findings = b.findings.map(f => f.kind === "needs-people" && f.position!.name === "Nursery"
      ? { ...f, people: { suggestions: [], conflicts: [], unverified: [{ person_id: PEOPLE.casey, reasons: ["Recorded availability couldn't be verified."] }], left_out: [] } } as Finding : f);
    return { ...b, findings };
  };

  it("the leader's note comes right after the buttons, before the people; the button says it's open; X gives the focus back", async () => {
    const page = await mount({ brief: withPeople() });
    const nursery = card("Nursery still needs");
    const button = buttonsIn(nursery, "Prepare a note to the team's leader")[0]!;
    expect(button.getAttribute("aria-expanded")).toBe("false");
    await page.press(button);
    const order = kids(nursery);
    const actions = order.findIndex(n => classes(n).includes("card-actions"));
    const note = order[actions + 1];
    expect(isNote(note)).toBe(true);
    expect(note!.getAttribute("aria-label")).toBe("Draft note to the team's leader");
    expect(order.indexOf(order.find(n => classes(n).includes("people"))!)).toBeGreaterThan(actions + 1);
    same(dom.focused(), note, "focus");
    expect(button.textContent).toBe("Close the note to the team's leader");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await page.press(all(note!).find(n => n.getAttribute("aria-label") === "Close the draft"));
    expect(notesIn(nursery)).toHaveLength(0);
    same(dom.focused(), button, "focus");
    // A second press of the button closes it too.
    await page.press(button);
    await page.press(button);
    expect(notesIn(nursery)).toHaveLength(0);
  });

  it("the lead question's note to the leader opens under its buttons", async () => {
    const page = await mount({ brief: live(nov22Capture(), { ...rules, sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery Lead" }] }) });
    const lead = card("No one is scheduled to lead");
    const button = buttonsIn(lead, "Prepare a note to the leader")[0]!;
    await page.press(button);
    const order = kids(lead);
    expect(isNote(order[order.findIndex(n => classes(n).includes("card-actions")) + 1])).toBe(true);
    same(dom.focused(), notesIn(lead)[0], "focus");
    expect(button.textContent).toBe("Close the note to the leader");
  });

  it("Prepare a reminder stays, says the reminder is open, and closes it; X gives the focus back", async () => {
    const page = await mount({ brief: live(sentRequest()) });
    const lyrics = card(`${names[PEOPLE.lyricsPending]} is pending for Lyrics`);
    const button = buttonsIn(lyrics, PREPARE_REMINDER)[0]!;
    await page.press(button);
    const order = kids(lyrics);
    const note = order[order.findIndex(n => classes(n).includes("card-actions")) + 1];
    expect(note!.getAttribute("aria-label")).toBe("Draft reminder");
    same(dom.focused(), note, "focus");
    expect(button.textContent).toBe("Close the reminder");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await page.press(all(note!).find(n => n.getAttribute("aria-label") === "Close the draft"));
    same(dom.focused(), button, "focus");
    expect(button.textContent).toBe(PREPARE_REMINDER);
    await page.press(button);
    await page.press(button);
    expect(notesIn(lyrics)).toHaveLength(0);
  });

  it("a reminder a Church rule prepared as the card opened doesn't take the focus or scroll; its button can close it", async () => {
    const entry: FeedbackEntry = { type: "always", id: "a", kind: "pending", at: "2026-11-20T15:10:00Z", action: "prepare-reminder", scope: { team_id: TEAMS.lyrics, position: "Lyrics" }, labels: {} };
    const capture = sentRequest();
    const before = dom.focused();
    const at = pane();
    await mount({ brief: buildSundayBrief(capture, { ...rules, feedback: [entry] }, capture.completed_at), feedback: { entries: [entry], onEntries: () => undefined },
      pane: { current: at as unknown as HTMLElement } });
    const lyrics = card(`${names[PEOPLE.lyricsPending]} is pending for Lyrics`);
    expect(notesIn(lyrics)).toHaveLength(1);
    same(dom.focused(), before, "focus");
    expect(at.scrollBy).not.toHaveBeenCalled();
    expect(buttonsIn(lyrics, "Close the reminder")).toHaveLength(1);
  });
});

describe("how far a note is brought into view", () => {
  const note = (top: number, bottom: number) => ({ getBoundingClientRect: () => box(top, bottom), focus: vi.fn() });
  const into = (n: ReturnType<typeof note>, still?: boolean) => {
    const p = pane();
    showNote(n as unknown as HTMLElement, p as unknown as HTMLElement, still);
    return p.scrollBy.mock.calls.map(c => c[0]);
  };
  it("only as far as its end, but never its top out of view; not at all when it's in view; up when it's above", () => {
    expect(into(note(700, 1100), false)).toEqual([{ top: 1100 - 840 + 16, behavior: "smooth" }]);
    expect(into(note(700, 2400), false)).toEqual([{ top: 700 - 16, behavior: "smooth" }]);
    expect(into(note(100, 500), false)).toEqual([]);
    expect(into(note(-200, 300), false)).toEqual([{ top: -216, behavior: "smooth" }]);
  });
  it("still when this Mac asks for reduced motion, and focused without a second scroll", () => {
    const n = note(700, 1100);
    expect(into(n, true)).toEqual([{ top: 276, behavior: "auto" }]);
    expect(n.focus).toHaveBeenCalledWith({ preventScroll: true });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q === "(prefers-reduced-motion: reduce)" }));
    expect(into(note(700, 1100))).toEqual([{ top: 276, behavior: "auto" }]);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    expect(into(note(700, 1100))).toEqual([{ top: 276, behavior: "smooth" }]);
  });
  it("with no pane, focusing it is the browser's own way into view", () => {
    const n = note(700, 1100);
    showNote(n as unknown as HTMLElement, null);
    expect(n.focus).toHaveBeenCalledWith();
  });
  it("a button's open words: Prepare becomes Close", () => {
    expect(["Prepare a note", "Prepare a note to the team's leader", "Prepare a note to the team's leader: Jordan Ashdown", "Prepare a reminder"].map(closeLabel))
      .toEqual(["Close the note", "Close the note to the team's leader", "Close the note to the team's leader: Jordan Ashdown", "Close the reminder"]);
  });
});

describe("a shorter note, with every promise still in view or one click away", () => {
  const greeter = live().findings.find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;
  const person = [...greeter.people!.suggestions, ...greeter.people!.conflicts][0]!.person_id;
  const html = renderToStaticMarkup(React.createElement(Draft, {
    finding: greeter, person, names, sender: "", sunday: null, canReword: false, onClose: () => undefined, people: { granted: true },
    mark: { line: null, onMark: () => undefined },
  }));
  /** The note as seen with the fold closed: everything but the fold's own words under its title. */
  const fold = /<details class="listen-more draft-how"><summary>(.*?)<\/summary>(.*?)<\/details>/u.exec(html);
  const shown = text(html.replace(/(<details[^>]*><summary>.*?<\/summary>).*?<\/details>/u, "$1</details>"));

  it("keeps in view: Draft only, To, the note, the buttons, who sends and what the address is for, Looks good and what it does, and the AI line", () => {
    for (const words of ["Draft only. Nothing has been sent.", `To ${names[person]}`, `Hi ${names[person]!.split(" ")[0]},`, "Copy draft", "Change the wording", "Open in Mail", "Open in Messages",
      HAND_OFF_TO_SHORT, LOOKS_GOOD, LOOKS_GOOD_HELP, DRAFT_FOOTER]) {
      expect(shown, words).toContain(words);
    }
    expect(HAND_OFF_TO_SHORT).toMatch(/send it yourself/u);
    expect(HAND_OFF_TO_SHORT).toMatch(/used only to fill in To/u);
  });

  it("puts how the two open buttons work in the app's own fold, closed, titled in plain words, with the long account word for word", () => {
    expect(fold).not.toBeNull();
    expect(fold![1]).toBe(`<svg class="ic ic-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"></path></svg>${HOW_OPEN}`);
    expect(text(fold![2]!)).toContain(handOffToNote(names[person]!));
    expect(html).not.toMatch(/<details[^>]*\sopen/u);
    expect(shown).not.toContain("never kept and never sent to AI");
    // The two open buttons are described by the line in view, never by words inside the closed fold.
    const note = /<p class="small draft-note" id="([^"]+)">([^<]+)<\/p>/u.exec(html)!;
    expect(note[2]!.replaceAll("&#x27;", "'")).toBe(HAND_OFF_TO_SHORT);
    expect(html.match(new RegExp(`aria-describedby="${note[1]!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}">Open in (?:Mail|Messages)<`, "gu"))).toHaveLength(2);
  });

  it("a note for no one in particular keeps its one line in view, with no fold", () => {
    const ask = renderToStaticMarkup(React.createElement(DraftCard, { text: "Hi Riley,\n\nCould you help?\n\nPat" }));
    expect(text(ask)).toContain(HAND_OFF_NOTE);
    expect(ask).not.toContain("<details");
  });
});
