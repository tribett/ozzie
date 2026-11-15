// Settings → Other AI apps, while sharing is on: the setup text names the helper bundled in this Ozzie and nothing
// else, the steps for Claude are plain words, and they say what the other app will and won't see. Fictional paths only.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { copySetup, OtherAiAppsSetup, SETUP_MISSING, SETUP_MOVE, SETUP_NEVER, SETUP_SEES, SETUP_STEPS, setupText, temporaryPath } from "../src/other-ai-apps-setup.js";

const HELPER = "/Applications/Ozzie.app/Contents/MacOS/ozzie-share";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const render = (props: Parameters<typeof OtherAiAppsSetup>[0]) => renderToStaticMarkup(React.createElement(OtherAiAppsSetup, props));
/** What a person reads, without the setup text itself (which the other app's settings file needs as it is). */
const prose = (html: string) => text(html.replace(/<pre[^]*?<\/pre>/gu, " "));

// A path on another disk or a disk image, built in parts so no machine-style path sits in the source.
const onDisk = (rest: string) => ["", "Volumes", rest].join("/");

describe("the setup text", () => {
  it("starts the bundled helper by its real path, with no arguments and nothing else", () => {
    expect(JSON.parse(setupText(HELPER))).toEqual({ mcpServers: { ozzie: { command: HELPER } } });
    const odd = "/Applications/Church \"Tools\"/Ozzie.app/Contents/MacOS/ozzie-share";
    expect(JSON.parse(setupText(odd))).toEqual({ mcpServers: { ozzie: { command: odd } } });
  });

  it("is copied only when the clipboard takes it", async () => {
    const taken: string[] = [];
    expect(await copySetup("x", { writeText: async t => { taken.push(t); } })).toBe(true);
    expect(taken).toEqual(["x"]);
    expect(await copySetup("x", { writeText: async () => { throw new Error("denied"); } })).toBe(false);
    expect(await copySetup("x", undefined)).toBe(false);
  });
});

describe("the steps in Settings", () => {
  it("show nothing while sharing is off", () => {
    expect(render({ on: false, path: HELPER })).toBe("");
  });

  it("show the setup text with this Ozzie's helper, three steps for Claude, and what the other app will and won't see", () => {
    const html = render({ on: true, path: HELPER });
    expect(html).toContain(`<code>${setupText(HELPER).replaceAll("\"", "&quot;")}</code>`);
    expect(html).toContain("Copy setup text");
    expect(html.match(/<li>/gu)).toHaveLength(3);
    const words = prose(html);
    for (const step of SETUP_STEPS) expect(words).toContain(step);
    expect(words).toContain("Settings, choose Developer, then Edit Config");
    expect(words).toContain(SETUP_SEES);
    expect(words).toContain(SETUP_NEVER);
    expect(words).toContain("labels like [Person 1] instead of names");
    expect(words).toContain("never sees a name, a background check");
    expect(words).toContain("up to that app and its privacy terms");
  });

  it("say so plainly when this Ozzie has no helper, or runs from macOS's temporary copy", () => {
    const missing = prose(render({ on: true, path: null }));
    expect(missing).toContain(SETUP_MISSING);
    expect(missing).not.toContain("Copy setup text");
    const moved = "/private/var/folders/x/T/AppTranslocation/1234/d/Ozzie.app/Contents/MacOS/ozzie-share";
    expect(temporaryPath(moved)).toBe(true);
    expect(temporaryPath(HELPER)).toBe(false);
    // Run straight from the disk image it came on (or another disk), the path goes away when that disk is ejected.
    expect(temporaryPath(onDisk("Ozzie/Ozzie.app/Contents/MacOS/ozzie-share"))).toBe(true);
    expect(temporaryPath(onDisk("Ozzie 1/Ozzie.app/Contents/MacOS/ozzie-share"))).toBe(true);
    expect(prose(render({ on: true, path: onDisk("Ozzie/Ozzie.app/Contents/MacOS/ozzie-share") }))).toContain(SETUP_MOVE);
    expect(SETUP_MOVE).toMatch(/^Move Ozzie to your Applications folder/u);
    // A development build isn't an app on a disk: its steps still show.
    expect(temporaryPath(onDisk("Work/ozzie/target/debug/ozzie-share"))).toBe(false);
    expect(temporaryPath(["", "Users", "Shared/Applications/Ozzie.app/Contents/MacOS/ozzie-share"].join("/"))).toBe(false);
    const temporary = render({ on: true, path: moved });
    expect(prose(temporary)).toContain(SETUP_MOVE);
    expect(temporary).not.toContain("AppTranslocation");
  });

  it("use plain words: no technical terms a person shouldn't have to read", () => {
    for (const html of [render({ on: true, path: HELPER }), render({ on: true, path: null })]) {
      expect(prose(html)).not.toMatch(/\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|MCP|servers?|JSON|stdio|protocol|config file)\b/iu);
    }
  });
});
