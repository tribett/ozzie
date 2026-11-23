// Round 5: Ask and the pages for a church that uses only Genesis, answered on this Mac from what was read.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { GenesisPage, genesisAnswer, genesisExample, genesisQuestions, GenesisToday, GenesisWatch, keptCounts } from "../src/genesis-church.js";
import { progressEmptyText } from "../src/today-groups.js";

const { capture, view } = genesisExample();
const text = (html: string) => html.replace(/<[^>]+>/gu, " ").replace(/&#x27;/gu, "'").replace(/\s+/gu, " ");
const body = (q: string) => { const t = genesisAnswer(q, capture, view, true); if (t.state !== "answered") throw new Error(t.state); return t.answer.body; };

describe("Ask for a church on Genesis", () => {
  it("answers from what was read, on this Mac, never about who is serving", () => {
    expect(body("What events are coming up?").split("\n")[0]).toMatch(/^Sunday Service, Sun, Nov 22, 9:00 AM\.$/u);
    expect(body("How many times was each form filled in?")).toContain("Prayer Card: filled in 7 times.");
    expect(body("How many came to Midweek Prayer?")).toContain("Midweek Prayer, Thu, Nov 19, 6:30 PM: 34 attended.");
    // As Genesis shares groups: names, never a member count.
    expect(body("What groups do we have?")).toBe("Tuesday Group\nYouth\nPrayer Team\n\nGenesis doesn't share how many people are in each group.");
    for (const q of ["Is Sunday covered?", "Who is serving this week?", "Who declined?"]) {
      expect(body(q), q).toContain("Genesis doesn't share volunteer schedules, so Ozzie can't check whether a service is covered.");
    }
    const t = genesisAnswer("Anything new?", capture, view, true);
    if (t.state !== "answered") throw new Error(t.state);
    expect(t.answer.local).toBe(true);
    expect(t.answer.basedOn).toMatch(/^Based on: fictional example data/u);
    expect(body("Anything new?")).toBe("Prayer Card was filled in 2 more times since the last check (7 in all).\n\nFrom Genesis: 3 events in the next four weeks, 2 forms, 3 groups.");
    // Nothing read yet: says so plainly.
    const none = genesisAnswer("What events are coming up?", null, null);
    if (none.state !== "answered") throw new Error(none.state);
    expect(none.answer.body).toMatch(/^Ozzie hasn't read Genesis yet/u);
  });
});

describe("Ask on Genesis, from the review of e9cbd97d (M2)", () => {
  it("matches whole words, the church's own names first, and refuses only questions about who serves or coverage", () => {
    const cases: [string, string][] = [
      ["How many times was the Serve Sign-up filled in?", "Serve Sign-up: filled in 3 times."],
      ["What's happening this whole week?", "Sunday Service, Sun, Nov 22, 9:00 AM."],
      ["Which forms need a look?", "Prayer Card: filled in 7 times.\nServe Sign-up: filled in 3 times."],
      ["How many people are in the Youth group?", "Youth\n\nGenesis doesn't share how many people are in each group."],
      ["What events come up next?", "Sunday Service, Sun, Nov 22, 9:00 AM."],
      ["What changed?", "Prayer Card was filled in 2 more times since the last check (7 in all)."],
    ];
    for (const [q, starts] of cases) expect(body(q), q).toMatch(new RegExp(`^${starts.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"));
    // Who came: the count, and plainly no names; an event still to come has no count and says so.
    const came = body("Who came to Midweek Prayer?");
    expect(came).toContain("Midweek Prayer, Thu, Nov 19, 6:30 PM: 34 attended.");
    expect(came).toContain("Midweek Prayer, Thu, Nov 26, 6:30 PM. It hasn't happened yet.");
    expect(came).toContain("Genesis gives counts, not names: Ozzie reads no one's name from Genesis.");
    expect(came).not.toContain("0 attended");
    for (const q of ["Who is serving on Sunday?", "Is the service covered?", "Who declined?", "How many volunteers do we have?"]) {
      expect(body(q), q).toMatch(/^Genesis doesn't share volunteer schedules/u);
    }
    expect(body("Who signed up?")).toMatch(/^(?:Prayer Card|Genesis gives counts, not names)/u);
    // Review of 4c3d32ac, lows: a name with "serve" in it isn't about serving; "anyone serving" is; a service's time is
    // an event; who filled in a form gets the count and no names.
    expect(body("Who filled in the Serve Sign-up?")).toBe("Serve Sign-up: filled in 3 times.\n\nGenesis gives counts, not names: Ozzie reads no one's name from Genesis.");
    expect(body("Is anyone serving this Sunday?")).toMatch(/^Genesis doesn't share volunteer schedules/u);
    expect(body("What time is the service on Sunday?")).toMatch(/^Sunday Service, Sun, Nov 22, 9:00 AM\./u);
  });

  it("offers only questions it answers from what was read", () => {
    const chips = genesisQuestions(view);
    expect(chips).toEqual(["What events are coming up?", "How many times was each form filled in?", "How many came to the events just past?", "What groups do we have?", "What changed since the last check?"]);
    for (const q of chips) expect(body(q), q).not.toMatch(/^From Genesis: .*\n\nWith Genesis, Ozzie can tell you/su);
    expect(genesisQuestions(null)).toEqual([]);
  });
});

describe("the pages for a church on Genesis", () => {
  it("say what Genesis shares and never a covered service; a form filled in again is worth a look", () => {
    const page = text(renderToStaticMarkup(React.createElement(GenesisPage, { capture, view, busy: false, problem: "", onCheck: () => {}, fictional: true })));
    expect(page).toContain("What Genesis shares");
    expect(page).toContain("3 events in the next four weeks, 2 forms, 3 groups.");
    expect(page).toContain("Genesis doesn't share volunteer schedules");
    expect(page).toContain("Prayer Card was filled in 2 more times since the last check (7 in all).");
    expect(page).toContain("Midweek Prayer, Thu, Nov 19, 6:30 PM: 34 attended.");
    expect(page).not.toMatch(/needs a decision|Everything Ozzie checked|(?<!whether a service is )covered\./u);
    const today = text(renderToStaticMarkup(React.createElement(GenesisToday, { capture, view, onOpen: () => {} })));
    expect(today).toContain("A form was filled in again.");
    expect(today).toContain("From Genesis: 3 events in the next four weeks, 2 forms, 3 groups.");
  });

  it("keeps only ids and counts between checks, and reads nothing out of shape", () => {
    const kept = new Map<string, string>();
    const store = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => { kept.set(k, v); } };
    expect(keptCounts(store, "ORG-maple")).toBeNull();
    store.setItem("ozzie.genesis.form-counts.v1", JSON.stringify({ church: "ORG-maple", counts: { "GF-prayer": 5, "bad id!": 2, "GF-x": -1 } }));
    expect(keptCounts(store, "ORG-maple")).toEqual({ "GF-prayer": 5 });
    expect(keptCounts(store, "ORG-other")).toBeNull();
  });
});

describe("Genesis's own schedule words (review of 4c3d32ac, M-a, M-e)", () => {
  it("says what starts Genesis's reads, never a service to choose, and offers its own pause", () => {
    const notYet = { ready: false, paused: false, running: false, intervalMinutes: 60, runOnLaunch: true, last: null, next: null, missed: [] };
    expect(progressEmptyText(notYet, false, { name: "Genesis", jobs: false, system: "genesis" }))
      .toMatch(/^Nothing runs yet\. Ozzie reads Genesis on its own once it is connected and has read it once; /u);
    expect(progressEmptyText(notYet, false, { name: "Genesis", jobs: false, system: "genesis" })).not.toContain("a service is chosen");
    const watch = (paused: boolean) => text(renderToStaticMarkup(React.createElement(GenesisWatch, { intervalMinutes: 30, capture, problem: "", paused, onPause: () => {}, onResume: () => {} })));
    expect(watch(false)).toContain("at least every 30 minutes");
    expect(watch(false)).toContain("Pause reading Genesis");
    expect(watch(true)).toContain("Resume reading Genesis");
    expect(watch(false)).toContain(", the morning briefing and private notices work with Planning Center, B1 Church and Breeze.");
  });
});
