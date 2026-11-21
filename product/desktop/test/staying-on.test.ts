// Staying on (audit item 23) and asking before quitting (items 20 and 23): the question on Today for an install set up
// before setup asked it, and the question in the window when a quit would stop checks or discard visitor cards.
import React from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { TodayPage, START_BODY, START_TITLE } from "../src/today-page.js";
import { QuitQuestion, quitWords } from "../src/quit-question.js";
import { quitting } from "../src/background.js";
import { text } from "./harness-fakes.js";

const NOW = "2026-11-16T15:00:00.000Z";
const today = (startQuestion: { onYes(): void; onNo(): void; failed: boolean } | null, example = false) => text(renderToStaticMarkup(React.createElement(TodayPage, {
  brief: null, names: {}, onSunday: () => {}, now: NOW, zone: "America/Chicago", store: { get: () => null, set: () => {} }, startQuestion, example,
})));

describe("Ozzie isn't set to start with this Mac (audit item 23)", () => {
  it("is asked once on Today, with the leader's two answers, and only when App says so", () => {
    const t = today({ onYes() {}, onNo() {}, failed: false });
    expect(t).toContain(`${START_TITLE} ${START_BODY} Yes, start it with this Mac No, I'll open it myself`);
    expect(START_BODY).toBe("Ozzie can only check Planning Center while it is running, so after this Mac restarts nothing is checked until you open it. Start Ozzie with this Mac?");
    expect(today(null)).not.toContain(START_TITLE);
    // Never inside the fictional example.
    expect(today({ onYes() {}, onNo() {}, failed: false }, true)).not.toContain(START_TITLE);
    expect(today({ onYes() {}, onNo() {}, failed: true })).toContain("This Mac didn't let Ozzie change that setting. You can try again under Settings.");
  });

  it("is never changed without a click: App asks only an install that hasn't answered, while Ozzie doesn't start with the Mac", () => {
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    // Asked now as Today's "Finish setting up" item 1 (onboarding spec §4.1), which replaces this card; the answer is the leader's click.
    expect(app).toContain("startQuestion={null}");
    expect(app).toContain("<FinishSettingUp facts={finishFacts} startFailed={startFailed} onStartWithMac={answerStart}");
    // The only place App sets the switch is the leader's answer.
    expect(app.match(/autostart\.set\(/gu)).toHaveLength(1);
    expect(app).toContain("void autostart.set(on).then(");
  });
});

describe("asking before Ozzie quits (audit items 20 and 23)", () => {
  it("says what quitting stops or discards, with buttons that name the effect, and starts on the safe answer", () => {
    expect(quitWords({ cards: 3, checks: false })).toEqual({ title: "Quit and discard the cards?", quit: "Quit and discard the cards", keep: "Keep Ozzie running",
      lines: ["You have 3 visitor cards that aren't saved anywhere. Quitting discards them.", "Closing the window instead keeps Ozzie running, as the small Ozzie picture at the top of your screen."] });
    expect(quitWords({ cards: 0, checks: true })).toEqual({ title: "Quit Ozzie?", quit: "Quit Ozzie", keep: "Keep Ozzie running",
      lines: ["Checks and notices stop until you open Ozzie again.", "Closing the window instead keeps Ozzie running, as the small Ozzie picture at the top of your screen."] });
    // Both at once: one question.
    const both = quitWords({ cards: 1, checks: true });
    expect(both.title).toBe("Quit Ozzie?");
    expect(both.lines).toEqual(["You have 1 visitor card that isn't saved anywhere. Quitting discards it.", "Checks and notices stop until you open Ozzie again.",
      "Closing the window instead keeps Ozzie running, as the small Ozzie picture at the top of your screen."]);
    expect(both.quit).toBe("Quit and discard the card");
    const html = renderToStaticMarkup(React.createElement(QuitQuestion, { ask: { cards: 2, checks: true }, onQuit() {}, onKeep() {} }));
    expect(html).toContain('role="alertdialog" aria-modal="true" aria-labelledby="quit-title" aria-describedby="quit-body"');
    expect(html.indexOf(">Keep Ozzie running</button>")).toBeLessThan(html.indexOf(">Quit and discard the cards</button>"));
  });

  it("tells native code counts only, and quits or keeps running on the leader's answer", async () => {
    quitting.guard(2, true);
    quitting.guard(1000, false);
    quitting.guard(-3, false);
    await quitting.quit();
    quitting.keep();
    await Promise.resolve();
    expect(invoke.mock.calls).toEqual([["quit_guard_set", { cards: 2, checks: true }], ["quit_guard_set", { cards: 99, checks: false }], ["quit_guard_set", { cards: 0, checks: false }],
      ["quit_now"], ["quit_kept"]]);
    const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
    // What App tells it, and when, is test/quit-guard.test.ts (review P, L2).
    expect(app).toContain("useQuitGuard(openCards, { readiness, schedule: automatic.schedule, watch }, changes.undoable.length > 0);");
  });
});
