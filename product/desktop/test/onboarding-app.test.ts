// How App wires the new onboarding (review M1, M11, H2): read from App's source, since App needs the whole native side
// to mount. The behaviour behind each line is tested where it lives (first-run-state, your-service, first-run-e2e).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

describe("App's onboarding wiring", () => {
  it("keeps the AI screen's answer: first run passes it through, and Settings records a choice or No AI for now (M1)", () => {
    expect(app).toContain('renderAi={done => <AiChoice mode="first-run" onModel={setModelReady} onDone={how => done(how)}');
    // Leaving the AI screens over Settings opens Settings at its AI help section (live, 2026-11-18; ai-over-page.test.ts),
    // and the AI in use is read again on the way out (review L5).
    expect(app).toContain('onDone={how => { if (how !== "later") setupMemo.set({ aiOffered: true, aiAnswer: how }); setAiChoosing(false); readModel(); if (page === "connection") setSettingsAt("ai-title"); }}');
    expect(app).toContain("ai: { left: aiStillOpen(setupMemo.get(), modelStatus, recordings.length > 0)");
  });

  it("while setup is unfinished, the sidebar's first entry leads back to it, and AI and Ask wait for the first result (M11)", () => {
    const nav = app.slice(app.indexOf('<nav className="nav" aria-label="Pages">'), app.indexOf("{navFor(day).map("));
    expect(nav).toContain('{setupEntry && <a href="#setup" className="nav-i nav-setup" aria-current={showSetup ? "page" : undefined}');
    expect(nav).toContain("if (!showSetup) openSetup(setupAt ?? undefined);");
    // The entry and the screen agree: it shows while setup is on screen, as well as while a fact is unmet.
    expect(app).toContain("const setupEntry = showSetup || setupAt !== null;");
    // Not while a sign-in only adds Calendar, People and Groups to a connected church (decision 24), nor while any sign-in for
    // a church already connected is in the browser (review item 7; both in read-more-app.test.ts).
    // A church on B1 Church, Breeze or Genesis opens at its own first unmet fact (decision 21; Genesis, round 5).
    expect(app).toContain('const setupAt = setup === "auto" || fictional || addingAccess || reconnecting ? null : setupFor();');
    expect(app).toContain("const setupFor = (): FirstRunScreen | null => onSystem ? systemSetup : onGenesis ? genesisSetup : firstRunScreen(facts);");
    expect(app).toMatch(/\{askShown && <div className="small side-ai"><AiLine /u);
    expect(app).toMatch(/\{askShown && <button type="button" ref=\{askEntry\}/u);
    expect(app).toContain("const askShown = resultSeen || setup === null;");
    // The page links stay: they are setup's escape, never a trap (spec §0.3).
    expect(app).toContain("{navFor(day).map(n =>");
  });

  it("looks for a plan every hour while connected with no service chosen, and picks the only one by itself (H2)", () => {
    const look = app.slice(app.indexOf("const [serviceLook, setServiceLook]"), app.indexOf("// First run's result"));
    expect(look).toContain("if (Date.now() - serviceLookAt.current < WAIT_AGAIN_MS) return;");
    expect(look).toContain("const d = decideService(pick);");
    expect(look).toContain('if (d.kind === "one") {');
    expect(app).toContain('service: { deferred: connected && !configured && serviceLook !== "waiting", watching: configured }');
  });

  it("never adds a keydown handler that could close setup: Escape closes only sheets and menus (spec §0.1)", () => {
    for (const m of app.matchAll(/addEventListener\("keydown", (\w+)\)/gu)) {
      const handler = app.slice(app.lastIndexOf(`const ${m[1]} =`, m.index), m.index);
      expect(handler).not.toMatch(/setSetup|leaveSetup/u);
    }
  });
});
