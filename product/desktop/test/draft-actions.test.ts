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
  ADD_PEOPLE, addressedText, DraftActions, handOff, handOffText, handOffTo, handOffToNote, HAND_OFF_NOTE, NO_RECIPIENT, openDraftNatively, openDraftToNatively, openLabel,
  type Addressee, type DraftApp, type HandOff,
} from "../src/draft-actions.js";
import { addresseeFor, DraftBox, LeaderNote, ReminderNote } from "../src/sunday-page.js";
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
    // A reply without a plain one-line name says what kind of app it was, never "Mail" unless the reply says so: this
    // Mac's email app may be another one (review F, L-8).
    for (const odd of [undefined, null, "Mail", { app: "" }, { app: "   " }, { app: 7 }, { app: "Mail\nSent" }, { app: "Mail‮li" }, { app: "a".repeat(65) }]) {
      expect(await opened("mail", odd), JSON.stringify(odd)).toBe("Opened in your email app — check it and send it yourself");
      expect(await opened("messages", odd), JSON.stringify(odd)).toBe("Opened in your messages app — check it and send it yourself");
    }
    expect(await opened("mail", { app: "Mail" })).toBe("Opened in Mail — check it and send it yourself");
    // Native's own neutral names (16faddd2), when it can't read the app's name, are said as given.
    expect(await opened("mail", { app: "your email app" })).toBe("Opened in your email app — check it and send it yourself");
    expect(await opened("messages", { app: "your messages app" })).toBe("Opened in your messages app — check it and send it yourself");
    expect(await opened("mail", { app: "Spike Email - Mail & Team Chat" })).toBe("Opened in Spike Email - Mail & Team Chat — check it and send it yourself");
  });

  it("says who sends: the person, after checking it", () => {
    const say = (app: DraftApp, result: HandOff["result"]) => handOffText({ app, result, text: NOTE });
    expect(say("mail", "opened")).toBe("Opened in your email app — check it and send it yourself");
    expect(say("messages", "opened")).toBe("Opened in your messages app — check it and send it yourself");
    expect(say("messages", "too-long")).toBe("This draft is too long to open in your messages app. Copy it instead.");
    expect(say("mail", "too-long")).toBe("This draft is too long to open in your email app. Copy it instead.");
    expect(say("mail", "not-opened")).toBe("Your email app couldn't be opened on this Mac. Copy the draft instead.");
    expect(say("mail", "failed")).toBe("This draft couldn't be opened in your email app. Copy it instead.");
    expect(say("messages", "failed")).toBe("This draft couldn't be opened in your messages app. Copy it instead.");
    expect(say("messages", "not-opened")).toBe("Your messages app couldn't be opened on this Mac. Copy the draft instead.");
    // "Mail" or "Messages" is said only when the Mac's reply names that app.
    for (const app of ["mail", "messages"] as const) for (const result of ["opened", "too-long", "not-opened", "failed"] as const) {
      expect(say(app, result)).not.toMatch(/\b(?:Mail|Messages)\b/u);
    }
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
    expect(opened({ app: "messages", result: "opened", text: NOTE })).toContain('role="status" aria-live="polite">Opened in your messages app — check it and send it yourself</p>');
    const tooLong = opened({ app: "messages", result: "too-long", text: NOTE });
    expect(tooLong).toContain('<p role="alert" class="problem">This draft is too long to open in your messages app. Copy it instead.</p>');
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

describe("a note for one person opens addressed when Planning Center has one detail for them (audit item 19)", () => {
  const RILEY = "511";
  const to: Addressee = { person: RILEY, name: "Riley Thornbury", peopleGranted: true };
  const said = (h: HandOff, who: Addressee = to) => addressedText(h, who);

  it("hands native the app, the words and the person's Planning Center id, nothing else", async () => {
    await openDraftToNatively("mail", NOTE, RILEY);
    await openDraftToNatively("messages", NOTE, RILEY);
    expect(invoke.mock.calls).toEqual([["open_draft_to", { app: "mail", body: NOTE, person: RILEY }], ["open_draft_to", { app: "messages", body: NOTE, person: RILEY }]]);
  });

  it("sends only a Planning Center id: anything else opens the note with To empty, through open_draft", async () => {
    for (const odd of ["", "0511", "51a", "Riley Thornbury", "riley@example.org", "555-0142", " 511", "1".repeat(33)]) {
      const calls: string[] = [];
      const h = await handOffTo("mail", NOTE, odd, async () => { calls.push("to"); return { app: "Mail", result: "addressed" }; }, async () => { calls.push("plain"); return { app: "Mail" }; });
      expect(calls, odd).toEqual(["plain"]);
      expect(h.result).toBe("opened");
    }
  });

  it("keeps only the closed codes and the app's name from a reply, never anything else in it", async () => {
    const reply = (r: unknown) => async () => r;
    expect(await handOffTo("mail", NOTE, RILEY, reply({ app: "Mail", result: "addressed", address: "riley@example.org" })))
      .toEqual({ app: "mail", result: "addressed", text: NOTE, in: "Mail" });
    for (const reason of NO_RECIPIENT) {
      expect(await handOffTo("messages", NOTE, RILEY, reply({ app: "Messages", result: "opened-without-recipient", reason, number: "+15550142" })))
        .toEqual({ app: "messages", result: "unaddressed", reason, text: NOTE, in: "Messages" });
    }
    // A reply the page doesn't know (a reason native adds later, anything odd): opened, never said to be addressed, and
    // said as could-not-read, never as an error.
    for (const odd of [{ app: "Mail", result: "sent" }, { app: "Mail", result: "opened-without-recipient", reason: "riley@example.org" },
      { app: "Mail", result: "opened-without-recipient", reason: "a-new-reason" }, null, "addressed", { result: ["addressed"] }]) {
      const h = await handOffTo("mail", NOTE, RILEY, reply(odd));
      expect(h.result, JSON.stringify(odd)).toBe("unaddressed");
      expect(h.reason).toBe("could-not-read");
      expect(JSON.stringify(h)).not.toMatch(/example\.org|555|sent|a-new-reason/u);
      // The app is named only as the reply names it; otherwise by kind.
      const app = odd && typeof odd === "object" && "app" in odd ? "Mail" : "your email app";
      expect(said(h)).toBe(`Ozzie couldn't read Riley Thornbury's email address from Planning Center just now. The note opened in ${app} with To empty.`);
    }
  });

  it("says plainly when nothing opened, as open_draft does", async () => {
    const failing = (code: unknown) => () => Promise.reject(code);
    expect((await handOffTo("mail", NOTE, RILEY, failing("too-long"))).result).toBe("too-long");
    expect((await handOffTo("mail", NOTE, RILEY, failing("not-opened"))).result).toBe("not-opened");
    for (const code of ["invalid-input", "unavailable", undefined]) expect((await handOffTo("mail", NOTE, RILEY, failing(code))).result).toBe("failed");
  });

  it("says what happened in the page's own words, with the name it already shows", () => {
    const h = (app: DraftApp, result: "addressed" | "unaddressed", reason: HandOff["reason"] = null): HandOff => ({ app, result, reason, text: NOTE, in: app === "mail" ? "Mail" : "Messages" });
    expect(said(h("mail", "addressed"))).toBe("Opened in Mail, addressed to Riley Thornbury. Check it and send it yourself.");
    expect(said(h("mail", "unaddressed", "none-on-file"))).toBe("Planning Center has no email address for Riley Thornbury that can be used. The note opened in Mail with To empty.");
    expect(said(h("messages", "unaddressed", "none-on-file"))).toBe("Planning Center has no mobile number for Riley Thornbury. The note opened in Messages with To empty.");
    expect(said(h("mail", "unaddressed", "not-allowed"), { ...to, peopleGranted: false }))
      .toBe("Ozzie's Planning Center sign-in doesn't include People, where email addresses and phone numbers are kept. The note opened in Mail with To empty.");
    // Native's not-allowed is Planning Center refusing the read or this Mac's Keychain refusing the sign-in (contact.rs).
    expect(said(h("mail", "unaddressed", "not-allowed"))).toBe("Ozzie wasn't allowed to read Riley Thornbury's email address just now: Planning Center or this Mac's Keychain refused. The note opened in Mail with To empty.");
    expect(said(h("messages", "unaddressed", "not-allowed"))).toBe("Ozzie wasn't allowed to read Riley Thornbury's mobile number just now: Planning Center or this Mac's Keychain refused. The note opened in Messages with To empty.");
    expect(said(h("mail", "unaddressed", "could-not-read"))).toBe("Ozzie couldn't read Riley Thornbury's email address from Planning Center just now. The note opened in Mail with To empty.");
    // Also when two are marked primary (contact.rs choose).
    expect(said(h("messages", "unaddressed", "more-than-one"))).toBe("Planning Center has more than one mobile number for Riley Thornbury and doesn't mark exactly one as primary. The note opened in Messages with To empty, for you to choose.");
    expect(said(h("mail", "unaddressed", "more-than-one"))).toBe("Planning Center has more than one email address for Riley Thornbury and doesn't mark exactly one as primary. The note opened in Mail with To empty, for you to choose.");
    expect(said(h("mail", "unaddressed", "child"))).toBe("Planning Center lists Riley Thornbury as a child, so To is left empty. The note opened in Mail.");
    // Native accepts anyone a check of the church in use showed since Ozzie opened (contact.rs NotInThisCheck).
    // Native: someone a check since Ozzie opened linked through the plan's people, team positions or chosen forms; a team
    // leader named only as leader isn't, so the sentence says which people count.
    // Of the church in use only (review G); a team's leader the check names counts too (native, after review G L-e).
    expect(said(h("mail", "unaddressed", "not-in-this-check"))).toBe("Ozzie fills in To only for people a Sunday check of the church Ozzie is using has shown since Ozzie opened. The note opened in Mail with To empty.");
    // A Sunday check or setup's plan picker was reading (contact.rs BusyWithACheck): not always a check.
    expect(said(h("mail", "unaddressed", "busy-with-a-check"))).toBe("Ozzie was reading Planning Center just then, so To was left empty. The note opened in Mail.");
    expect(said(h("messages", "unaddressed", "busy-with-another-note"))).toBe("Ozzie was still filling in To for another note, so To was left empty. The note opened in Messages.");
    // Native counts reads that went out, of either kind, not notes filled (contact.rs READS_PER_MINUTE).
    // The count is of reads (contact.rs READS_PER_MINUTE = 10), filled in or not.
    // Native counts tries, some of which never reached Planning Center (review K, L8).
    expect(said(h("mail", "unaddressed", "too-many-just-now"))).toBe("Ozzie has already tried to read an email address or mobile number from Planning Center 10 times in the last minute, so To was left empty. The note opened in Mail.");
    // A note whose app's name couldn't be read says what kind of app it was.
    expect(said({ app: "mail", result: "addressed", reason: null, text: NOTE })).toBe("Opened in your email app, addressed to Riley Thornbury. Check it and send it yourself.");
    expect(said({ app: "mail", result: "unaddressed", reason: "child", text: NOTE })).toBe("Planning Center lists Riley Thornbury as a child, so To is left empty. The note opened in your email app.");
    // Every closed reason has its own sentence, never the could-not-read one (except could-not-read itself).
    const fallback = said(h("mail", "unaddressed", "could-not-read"));
    for (const r of NO_RECIPIENT.filter(r => r !== "could-not-read")) expect(said(h("mail", "unaddressed", r)), r).not.toBe(fallback);
    // When To is filled, as native fills it (contact.rs `choose`): the only usable one, or the one marked primary (review P, L8).
    // Opened by whichever app this Mac uses for email (review G).
    expect(handOffToNote("Riley Thornbury")).toBe("Opens a new message in this Mac's email app or Messages addressed to Riley Thornbury when Planning Center has one usable email address or mobile number for them, or marks one as primary. What's read is used only to fill in To: never kept and never sent to AI. Check it and send it yourself.");
    for (const r of NO_RECIPIENT) for (const app of ["mail", "messages"] as const) {
      expect(said(h(app, "unaddressed", r))).not.toMatch(/\b(Ozzie (sends|sent)|sent for you|approve|block|agent|connector|harness|session|skill)\b/iu);
    }
  });

  it("shows the result as a calm status, and offers adding People only when the sign-in lacks it, on the leader's click", () => {
    const shown = (initial: HandOff, who: Addressee = to) => render(React.createElement(DraftActions, { text: NOTE, copy: null, to: who, initial }));
    const addressed = shown({ app: "mail", result: "addressed", text: NOTE, in: "Mail" });
    expect(addressed).toContain('role="status" aria-live="polite">Opened in Mail, addressed to Riley Thornbury. Check it and send it yourself.</p>');
    expect(addressed).not.toContain('role="alert"');
    expect(text(addressed)).toContain(handOffToNote("Riley Thornbury"));
    expect(text(addressed)).not.toContain(HAND_OFF_NOTE);
    let added = 0;
    const missing = shown({ app: "mail", result: "unaddressed", reason: "not-allowed", text: NOTE, in: "Mail" }, { ...to, peopleGranted: false, onAddPeople: () => { added++; } });
    expect(missing).toContain(`>${ADD_PEOPLE}</button>`);
    expect(added).toBe(0);
    expect(shown({ app: "mail", result: "unaddressed", reason: "not-allowed", text: NOTE, in: "Mail" }, { ...to, onAddPeople: () => {} })).not.toContain(ADD_PEOPLE);
    expect(shown({ app: "mail", result: "unaddressed", reason: "child", text: NOTE, in: "Mail" })).not.toContain(ADD_PEOPLE);
    // A changed draft starts fresh, as before.
    expect(render(React.createElement(DraftActions, { text: `${NOTE}!`, copy: null, to, initial: { app: "mail", result: "addressed", text: NOTE, in: "Mail" } }))).toContain('aria-live="polite"></p>');
  });

  it("is addressed only by the id the finding holds: the person a note asks, the team's leader, or who a reminder is for; never in the example", () => {
    const capture = nov22Capture();
    const people = { granted: true };
    expect(addresseeFor(PEOPLE.nurseryLeader, capture.names, people)).toEqual({ person: PEOPLE.nurseryLeader, name: capture.names[PEOPLE.nurseryLeader], peopleGranted: true, onAddPeople: undefined });
    expect(addresseeFor("999", capture.names, people)?.name).toBe("this person");
    expect(addresseeFor(undefined, capture.names, people)).toBeNull();
    expect(addresseeFor("Riley", capture.names, people)).toBeNull();
    // No People access known (the fictional example, or a page that passes none): no addressee, To stays empty.
    expect(addresseeFor(PEOPLE.nurseryLeader, capture.names, null)).toBeNull();
    const nursery = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true).findings.find(f => f.kind === "needs-people" && f.position!.name === "Nursery")!;
    render(React.createElement(LeaderNote, { finding: nursery, leader: PEOPLE.nurseryLeader, names: capture.names, sender: "Pat", onClose: () => undefined, people }));
    expect((seen.at(-1) as unknown as { to: Addressee | null }).to?.person).toBe(PEOPLE.nurseryLeader);
    render(React.createElement(LeaderNote, { finding: nursery, leader: PEOPLE.nurseryLeader, names: capture.names, sender: "Pat", onClose: () => undefined }));
    expect((seen.at(-1) as unknown as { to: Addressee | null }).to).toBeNull();
  });
});

describe("what happened to a note stays on its card (audit item 19, review Y)", () => {
  it("a reason such as child is said only on the note card: no other module names it, and the card's actions call only the two open commands", async () => {
    const { ALL, code, NATIVE_COMMANDS, names: namesCommand, reach } = await import("../../../core/test/stays-on-this-mac-imports.js");
    // "child" as a reason is said in one place: the page's own words for it.
    const naming = ALL.filter(p => /["'`]child["'`]/u.test(code(p)) && p.startsWith("product/desktop/src/"));
    expect(naming).toEqual(["product/desktop/src/draft-actions.tsx"]);
    const own = code("product/desktop/src/draft-actions.tsx");
    expect(NATIVE_COMMANDS.filter(c => namesCommand(own, c)).sort()).toEqual(["open_draft", "open_draft_to"]);
    // Nothing it reaches records, notifies, shares or asks a model.
    const reached = [...reach("product/desktop/src/draft-actions.tsx")];
    for (const p of ["product/desktop/src/harness-bridge.ts", "product/desktop/src/share-check.ts", "product/desktop/src/siri-shortcuts.ts", "product/desktop/src/phone-notice.ts",
      "product/desktop/src/proactive.ts", "product/desktop/src/background.ts", "product/desktop/src/model.ts"]) expect(reached, p).not.toContain(p);
    expect(own).not.toMatch(/localStorage|sessionStorage|console\./u);
  });

  it("a note for one person opens with that person's id only: the To line and the address come from the same id", async () => {
    const { Draft } = await import("../src/sunday-page.js");
    const capture = nov22Capture();
    const greeter = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true).findings
      .find(f => f.kind === "needs-people" && f.position!.name === "Greeter")!;
    const people = [...greeter.people!.suggestions, ...greeter.people!.conflicts].map(p => p.person_id);
    expect(people.length).toBeGreaterThanOrEqual(2);
    for (const person of people) {
      seen.length = 0;
      const html = render(React.createElement(Draft, { finding: greeter, person, names: capture.names, sender: "Pat", sunday: null, canReword: false, onClose: () => {}, people: { granted: true } }));
      const to = (seen.at(-1) as unknown as { to: Addressee | null }).to!;
      expect(to.person).toBe(person);
      expect(to.name).toBe(capture.names[person]);
      expect(text(html)).toContain(`To ${capture.names[person]}`);
      for (const other of people.filter(p => p !== person)) expect(to.person).not.toBe(other);
    }
  });

  it("a note to a team's leader opens with that leader's own id (review G, L-e)", async () => {
    const { LeaderNote } = await import("../src/sunday-page.js");
    const capture = nov22Capture();
    const withLeader = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true).findings
      .find(f => (f.leaders?.length ?? 0) > 0)!;
    expect(withLeader).toBeDefined();
    for (const leader of withLeader.leaders!) {
      seen.length = 0;
      render(React.createElement(LeaderNote, { finding: withLeader, leader, names: capture.names, sender: "Pat", onClose: () => {}, people: { granted: true } }));
      const to = (seen.at(-1) as unknown as { to: Addressee | null }).to!;
      expect(to.person).toBe(leader);
      expect(to.name).toBe(capture.names[leader]);
    }
  });
});
