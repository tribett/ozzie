import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => new Promise(() => {})) }));
import { planFromAddress, SetupFlow, STEPS, type Step } from "../src/setup-flow.js";
import { DEFAULT_PREFS } from "../src/proactive.js";
import type { ConnectionStatus } from "../src/connection.js";
import { App } from "../src/App.js";

const settings = { clientId: "fictional-client", organization: "1001", serviceTypeId: "", planId: "" };
const status = (state: ConnectionStatus["state"]): ConnectionStatus => ({ state, organization: "1001", checked_at_ms: Date.UTC(2026, 10, 20, 15), source: "", problem: null });
const render = (initial: Step, over: Partial<React.ComponentProps<typeof SetupFlow>> = {}) => renderToStaticMarkup(React.createElement(SetupFlow, {
  status: null, settings, onSettings() {}, onStatus() {}, prefs: DEFAULT_PREFS, onModel() {}, onClose() {}, onExample() {}, onAutomatic() {}, initial, ...over,
}));

describe("guided setup", () => {
  it("has five steps, one at a time, each with Skip for now", () => {
    expect(STEPS).toEqual(["about", "connect", "sunday", "wording", "automatic"]);
    for (const [i, step] of STEPS.entries()) {
      const html = render(step);
      expect(html).toContain(`step ${i + 1} of 5`);
      expect(html).toContain("Skip for now");
    }
  });

  it("starts with what Ozzie does and never does, and keeps the fictional example one click away", () => {
    const html = render("about");
    for (const line of ["Reads only.", "Never sends.", "Names Ozzie reads stay on this Mac.", "People decide."]) expect(html).toContain(line);
    expect(html).toContain("See the fictional example");
  });

  it("explains what Planning Center access will be read and says connected only after Planning Center confirmed it", () => {
    const before = render("connect");
    expect(before).toContain("What Ozzie will read");
    expect(before).toContain("Change anything in Planning Center or send messages.");
    expect(before).toContain("Not connected yet.");
    expect(before).not.toMatch(/Connected\./);
    const saved = render("connect", { status: status("stored-unchecked") });
    expect(saved).toContain("hasn&#x27;t been checked yet");
    expect(saved).toContain("Check saved connection");
    expect(saved).not.toMatch(/Connected\./);
    expect(render("connect", { status: status("failed") })).toContain("isn&#x27;t connected");
    const done = render("connect", { status: status("connected") });
    expect(done).toContain("Connected. Planning Center confirmed organization 1001");
    expect(done).toContain("Next: choose the Sunday");
  });

  it("helps find the Sunday plan's numbers", () => {
    const html = render("sunday");
    expect(html).toContain("…/service_types/<b>service type</b>/plans/<b>plan</b>");
    expect(html).toContain("Service type ID");
    expect(html).toContain("Plan ID");
    expect(planFromAddress("https://services.planningcenteronline.com/service_types/1694698/plans/92902197/team")).toEqual({ serviceTypeId: "1694698", planId: "92902197" });
    expect(planFromAddress("https://services.planningcenteronline.com/plans/92902197")).toEqual({ planId: "92902197" });
    expect(planFromAddress("service_types/0123/plans/x")).toEqual({});
    expect(planFromAddress("nothing here")).toEqual({});
  });

  it("reuses the AI help settings and points to What runs automatically for checks and quiet hours", () => {
    // One name for the AI settings everywhere: they cover rewording drafts and Ask Ozzie's answers.
    expect(render("wording")).toContain("AI help (optional)");
    expect(render("wording")).toContain("AI help can reword a draft when you ask, and answers your questions in Ask Ozzie.");
    expect(render("wording")).not.toMatch(/wording help/iu);
    expect(render("sunday")).not.toMatch(/wording help/iu);
    // Ozzie managed isn't offered as available yet in first-run setup.
    expect(render("wording")).toContain("Ozzie managed (coming soon)");
    expect(render("wording")).not.toContain("Connect to Ozzie managed");
    const auto = render("automatic");
    expect(auto).toContain("Every hour");
    expect(auto).toContain("Quiet hours");
    // Going to What runs automatically from here also ends setup, and the button says so.
    expect(auto).toContain("Finish and open What runs automatically");
    expect(auto).not.toContain("Change these in What runs automatically");
    expect(auto).toContain("Waits until Planning Center is connected.");
    expect(auto).toContain("Finish setup");
  });

  it("the app keeps Settings, adds Visitor cards, and doesn't cover the screen before the connection is known", () => {
    const html = renderToStaticMarkup(React.createElement(App));
    expect(html).toContain("Visitor cards");
    expect(html).toContain("Settings");
    expect(html).not.toContain("Setting up Ozzie");
    expect(html).toContain("What needs you today");
  });
});
