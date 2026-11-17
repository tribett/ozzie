import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "finished") }));
import { invoke } from "@tauri-apps/api/core";
import { nov22Capture } from "../../../core/src/fictional-sunday.js";
import { buildSundayBrief } from "../../../core/src/sunday-brief.js";
import { BriefingPanel, briefingVoice } from "../src/briefing.js";
import { TodayPage } from "../src/today-page.js";

const capture = nov22Capture();
const brief = buildSundayBrief(capture, { sundayLeads: [], checkInAfterSundaysInARow: 3 }, capture.completed_at, true);

describe("Listen to today's briefing", () => {
  // The fictional example, once the person chose it: its email import is in the briefing too.
  const html = renderToStaticMarkup(React.createElement(TodayPage, { brief, names: capture.names, onSunday: () => {}, example: true }));

  it("sits on Today with Play, an Include names choice that starts off, and the written script below", () => {
    expect(html).toContain("Listen to today&#x27;s briefing");
    expect(html).toContain(">Play</button>");
    expect(html).toMatch(/<input type="checkbox"\/><span>Include names/);
    expect(html).toContain("Stopping or skipping doesn&#x27;t mark anything done.");
    expect(html).toContain("For Sunday, Greeter still needs one more person");
    expect(html).toContain("Someone scheduled for Lyrics hasn&#x27;t accepted yet.");
    expect(html).toContain("I ignored one email that contained instructions.");
  });

  it("leaves every name out of the script by default and speaks nothing just by rendering", () => {
    const script = html.slice(html.indexOf("listen-script"));
    for (const name of Object.values(capture.names)) expect(script).not.toContain(name);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads Sunday without a check as not checked, never as clear", () => {
    const none = renderToStaticMarkup(React.createElement(BriefingPanel, { input: { attention: null, sunday: null }, names: {}, timeZone: "America/New_York" }));
    expect(none).toContain("Sunday hasn&#x27;t been checked yet.");
    expect(none).toContain("Nothing I read needs a decision.");
  });

  it("hands the exact script to the Mac's voice and stops it on request", async () => {
    await briefingVoice.speak("Here is today's briefing.");
    expect(invoke).toHaveBeenCalledWith("speak_briefing", { text: "Here is today's briefing." });
    await briefingVoice.stop();
    expect(invoke).toHaveBeenLastCalledWith("stop_briefing");
  });
});
