// One polite announcer for the app, and the keyboard kept where the leader was (accessibility audit S3e–g, S3i, S4):
// Check now stays focusable while it checks and the check it started is said when it ends; a decision moves its card to
// Resolved by you and Undo moves it back, with the keyboard on the moved card's title and one sentence said; Never mind
// puts the keyboard on the card's title; "Looks good — I'll send it" is replaced by its mark, which takes the keyboard,
// and the mark's Undo gives it back to the button. Mounted on the fake document with focus kept; fixed fictional data.
import { readFileSync } from "node:fs";
import React, { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { Announcer, useAnnounce } from "../src/announce.js";
import { BACK_IN_LIST, choiceText, decidedLine, DraftBox, LOOKS_GOOD, MARKED, PageControls, SundayPage, UNMARKED, type AskedLine } from "../src/sunday-page.js";
import { SUNDAY_WORDS } from "../src/day-words.js";
import { buildSundayBrief, type SundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import type { SundayDecision } from "../../../core/src/sunday-decisions.js";

const dom = installFakeDom({ focus: true });
type El = NonNullable<ReturnType<typeof dom.button>>;
const isEl = (n: unknown): n is El => Boolean(n && (n as El).nodeType === 1);
const all = (n: El): El[] => [n, ...(n.childNodes as unknown[]).filter(isEl).flatMap(all)];
const props = (el: El) => (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[Object.keys(el).find(k => k.startsWith("__reactProps$"))!]!;
const status = () => all(dom.root).filter(n => n.tagName === "P" && n.getAttribute("role") === "status" && n.getAttribute("class") === "sr-only").map(n => n.textContent);
const focused = () => dom.focused() as unknown as El | null;
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const names = nov22Capture().names;
const live = (): SundayBrief => { const c = nov22Capture(); return buildSundayBrief(c, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, c.completed_at); };

async function mount(element: () => React.ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = dom.root.appendChild((dom.root.ownerDocument as unknown as { createElement(t: string): El }).createElement("div"));
  const root = createRoot(host as unknown as Element);
  await act(async () => { root.render(element()); });
  return {
    act, render: async (next: React.ReactElement) => { await act(async () => { root.render(next); }); await act(flush); },
    press: async (b: El | null | undefined) => {
      if (!b) throw new Error("no such button");
      (b as unknown as { focus(): void }).focus();
      await act(async () => { dom.press(b); }); await act(flush);
    },
    done: async () => { await act(async () => { root.unmount(); }); dom.root.removeChild(host); },
  };
}

describe("the app's one status line", () => {
  it("stays on the page, says what it is given, says the same sentence twice, and says nothing outside the app", async () => {
    let say: (t: string) => void = () => undefined;
    function Speaker() { say = useAnnounce(); return null; }
    const page = await mount(() => React.createElement(Announcer, null, React.createElement(Speaker)));
    expect(status()).toEqual([""]);
    await page.act(async () => { say("Card 1 checked."); });
    expect(status()).toEqual(["Card 1 checked."]);
    await page.act(async () => { say("Card 1 checked."); });
    expect(status()).toEqual(["Card 1 checked. "]);
    await page.done();
    // Without the app around it, a page says nothing and nothing breaks.
    const bare = await mount(() => React.createElement(Speaker));
    expect(() => say("x")).not.toThrow();
    expect(status()).toEqual([]);
    await bare.done();
  });

  it("is App's, outside the shell, and Today's own line moved into it", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    expect(app).toMatch(/<Announcer>\s*<div className=\{`shell /u);
    expect(app).toMatch(/<\/div>\s*<\/Announcer>/u);
    const today = readFileSync(new URL("../src/today-page.tsx", import.meta.url), "utf8");
    expect(today).toContain("const setAnnouncement = useAnnounce();");
    expect(today).not.toContain('role="status" aria-live="polite">{announcement}');
  });
});

describe("Check now", () => {
  it("keeps the keyboard while it checks, and the check it started is said when it ends", async () => {
    const brief = live();
    const onCheck = vi.fn();
    const controls = (busy: boolean) => React.createElement(Announcer, null, React.createElement(PageControls, {
      brief, busy, connected: true, configured: true, hasRecording: false, onCheck, onRecording: () => undefined, onExample: () => undefined,
      problem: "", summary: "2 things need a decision.",
    }));
    const page = await mount(() => controls(false));
    const check = () => all(dom.root).find(n => n.tagName === "BUTTON" && /Check/u.test(n.textContent ?? ""))!;
    await page.press(check());
    await page.render(controls(true));
    expect(check().getAttribute("aria-disabled")).toBe("true");
    expect(check().hasAttribute("disabled")).toBe(false);
    expect(focused() === check()).toBe(true);
    // Pressed again while it checks: nothing more starts.
    await page.press(check());
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(status()).toEqual([""]);
    await page.render(controls(false));
    expect(status()[0]).toMatch(/^Checked \w{3}, \w{3} \d{1,2}, \d{1,2}:\d{2}\s[AP]M\. 2 things need a decision\.$/u);
    await page.done();
  });
});

describe("a decision on a card, and its Undo", () => {
  function Held({ brief }: { brief: SundayBrief }) {
    const [decisions, setDecisions] = useState<SundayDecision[]>([]);
    return React.createElement(Announcer, null, React.createElement(SundayPage, {
      brief, names, busy: false, problem: "", sender: "Pat", connected: true, hasRecording: false, configured: true, canReword: false,
      decisions, onDecisions: setDecisions, operations: null, onCheck: () => undefined, onRecording: () => undefined, onExample: () => undefined,
    }));
  }
  const title = (words: string) => all(dom.root).find(n => n.tagName === "H3" && (n.textContent ?? "").includes(words)) ?? null;
  const button = (words: string) => all(dom.root).find(n => n.tagName === "BUTTON" && n.textContent === words) ?? null;

  it("Never mind puts the keyboard on the card's title; saving moves it to Resolved by you with the keyboard on it; Undo brings it back", async () => {
    const page = await mount(() => React.createElement(Held, { brief: live() }));
    const text = choiceText(SUNDAY_WORDS)["covered-outside"];
    // Never mind: the form goes, the keyboard is on the card's title.
    await page.press(button(text.button));
    await page.press(button("Never mind"));
    expect(focused()?.tagName).toBe("H3");
    expect(focused()?.textContent).toContain("Greeter still needs");
    // Saved: the card is under Resolved by you, its title has the keyboard, and the status line says where it went.
    await page.press(button(text.button));
    const input = all(dom.root).find(n => n.tagName === "INPUT" && n.getAttribute("class") === "input")!;
    await page.act(async () => { props(input).onChange!({ target: { value: "A parent from the class" } }); });
    const form = all(dom.root).find(n => n.tagName === "FORM" && n.getAttribute("class") === "decide")!;
    await page.act(async () => { props(form).onSubmit!({ preventDefault() {} }); });
    await page.act(flush);
    const done = title(text.done("Greeter"));
    expect(done).not.toBeNull();
    expect(focused() === done).toBe(true);
    expect(status()).toEqual([decidedLine(SUNDAY_WORDS)]);
    // Undo: back in the open list, the keyboard on its title again.
    await page.press(button("Undo — bring it back to the list"));
    expect(title(text.done("Greeter"))).toBeNull();
    expect(focused()?.textContent).toContain("Greeter still needs");
    expect(status()).toEqual([BACK_IN_LIST]);
    await page.done();
  });
});

describe("“Looks good — I'll send it” and its Undo", () => {
  it("the mark replaces the button and takes the keyboard; Undo gives the keyboard back to the button", async () => {
    const line: AskedLine = { key: "k", person_id: "1", text: "On Sun, Nov 22 you said you'd send this to Riley.", undo: () => undefined };
    let marked = false;
    const box = (on: boolean, rerender: () => void) => React.createElement(Announcer, null, React.createElement(DraftBox, {
      label: "Draft note", body: "Hi", onBody: () => undefined, onClose: () => undefined, footer: "Nothing is sent.",
      mark: { line: on ? { ...line, undo: () => { marked = false; rerender(); } } : null, onMark: () => { marked = true; rerender(); } },
    }));
    let again: () => void = () => undefined;
    const page = await mount(() => box(false, () => again()));
    again = () => { void page.render(box(marked, () => again())); };
    await page.press(all(dom.root).find(n => n.tagName === "BUTTON" && n.textContent === LOOKS_GOOD));
    await page.act(flush);
    const mark = all(dom.root).find(n => (n.getAttribute("class") ?? "").includes("asked-line"))!;
    expect(focused() === mark).toBe(true);
    expect(mark.getAttribute("tabindex") ?? mark.getAttribute("tabIndex")).toBe("-1");
    expect(status()).toEqual([MARKED]);
    await page.press(all(mark).find(n => n.tagName === "BUTTON" && n.textContent === "Undo"));
    await page.act(flush);
    const offer = all(dom.root).find(n => n.tagName === "BUTTON" && n.textContent === LOOKS_GOOD)!;
    expect(focused() === offer).toBe(true);
    expect(status()).toEqual([UNMARKED]);
    await page.done();
  });
});

describe("visitor cards: Looks right", () => {
  it("stays focusable once checked, and the check is said", () => {
    const src = readFileSync(new URL("../src/cards-page.tsx", import.meta.url), "utf8");
    expect(src).toContain('disabled={busy} aria-disabled={card.reviewed || undefined}');
    expect(src).toContain('if (!card.reviewed && checkCard(controller, ticket, card) === "ok") announce(`${card.label} checked.`);');
  });
});
