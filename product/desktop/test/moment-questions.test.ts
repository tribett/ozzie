// The questions asked at the moment they matter (onboarding spec §4.2), pressed as a person would: the name above a
// note's buttons, "Fill in who it's to?" before a note opens without People (explain, wait, welcome back), "Does
// {team} serve with kids?" and the phone line on Today. Mounted on the fake document (test/fake-dom.ts); the Mac and
// Planning Center are fakes. Fictional people only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { installFakeDom } from "./fake-dom.js";
import { text } from "./harness-fakes.js";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { DraftActions, type Addressee, type DraftApp } from "../src/draft-actions.js";
import { momentsStore, type KeyValue } from "../src/moments.js";
import { ALLOW_PEOPLE, PEOPLE_ENDS, PEOPLE_READS, PEOPLE_TITLE, PEOPLE_WAITING, peopleBody, peopleOutcome, WITHOUT_ADDRESS, type PeopleAccess } from "../src/people-question.js";
import { KIDS_BODY, KIDS_YES, KidsQuestion, kidsQuestionTitle, markKidsTeam } from "../src/kids-question.js";
import { PHONE_MOMENT, PhoneMoment } from "../src/phone-moment.js";
import { ALL_PROMISES, promise } from "../src/promises.js";
import { kidsTeams } from "../../../core/src/kids-rules.js";
import type { ConnectionStatus } from "../src/connection.js";

const dom = installFakeDom();
const NOTE = "Hi Riley,\n\nCould you help in the nursery at 9:30?\n\nThank you,\n[Your name]";
const RILEY: Addressee = { person: "511", name: "Riley Thornbury", peopleGranted: false };
const store = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  const kv: KeyValue = { getItem: k => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v); } };
  return { map, memory: momentsStore(() => kv) };
};
const status = (state: ConnectionStatus["state"], scopes?: ConnectionStatus["scopes"], extra: Partial<ConnectionStatus> = {}): ConnectionStatus =>
  ({ state, organization: "1234", checked_at_ms: null, source: "keychain", problem: null, ...(scopes ? { scopes } : {}), ...extra });

async function mount(element: () => React.ReactElement) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  // A fresh box for each mount, so one test can mount several times.
  const box = dom.root.appendChild((dom.root.ownerDocument as unknown as { createElement(t: string): typeof dom.root }).createElement("div"));
  const root = createRoot(box as unknown as Element);
  await act(async () => { root.render(element()); });
  const press = async (label: string) => {
    const b = dom.button(label);
    if (!b) throw new Error(`no button "${label}" in: ${dom.seen()}`);
    await act(async () => { dom.press(b); });
  };
  /** Lets the sheet's waiting loop run its fake polls. */
  const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise(r => setTimeout(r, 0)); }); };
  /** Calls a prop handler on the first element matching `match` (the fake document has no events of its own). */
  const fire = async (match: (el: { tagName?: string; attributes?: Map<string, string> }) => boolean, handler: string, event: unknown) => {
    const all = (n: { childNodes: unknown[] }): unknown[] => [n, ...n.childNodes.flatMap(c => all(c as { childNodes: unknown[] }))];
    const el = all(dom.root as unknown as { childNodes: unknown[] }).find(n => match(n as never)) as Record<string, unknown> | undefined;
    const key = el && Object.keys(el).find(k => k.startsWith("__reactProps$"));
    const fn = key ? (el[key] as Record<string, ((e: unknown) => void) | undefined>)[handler] : undefined;
    if (!fn) throw new Error(`no ${handler}`);
    await act(async () => { fn(event); });
  };
  return { press, settle, fire, rerender: (e: React.ReactElement) => act(async () => { root.render(e); }), unmount: async () => { await act(async () => { root.unmount(); }); dom.root.removeChild(box); } };
}

describe("Your name for the end of notes", () => {
  it("Use this name keeps it on this Mac, puts it in the note, and isn't asked again", async () => {
    const { memory } = store();
    let saved = "";
    let note = NOTE;
    const signed: string[] = [];
    const nameStore = { get: () => saved, set: (n: string) => { saved = n; } };
    const draw = () => React.createElement(DraftActions, { text: note, copy: null, nameStore, memory, onSign: (n: string) => { signed.push(n); note = note.replace("[Your name]", n); } });
    const m = await mount(draw);
    expect(dom.seen()).toContain("Your name for the end of notes");
    await m.fire(el => el.tagName === "INPUT", "onChange", { target: { value: "  Pat   Example " } });
    await m.fire(el => el.tagName === "FORM", "onSubmit", { preventDefault() {} });
    expect(saved).toBe("Pat Example");
    expect(signed).toEqual(["Pat Example"]);
    await m.rerender(draw());
    expect(dom.seen()).not.toContain("Your name for the end of notes");
    await m.unmount();
  });

  it("Leave [Your name] for now is remembered, so the next note doesn't ask", async () => {
    const { memory } = store();
    const nameStore = { get: () => "", set: vi.fn() };
    const m = await mount(() => React.createElement(DraftActions, { text: NOTE, copy: null, nameStore, memory, onSign: () => {} }));
    await m.press("Leave [Your name] for now");
    expect(memory.get().name).toBe("left");
    expect(nameStore.set).not.toHaveBeenCalled();
    expect(dom.seen()).not.toContain("Your name for the end of notes");
    await m.unmount();
    const again = await mount(() => React.createElement(DraftActions, { text: `${NOTE} `, copy: null, nameStore, memory, onSign: () => {} }));
    expect(dom.seen()).not.toContain("Your name for the end of notes");
    await again.unmount();
  });
});

describe("Fill in who it's to?", () => {
  /** A fake sign-in: `steps` are the statuses Planning Center's attempt goes through, one per look. */
  function fakeAccess(steps: ConnectionStatus[], start: () => Promise<unknown> = async () => status("waiting")) {
    const calls: string[] = [];
    let at = 0;
    const access: PeopleAccess = {
      start: async () => { calls.push("start"); return start(); },
      status: async () => { calls.push("status"); return steps[Math.min(at++, steps.length - 1)] ?? null; },
      cancel: async () => { calls.push("cancel"); },
    };
    return { access, calls };
  }
  function opens() {
    const calls: [string, DraftApp, string?][] = [];
    return {
      calls,
      open: async (app: DraftApp) => { calls.push(["open", app]); return { app: app === "mail" ? "Mail" : "Messages" }; },
      openTo: async (app: DraftApp, _body: string, person: string) => { calls.push(["openTo", app, person]); return { app: "Mail", result: "addressed" }; },
    };
  }
  const draft = (o: ReturnType<typeof opens>, access: PeopleAccess, memory = store().memory, to: Addressee = RILEY) =>
    () => React.createElement(DraftActions, { text: NOTE.replace("[Your name]", "Pat"), copy: null, to, open: o.open, openTo: o.openTo, memory, people: { access, pollMs: 0 } });

  it("comes before the note opens, with the spec's words and the build's promise", async () => {
    const o = opens();
    const { access } = fakeAccess([]);
    const m = await mount(draft(o, access));
    await m.press("Open in Mail");
    expect(o.calls).toEqual([]);
    expect(dom.seen()).toContain(PEOPLE_TITLE);
    expect(dom.seen()).toContain(peopleBody("Riley Thornbury"));
    // The bundle is Ozzie's own ask (oauth.rs Scopes::oauth), not Planning Center's (review H1).
    expect(peopleBody("Riley Thornbury")).toBe(`To put Riley Thornbury's email address or mobile number in To, Ozzie needs to read Planning Center People. Ozzie asks for People together with Calendar and Groups, and Planning Center words it as read-and-write. ${promise("connectAnd")}`);
    // What is then read, and when, is shown before anything is allowed (review H1, mutation M7).
    expect(dom.seen()).toContain(PEOPLE_READS);
    expect(PEOPLE_READS).toContain("Ozzie reads that person's email addresses or phone numbers, and whether Planning Center lists them as a child");
    // Native reads rooms, follow-ups and group events only behind Settings' switch, never because of this grant (2159c645).
    expect(PEOPLE_READS).toContain("Allowing it starts nothing else: room bookings, follow-ups and group meetings are read only if you turn them on in Settings.");
    expect(peopleBody("Riley Thornbury").endsWith(promise("connectAnd"))).toBe(true);
    await m.unmount();
  });

  it("Allow: waits with words and a Cancel, then opens the note addressed once Planning Center adds People", async () => {
    const o = opens();
    const { access, calls } = fakeAccess([status("waiting"), status("checking"), status("connected", "services-and-operations")]);
    const m = await mount(draft(o, access));
    await m.press("Open in Messages");
    await m.press(ALLOW_PEOPLE);
    expect(dom.seen()).toMatch(new RegExp(`${PEOPLE_WAITING}|Planning Center said yes`, "u"));
    expect(dom.button("Cancel")).not.toBeNull();
    expect(dom.button(WITHOUT_ADDRESS)).toBeNull();
    await m.settle();
    expect(calls[0]).toBe("start");
    expect(o.calls).toEqual([["openTo", "messages", "511"]]);
    expect(dom.seen()).not.toContain(PEOPLE_TITLE);
    expect(dom.seen()).toContain("Opened in Mail, addressed to Riley Thornbury.");
    // People is treated as granted on this card now: the next open goes straight through.
    await m.press("Open in Mail");
    expect(o.calls).toEqual([["openTo", "messages", "511"], ["openTo", "mail", "511"]]);
    await m.unmount();
  });

  it("Cancel stops the sign-in and says nothing changed; Escape never cancels a sign-in, but closes the sheet otherwise", async () => {
    const o = opens();
    const { access, calls } = fakeAccess([status("waiting")]);
    const m = await mount(draft(o, access));
    await m.press("Open in Mail");
    await m.press(ALLOW_PEOPLE);
    const sheet = (el: { attributes?: Map<string, string> }) => el.attributes?.get("role") === "dialog";
    await m.fire(sheet, "onKeyDown", { key: "Escape", stopPropagation() {} });
    expect(dom.seen()).toContain(PEOPLE_TITLE);
    await m.press("Cancel");
    expect(calls).toContain("cancel");
    expect(dom.seen()).toContain(PEOPLE_ENDS.cancelled);
    expect(o.calls).toEqual([]);
    await m.fire(sheet, "onKeyDown", { key: "Escape", stopPropagation() {} });
    expect(dom.seen()).not.toContain(PEOPLE_TITLE);
    expect(o.calls).toEqual([]);
    await m.unmount();
  });

  it("says how a sign-in ended when People wasn't added, and keeps both ways open", async () => {
    for (const [last, end] of [
      [status("cancelled", undefined, { problem: "denied" }), "denied"],
      [status("expired"), "expired"],
      [status("connected", "services"), "not-granted"],
      [status("connected", "services", { last_attempt: status("cancelled") }), "cancelled"],
      [status("failed", undefined, { problem: "store" }), "failed"],
    ] as const) {
      const o = opens();
      const { access } = fakeAccess([last]);
      const m = await mount(draft(o, access));
      await m.press("Open in Mail");
      await m.press(ALLOW_PEOPLE);
      await m.settle();
      expect(dom.seen(), end).toContain(PEOPLE_ENDS[end]);
      expect(dom.button(ALLOW_PEOPLE)).not.toBeNull();
      expect(dom.button(WITHOUT_ADDRESS)).not.toBeNull();
      expect(o.calls).toEqual([]);
      await m.unmount();
    }
    expect(peopleOutcome(status("waiting"))).toBeUndefined();
    expect(peopleOutcome(status("connected", "services-and-operations+check-ins"))).toBeNull();
  });

  it("a browser that won't open is said plainly", async () => {
    const o = opens();
    const { access } = fakeAccess([], async () => { throw { "connect": "browser-unavailable" }; });
    const m = await mount(draft(o, access));
    await m.press("Open in Mail");
    await m.press(ALLOW_PEOPLE);
    await m.settle(2);
    expect(dom.seen()).toContain(PEOPLE_ENDS.browser);
    await m.unmount();
  });

  it("Open it without an address: opens with To empty, is remembered, and is asked again only from the note's own link", async () => {
    const o = opens();
    const { access } = fakeAccess([status("connected", "services-and-operations")]);
    const { memory } = store();
    const m = await mount(draft(o, access, memory));
    await m.press("Open in Mail");
    await m.press(WITHOUT_ADDRESS);
    await m.settle(2);
    expect(memory.get().people).toBe("declined");
    expect(o.calls).toEqual([["open", "mail"]]);
    expect(dom.seen()).toContain("Ozzie's Planning Center sign-in doesn't include People, where email addresses and phone numbers are kept. The note opened in Mail with To empty.");
    // The next press opens straight away, without asking.
    await m.press("Open in Messages");
    await m.settle(2);
    expect(o.calls).toEqual([["open", "mail"], ["open", "messages"]]);
    expect(dom.seen()).not.toContain(PEOPLE_TITLE);
    // The note's own link asks again, for the app last used.
    await m.press("Fill in who it's to");
    expect(dom.seen()).toContain(PEOPLE_TITLE);
    await m.press(ALLOW_PEOPLE);
    await m.settle();
    expect(o.calls.at(-1)).toEqual(["openTo", "messages", "511"]);
    await m.unmount();
  });

  it("isn't asked when People is granted, for a note to no one in particular, or for an id that isn't a Planning Center id", async () => {
    for (const to of [{ ...RILEY, peopleGranted: true }, { ...RILEY, person: "Riley" }]) {
      const o = opens();
      const { access } = fakeAccess([]);
      const m = await mount(draft(o, access, store().memory, to));
      await m.press("Open in Mail");
      await m.settle(2);
      expect(dom.seen()).not.toContain(PEOPLE_TITLE);
      expect(o.calls).toHaveLength(1);
      await m.unmount();
    }
    const html = renderToStaticMarkup(React.createElement(DraftActions, { text: NOTE, copy: null }));
    expect(html).not.toContain(PEOPLE_TITLE);
  });

  it("never carries a promise sentence of its own", () => {
    const own = [PEOPLE_TITLE, ALLOW_PEOPLE, WITHOUT_ADDRESS, PEOPLE_WAITING, ...Object.values(PEOPLE_ENDS), peopleBody("x").replace(promise("connectAnd"), "")];
    for (const line of own) for (const p of ALL_PROMISES) expect(line).not.toContain(p);
  });
});

describe("Does {team} serve with kids?", () => {
  it("is a Worth a look card with the spec's words, Yes first", () => {
    const html = renderToStaticMarkup(React.createElement(KidsQuestion, { teamId: "202", teamName: "Nursery", onYes: () => {} }));
    expect(text(html)).toBe(` Worth a look ${kidsQuestionTitle("Nursery")} ${KIDS_BODY} ${KIDS_YES} No `.replace(/\s+/gu, " "));
    expect(kidsQuestionTitle("Nursery")).toBe("Does Nursery serve with kids?");
    expect(html.match(/btn-primary/gu)).toHaveLength(1);
    expect(html).toContain("badge b-look");
  });

  it("Yes marks the team with the default count; No is remembered by id only", async () => {
    const { map, memory } = store();
    const yes: string[] = [];
    let noes = 0;
    const m = await mount(() => React.createElement(KidsQuestion, { teamId: "202", teamName: "Nursery", onYes: id => yes.push(id), onNo: () => { noes++; }, memory }));
    await m.press(KIDS_YES);
    expect(yes).toEqual(["202"]);
    expect(kidsTeams(markKidsTeam({ sundayLeads: [], checkInAfterSundaysInARow: 3 }, "202", "Nursery"))).toEqual([{ team_id: "202", min_confirmed: 2, name: "Nursery" }]);
    await m.press("No");
    expect(noes).toBe(1);
    expect(memory.get().kids).toEqual({ "202": "no" });
    expect([...map.values()].join("")).not.toContain("Nursery");
    await m.unmount();
  });
});

describe("the phone line on Today", () => {
  it("says the one line with its two answers; either answer is kept and it goes", async () => {
    for (const [label, answer] of [["Set up my phone", "set-up"], ["No thanks", "no"]] as const) {
      const { memory } = store();
      let setUp = 0;
      const m = await mount(() => React.createElement(PhoneMoment, { onSetUp: () => { setUp++; }, memory }));
      expect(dom.seen()).toContain(PHONE_MOMENT);
      await m.press(label);
      expect(memory.get().phone).toBe(answer);
      expect(setUp).toBe(answer === "set-up" ? 1 : 0);
      expect(dom.seen().trim()).toBe("");
      await m.unmount();
    }
    const answered = store({ "ozzie.moments.v1": JSON.stringify({ phone: "no" }) });
    expect(renderToStaticMarkup(React.createElement(PhoneMoment, { onSetUp: () => {}, memory: answered.memory }))).toBe("");
  });
});
