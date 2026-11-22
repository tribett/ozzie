// Settings → Other AI apps, while sharing is on: the setup text names the helper bundled in this Ozzie and nothing
// else, the steps for Claude are plain words, and they say what the other app will and won't see. Fictional paths only.
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { SETUP_APPS, setupApp } from "../../../core/mcp/setup.js";
import { ADD_BODY, ADD_BY_HAND, ADD_OPENED, ADD_WARNING, ADD_PROBLEMS, ADD_TO_CLAUDE, addProblem, copySetup, OtherAiAppsSetup, SETUP_MISSING, SETUP_MOVE, SETUP_MOVED, SETUP_NEVER, SETUP_ODD, SETUP_SEES, SETUP_STEPS, SETUP_WHICH, setupText, temporaryPath } from "../src/other-ai-apps-setup.js";

const HELPER = "/Applications/Ozzie.app/Contents/MacOS/ozzie-share";
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'").replaceAll("&quot;", "\"").replace(/\s+/g, " ");
const render = (props: Parameters<typeof OtherAiAppsSetup>[0]) => renderToStaticMarkup(React.createElement(OtherAiAppsSetup, props));
/** What a person reads, without the setup text itself (which the other app's settings file needs as it is). */
const prose = (html: string) => text(html.replace(/<pre[^]*?<\/pre>/gu, " "));

// A path on another disk or a disk image, built in parts so no machine-style path sits in the source.
const onDisk = (rest: string) => ["", "Volumes", rest].join("/");

describe("the setup text", () => {
  it("starts the bundled helper by its real path, with no arguments and nothing else", () => {
    expect(JSON.parse(setupText(HELPER))).toEqual({ mcpServers: { ozzie: { command: HELPER, args: [] } } });
    const odd = "/Applications/Church \"Tools\"/Ozzie.app/Contents/MacOS/ozzie-share";
    expect(JSON.parse(setupText(odd))).toEqual({ mcpServers: { ozzie: { command: odd, args: [] } } });
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
    expect(html).toContain(">Copy</button>");
    expect(html.match(/<li>/gu)).toHaveLength(3);
    const words = prose(html);
    for (const step of SETUP_STEPS) expect(words).toContain(step);
    expect(words).toContain("Settings, choose Developer, then Edit Config");
    expect(words).toContain(SETUP_SEES);
    expect(words).toContain(SETUP_NEVER);
    expect(words).toContain("labels like [Person 1] instead of names");
    expect(words).toContain("never sees the names Ozzie read from Planning Center, a background check");
    expect(words).not.toMatch(/never sees a name/u);
    expect(words).toContain("up to that app and its privacy terms");
  });

  it("say so plainly when this Ozzie has no helper, or runs from macOS's temporary copy", () => {
    const missing = prose(render({ on: true, path: null }));
    expect(missing).toContain(SETUP_MISSING);
    expect(missing).not.toContain(">Copy<");
    expect(missing).not.toContain(ADD_TO_CLAUDE);
    expect(missing).not.toContain(SETUP_WHICH);
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
    for (const html of [...SETUP_APPS.map(app => render({ on: true, path: HELPER, app: app.id })), render({ on: true, path: null })]) {
      expect(prose(html.replace(/<code>[^<]*<\/code>/gu, " "))).not.toMatch(/\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|MCP|servers?|JSON|stdio|protocol|config file)\b/iu);
    }
  });
});

describe("ready-made setup for each app", () => {
  it("offers every app in the list, Claude chosen first", () => {
    const html = render({ on: true, path: HELPER });
    expect(prose(html)).toContain(SETUP_WHICH);
    // The chosen app shows a tick before its name (accessibility audit M9); the others, their name alone.
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const app of SETUP_APPS) expect(html).toMatch(new RegExp(`aria-pressed="${app.id === "claude"}">${app.id === "claude" ? "<svg [^>]*aria-hidden=\"true\"[^>]*>.*?</svg>" : ""}${esc(app.name)}</button>`, "u"));
    expect(prose(html)).toContain(SETUP_MOVED);
  });

  it("gives Claude one button that says what Claude will show, with the steps by hand folded beneath it", () => {
    const html = render({ on: true, path: HELPER });
    const words = prose(html);
    expect(html).toContain(`>${ADD_TO_CLAUDE}</button>`);
    expect(words).toContain(ADD_BODY);
    expect(words).toContain(ADD_WARNING);
    expect(ADD_BODY).toContain("nothing is added until you agree there");
    // Claude's own warning is said before the person meets it, with what Claude really starts (seen 2026-11-16).
    expect(ADD_WARNING).toContain("hasn't verified the file");
    expect(ADD_WARNING).toContain("can reach everything on your Mac");
    expect(ADD_WARNING).toContain("the part of Ozzie that reads Ozzie's copy and nothing else");
    expect(ADD_OPENED).toContain("choose Install, then Install again to confirm");
    expect(ADD_OPENED).toMatch(/If nothing appears in Claude, set it up by hand below\.$/u);
    // Folded like every other fold, its chevron first (polish pass, 2026-11-18).
    const folded = html.search(new RegExp(`<summary><svg class="ic ic-sm" [^>]*><path d="m9 6 6 6-6 6"></path></svg>${ADD_BY_HAND}</summary>`, "u"));
    expect(folded).toBeGreaterThan(-1);
    expect(folded).toBeGreaterThan(html.indexOf(ADD_TO_CLAUDE));
    expect(html.indexOf("<ol")).toBeGreaterThan(folded);
    // Nothing is said to have happened before the button is pressed.
    expect(words).not.toContain(ADD_OPENED);
    expect(html).not.toContain("role=\"alert\"");
  });

  it("shows each other app its own steps and exact text, and no button that adds anything", () => {
    for (const app of SETUP_APPS.filter(a => !a.oneClick)) {
      const html = render({ on: true, path: HELPER, app: app.id });
      expect(html, app.id).toContain(`<code>${app.text(HELPER).replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("'", "&#x27;")}</code>`);
      expect(html.match(/<li>/gu), app.id).toHaveLength(app.steps.length);
      expect(prose(html), app.id).toContain(`${app.textLabel}:`);
      expect(html, app.id).not.toContain(ADD_TO_CLAUDE);
      expect(html, app.id).not.toContain("`");
    }
    // An app that asks for a command gets the helper's path by itself, exactly, whatever the folder is called.
    const odd = "/Applications/Church \"Tools\"/Ozzie.app/Contents/MacOS/ozzie-share";
    const other = render({ on: true, path: odd, app: "other" });
    expect(prose(other)).toContain("The command by itself:");
    expect(other).toContain(`<code>${odd.replaceAll("\"", "&quot;")}</code>`);
    expect(render({ on: true, path: HELPER, app: "cursor" })).not.toContain("The command by itself");
    // A file name in a step is shown as one.
    expect(render({ on: true, path: HELPER, app: "cursor" })).toContain("<code>mcp.json</code>");
    expect(setupApp("claude-code").text(HELPER)).toContain(HELPER);
  });

  it("gives no setup at all for a folder other apps couldn't be handed", () => {
    const odd = "/Applications/${x}/Ozzie.app/Contents/MacOS/ozzie-share";
    const html = render({ on: true, path: odd });
    expect(prose(html)).toContain(SETUP_ODD);
    expect(html).not.toContain(ADD_TO_CLAUDE);
    expect(html).not.toContain("<pre");
  });

  it("says plainly what went wrong for each of native's codes, and treats anything else as not opened", () => {
    expect(Object.keys(ADD_PROBLEMS).sort()).toEqual(["move-first", "no-helper", "not-opened", "not-saved"]);
    expect(addProblem("no-helper")).toBe(SETUP_MISSING);
    expect(addProblem("move-first")).toBe(SETUP_MOVE);
    expect(addProblem("not-saved")).toMatch(/couldn't save the setup file/u);
    for (const other of ["constructor", "", undefined, { code: "no-helper" }, 7]) expect(addProblem(other)).toBe(ADD_PROBLEMS["not-opened"]);
    for (const line of [...Object.values(ADD_PROBLEMS), ADD_OPENED, ADD_BODY, ADD_WARNING]) expect(line).not.toMatch(/\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|MCP|servers?|JSON|stdio|protocol|config file|extension|bundle)\b/iu);
  });

  it("holds native's codes: the same four, spelled the same (share_bundle.rs)", () => {
    const native = readFileSync(new URL("../src-tauri/src/share_bundle.rs", import.meta.url), "utf8");
    const body = /pub enum AddToClaudeError \{([^}]*)\}/u.exec(native)![1]!;
    const codes = [...body.matchAll(/^\s{4}([A-Z][A-Za-z]+),$/gmu)].map(m => m[1]!.replace(/[A-Z]/gu, (c, i: number) => (i ? "-" : "") + c.toLowerCase()));
    expect(codes.sort()).toEqual(Object.keys(ADD_PROBLEMS).sort());
    expect(native).toContain("#[serde(rename_all = \"kebab-case\")]\npub enum AddToClaudeError");
  });
});
