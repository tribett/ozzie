import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every draft surface's actions are recorded, so a test can check that Open in Mail and Open in Messages get exactly the
// words its Copy draft copies. Nothing here reaches the Mac: the native call is mocked.
const seen = vi.hoisted(() => [] as { text: string; copy: React.ReactElement<{ onClick: () => void }> }[]);
const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("../src/draft-actions.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/draft-actions.js")>();
  return {
    ...actual,
    DraftActions: (props: Parameters<typeof actual.DraftActions>[0]) => {
      seen.push(props as (typeof seen)[number]);
      return actual.DraftActions(props);
    },
  };
});

import {
  DraftActions, handOff, handOffText, HAND_OFF_NOTE, openDraftNatively, openLabel, type DraftApp, type HandOff,
} from "../src/draft-actions.js";
import { DraftBox, LeaderNote, ReminderNote } from "../src/sunday-page.js";
import { DraftCard } from "../src/ask-panel.js";
import { CopyDraft, NoticedCard } from "../src/responsibility-views.js";
import type { NoticedItem, RunnerView } from "../src/responsibility-runner.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { nov22Capture, PEOPLE } from "../../../core/src/fictional-sunday.js";
import { text } from "./harness-fakes.js";

const render = (element: React.ReactElement) => renderToStaticMarkup(element);
// Fictional people and words only.
const NOTE = "Hi Zoë & José,\n\nCould you help in the nursery at 9:30? #2 — thanks 🙏\n\nPat";

afterEach(() => { seen.length = 0; vi.unstubAllGlobals(); invoke.mockClear(); });

describe("opening a draft in Mail or Messages", () => {
  it("hands the native side the draft's words and which app, nothing else: no address, scheme or recipient", async () => {
    await openDraftNatively("mail", NOTE);
    await openDraftNatively("messages", NOTE);
    expect(invoke.mock.calls).toEqual([["open_draft", { app: "mail", body: NOTE }], ["open_draft", { app: "messages", body: NOTE }]]);
  });

  it("counts as opened only when the Mac says so, and says plainly when it couldn't", async () => {
    const calls: [DraftApp, string][] = [];
    const ok = async (app: DraftApp, body: string) => { calls.push([app, body]); return { app: "Mail" }; };
    expect(await handOff("mail", NOTE, ok)).toEqual({ app: "mail", result: "opened", text: NOTE, in: "Mail" });
    expect(calls).toEqual([["mail", NOTE]]);
    const failing = (code: unknown) => () => Promise.reject(code);
    expect((await handOff("messages", NOTE, failing("too-long"))).result).toBe("too-long");
    expect((await handOff("mail", NOTE, failing("not-opened"))).result).toBe("not-opened");
    for (const code of ["invalid-input", "unavailable", new Error("NATIVE_CALL_FORBIDDEN"), undefined]) {
      expect((await handOff("mail", NOTE, failing(code))).result).toBe("failed");
    }
  });

  it("names the app the draft really opened in: a Mac's email app may not be Apple Mail", async () => {
    const replying = (reply: unknown) => async () => reply;
    const opened = async (app: DraftApp, reply: unknown) => handOffText(await handOff(app, NOTE, replying(reply)));
    expect(await opened("mail", { app: "Zoho Mail - Desktop" })).toBe("Opened in Zoho Mail - Desktop — check it and send it yourself");
    expect(await opened("messages", { app: "Messages" })).toBe("Opened in Messages — check it and send it yourself");
    // A reply without a plain one-line name falls back to the usual name.
    for (const odd of [undefined, null, "Mail", { app: "" }, { app: 7 }, { app: "Mail\nSent" }, { app: "Mail‮li" }, { app: "a".repeat(65) }]) {
      expect(await opened("mail", odd), JSON.stringify(odd)).toBe("Opened in Mail — check it and send it yourself");
    }
  });

  it("says who sends: the person, after checking it", () => {
    const say = (app: DraftApp, result: HandOff["result"]) => handOffText({ app, result, text: NOTE });
    expect(say("mail", "opened")).toBe("Opened in Mail — check it and send it yourself");
    expect(say("messages", "opened")).toBe("Opened in Messages — check it and send it yourself");
    expect(say("messages", "too-long")).toBe("This draft is too long to open in Messages. Copy it instead.");
    expect(say("mail", "too-long")).toBe("This draft is too long to open in Mail. Copy it instead.");
    expect(say("mail", "not-opened")).toBe("Mail couldn't be opened on this Mac. Copy the draft instead.");
    expect(say("messages", "failed")).toBe("This draft couldn't be opened in Messages. Copy it instead.");
    expect([openLabel("mail"), openLabel("messages")]).toEqual(["Open in Mail", "Open in Messages"]);
    expect(HAND_OFF_NOTE).toBe("Opens a new message in this Mac's email app or Messages, with no one in To: you choose who it goes to, check it and send it yourself.");
    for (const words of [say("mail", "opened"), say("messages", "too-long"), say("mail", "not-opened"), say("mail", "failed"), HAND_OFF_NOTE]) {
      expect(words).not.toMatch(/\b(Ozzie (sends|sent)|sent for you|approve|block|agent|connector|harness|session|skill)\b/iu);
    }
  });

  it("puts the two buttons after Copy draft, each described by the note, with a polite status line that starts empty", () => {
    const html = render(React.createElement(DraftActions, { text: NOTE, copy: React.createElement("button", { type: "button", className: "btn btn-primary" }, "Copy draft") }));
    expect(text(html)).toMatch(/^ ?Copy draft Open in Mail Open in Messages Opens a new message in this Mac's email app or Messages, with no one in To/u);
    const note = /<p class="small draft-note" id="([^"]+)">/u.exec(html)?.[1];
    expect(note).toBeTruthy();
    const escaped = note!.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    expect(html.match(new RegExp(`<button type="button" class="btn btn-secondary" aria-describedby="${escaped}">Open in (Mail|Messages)</button>`, "gu"))).toHaveLength(2);
    expect(html).toContain('<p class="small draft-opened" role="status" aria-live="polite"></p>');
    expect(html).not.toContain('role="alert"');
    expect(html).not.toMatch(/>\s*Send\b|href=|mailto:|sms:/u);
    // Small where the copy button is small; the shared 44-point hit area comes from .btn-sm.
    expect(render(React.createElement(DraftActions, { text: NOTE, small: true, copy: null }))).toContain('class="btn btn-secondary btn-sm"');
  });

  it("says it opened, or why it didn't, only for the words it opened: a changed draft starts fresh", () => {
    const opened = (initial: HandOff, words = NOTE) => render(React.createElement(DraftActions, { text: words, copy: null, initial }));
    expect(opened({ app: "messages", result: "opened", text: NOTE })).toContain('role="status" aria-live="polite">Opened in Messages — check it and send it yourself</p>');
    const tooLong = opened({ app: "messages", result: "too-long", text: NOTE });
    expect(tooLong).toContain('<p role="alert" class="problem">This draft is too long to open in Messages. Copy it instead.</p>');
    expect(tooLong).toContain('aria-live="polite"></p>');
    const changed = opened({ app: "mail", result: "opened", text: NOTE }, `${NOTE} More.`);
    expect(changed).not.toContain("Opened in Mail");
    // Copy draft stays: it is the copy button the surface passes in, untouched.
    expect(render(React.createElement(DraftActions, { text: NOTE, copy: "COPY", initial: { app: "mail", result: "not-opened", text: NOTE } }))).toContain("COPY");
  });
});

/** Presses a surface's Copy draft and returns what reached the clipboard. */
async function copied(copy: React.ReactElement<{ onClick: () => void }>): Promise<string> {
  let clip = "";
  vi.stubGlobal("navigator", { clipboard: { writeText: async (t: string) => { clip = t; } } });
  copy.props.onClick();
  await new Promise(resolve => setTimeout(resolve, 0));
  return clip;
}

describe("every draft has Open in Mail and Open in Messages, with exactly the words Copy draft copies", () => {
  const brief = () => buildSundayBrief(nov22Capture(), { sundayLeads: [], checkInAfterSundaysInARow: 3 }, nov22Capture().completed_at, true);

  it("Sunday: the note to the team's leader, signed with your name", async () => {
    const nursery = brief().findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    const html = render(React.createElement(LeaderNote, { finding: nursery, leader: PEOPLE.nurseryLeader, names: nov22Capture().names, sender: "Pat", onClose: () => undefined }));
    expect(text(html)).toMatch(/Copy draft Change the wording Open in Mail Open in Messages Opens a new message in this Mac's email app/u);
    expect(seen).toHaveLength(1);
    const words = seen[0]!.text;
    expect(words).toContain("Hi Jordan,");
    expect(words).toMatch(/Thank you,\s+Pat$/u);
    expect(words).not.toMatch(/\[(?:Person|Role|Volunteer|Your name)[^\]]*\]/u);
    expect(await copied(seen[0]!.copy)).toBe(words);
  });

  it("Sunday: a reminder for a request with no answer yet", async () => {
    // As in core/test/reminder-draft.test.ts: the fictional request Planning Center shows as sent.
    const capture = nov22Capture();
    const members = capture.reads.find(r => r.collection === "team_members")!.body!.data as { id: string; attributes: Record<string, unknown> }[];
    members.find(m => m.id === "403")!.attributes.notification_sent_at = "2026-11-18T12:00:00Z";
    const pending = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true)
      .findings.find(f => f.kind === "pending" && f.notification === "sent");
    expect(pending).toBeTruthy();
    const html = render(React.createElement(ReminderNote, { finding: pending!, names: capture.names, sender: "Pat", onClose: () => undefined }));
    expect(text(html)).toContain("Copy draft Change the wording Open in Mail Open in Messages");
    expect(seen[0]!.text).toContain("It's completely fine to say no.");
    expect(seen[0]!.text).toMatch(/Pat$/u);
    expect(await copied(seen[0]!.copy)).toBe(seen[0]!.text);
  });

  it("Sunday: the shared draft frame (the note asking someone to help) keeps Copy draft first, beside Change the wording, and the two opens on their own row", async () => {
    const html = render(React.createElement(DraftBox, { label: "Draft note", to: "Riley", body: NOTE, onBody: () => undefined, onClose: () => undefined, footer: "Ozzie never sends messages." }));
    expect(text(html)).toMatch(/Copy draft Change the wording Open in Mail Open in Messages Opens a new message in this Mac's email app/u);
    expect(html).toMatch(/<div class="find-next"><button type="button" class="btn btn-primary">Copy draft<\/button><button type="button" class="btn btn-secondary">Change the wording<\/button><\/div>/u);
    expect(html).toMatch(/<div class="find-next draft-open"><button [^>]*>Open in Mail<\/button><button [^>]*>Open in Messages<\/button><\/div>/u);
    expect(seen[0]!.text).toBe(NOTE);
    expect(await copied(seen[0]!.copy)).toBe(NOTE);
  });

  it("Ask: a drafted note in an answer", async () => {
    const html = render(React.createElement(DraftCard, { text: NOTE }));
    expect(text(html)).toContain("Copy draft Open in Mail Open in Messages");
    // The Ask panel is narrow: Copy draft, then the two opens on a row of their own.
    expect(html).toMatch(/<div class="find-next draft-open"><button type="button" class="btn btn-secondary btn-sm" [^>]*>Open in Mail<\/button>/u);
    expect(seen[0]!.text).toBe(NOTE);
    expect(await copied(seen[0]!.copy)).toBe(NOTE);
  });

  it("Today: a note Ozzie prepared, after your name for notes goes in", async () => {
    const stored = new Map([["ozzie.your-name.v1", "Pat Example"]]);
    const item: NoticedItem = { id: "p", responsibility_id: "r", template: "keep-sunday-covered", at: "2026-11-20T15:00:00Z", kind: "found", decisions: 1, drafted: true, drafts: 1 };
    const view: RunnerView = { items: [], noticed: [item], prepared: {}, next: {}, running: null, paused_all: false } as unknown as RunnerView;
    vi.stubGlobal("localStorage", { getItem: (k: string) => stored.get(k) ?? null, setItem() {}, removeItem() {} });
    const html = render(React.createElement(NoticedCard, {
      item, view, names: {}, now: "2026-11-20T15:10:00Z", onOpen: () => {}, titleId: "t",
      written: { summary: null, draft: "Hi Riley,\n\nCould you help?\n\nThank you,\n[Your name]" },
    }));
    expect(text(html)).toContain("Copy draft Open in Mail Open in Messages");
    expect(seen[0]!.text).toBe("Hi Riley,\n\nCould you help?\n\nThank you,\nPat Example");
    // The two buttons are described by the card's title too, like Copy draft.
    expect(html).toMatch(/aria-describedby="[^"]+ t">Open in Mail/u);
    expect(await copied(seen[0]!.copy)).toBe(seen[0]!.text);
  });

  it("Today: Copy draft on its own (the card's actions) gives the same words to all three", async () => {
    render(React.createElement(CopyDraft, { text: NOTE }));
    expect(seen[0]!.text).toBe(NOTE);
    expect(await copied(seen[0]!.copy)).toBe(NOTE);
  });
});
