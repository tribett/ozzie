// Ozzie's Siri actions (ADR 0007): "Is Sunday covered" and opening Ozzie's Today and Sunday pages as App Intents, in a
// sandboxed extension bundled with Ozzie (helpers/siri-actions.swift, built by build.rs into binaries/OzzieIntents.appex).
// They answer with the very code the ozzie-shortcuts helper runs (helpers/shortcuts-answer.swift) over the same copy and
// switch, so there is no second way in: compiled here with a small check program, every answer is compared with the
// helper's and with core/mcp/shortcuts.ts on fixed data. The sandbox lets them read exactly the copy and its marker.
// Every run gets its own home folder, so the real Ozzie data folder on this Mac is never read. Fictional data only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, type Rollup } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HarnessSession } from "../../../core/src/harness/session.js";
import { HarnessTools } from "../../../core/src/harness/tools.js";
import { MAX_SHARED_BYTES, sharedCheckText, sharedEnvelopes } from "../../../core/mcp/snapshot.js";
import { NO_CHECK, OFF, SHORTCUTS_FILE, SHORTCUTS_ON_FILE, shortcutsAnswer, shortcutsEnvelopes } from "../../../core/mcp/shortcuts.js";
import { FRESH, harnessData } from "../../../core/test/harness/fixtures.js";
import { OPENABLE_PAGES } from "../src/siri-shortcuts.js";

const SRC = new URL("../src-tauri/", import.meta.url);
const read = (file: string) => readFileSync(new URL(file, SRC), "utf8");
const SHARED = "helpers/shortcuts-answer.swift";
const HELPER_MAIN = "helpers/shortcuts.swift";
const ACTIONS = "helpers/siri-actions.swift";
const EXTENSION = "helpers/siri-actions-extension.swift";
const SWIFT = [SHARED, HELPER_MAIN, ACTIONS, EXTENSION];
/** The data folder native keeps the copy in: the app's identifier under Application Support. */
const APP_ID = (JSON.parse(read("tauri.conf.json")) as { identifier: string }).identifier;
const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
const HELPER = new URL(`binaries/ozzie-shortcuts-${triple}`, SRC).pathname;
const APPEX = new URL("binaries/OzzieIntents.appex/", SRC).pathname;
/** Source text without comments, so a word in a comment can't satisfy or fail a check. */
const code = (src: string) => src.replace(/^\s*\/\/.*$/gmu, "").replace(/\s\/\/ .*$/gmu, "");
const literals = (src: string) => [...code(src).matchAll(/"(?:[^"\\]|\\.)*"/gu)].map(m => m[0]);

describe("the Siri actions' source", () => {
  it("answers with the helper's own code: one answer, one read and one switch check, all in the shared file", () => {
    const all = SWIFT.map(f => [f, code(read(f))] as const);
    const where = (re: RegExp) => all.filter(([, src]) => re.test(src)).map(([f]) => f);
    expect(where(/\b(?:struct|class|enum) OzzieAnswers\b/u)).toEqual([SHARED]);
    expect(where(/\bfunc readCopy\(/u)).toEqual([SHARED]);
    expect(where(/\bO_RDONLY\b/u)).toEqual([SHARED]);
    expect(where(/\bfunc isRegularFile\(/u)).toEqual([SHARED]);
    expect(where(/\bgetsectiondata\(/u)).toEqual([SHARED]);
    // The helper asks the shared answers its one question; "Is Sunday covered" asks them "sunday", the helper's word.
    expect(code(read(HELPER_MAIN))).toMatch(/\.answer\(question, home: homeFolder\(\)\)/u);
    expect(code(read(ACTIONS))).toMatch(/OzzieAnswers\(\)\?\.answer\("sunday", home: home\)/u);
    expect([...code(read(ACTIONS)).matchAll(/\.answer\(/gu)]).toHaveLength(1);
    // The pages open only while the switch is on, checked the same way.
    expect(code(read(ACTIONS))).toMatch(/\.isOn\(home: home\)/u);
  });

  it("reads nothing else, writes nothing, reaches no network, starts no process and reads no environment", () => {
    for (const file of [ACTIONS, EXTENSION]) {
      const src = code(read(file));
      expect(src, file).not.toMatch(/URLSession|CFNetwork|\bNetwork\b|socket\(|connect\(|getaddrinfo|Process\(|NSTask|posix_spawn|fork\(|exec[lv]p?\(|system\(|popen\(/u);
      expect(src, file).not.toMatch(/O_WRONLY|O_RDWR|O_CREAT|O_APPEND|fopen\(|FileManager|createFile|\.write\(|unlink\(|rename\(|mkdir\(|truncate\(|chmod\(|contentsOf/u);
      expect(src, file).not.toMatch(/environment|getenv|NSHomeDirectory|homeDirectoryForCurrentUser|standardInput|readLine\(/u);
      // No file is opened here; only links are, by NSWorkspace.
      expect(src.replace(/NSWorkspace\.shared\.open\(/gu, ""), file).not.toMatch(/\bopen\(/u);
    }
    expect([...code(read(ACTIONS)).matchAll(/^import (\w+)/gmu)].map(m => m[1]).sort()).toEqual(["AppIntents", "AppKit", "Darwin", "Foundation"]);
    expect([...code(read(EXTENSION)).matchAll(/^import (\w+)/gmu)].map(m => m[1]).sort()).toEqual(["AppIntents", "ExtensionFoundation"]);
    // Inside the sandbox HOME is the extension's own folder: the account's home comes from the user database.
    expect(code(read(ACTIONS))).toMatch(/getpwuid\(getuid\(\)\)/u);
    // The data folder is the app's, in one place.
    expect(code(read(SHARED))).toContain(`"Library/Application Support/${APP_ID}"`);
  });

  it("opens only Ozzie's Today and Sunday links, in the Ozzie it came with", () => {
    const src = code(read(ACTIONS));
    expect([...src.matchAll(/"ozzie:\/\/([^"]*)"/gu)].map(m => m[1]).sort()).toEqual([...OPENABLE_PAGES].sort());
    // The Ozzie that holds this extension, found from the extension's own bundle by ozzie(of:) (checked below).
    expect(src).toMatch(/NSWorkspace\.shared\.open\(\[[^\]]*\], withApplicationAt: ozzie\(of: Bundle\.main\.bundleURL\),/u);
    expect([...src.matchAll(/withApplicationAt:/gu)]).toHaveLength(1);
  });

  it("is never answered or opened from a locked Mac: every action requires authentication (review I, L2; review J, L3)", () => {
    const intents = [...code(read(ACTIONS)).matchAll(/^struct (\w+): AppIntent \{\n([\s\S]*?)^\}$/gmu)];
    expect(intents.map(m => m[1]).sort()).toEqual(["IsSundayCoveredIntent", "OpenSundayPageIntent", "OpenTodayPageIntent"]);
    for (const [, name, body] of intents) {
      expect(body, name).toMatch(/^ {4}static let authenticationPolicy: IntentAuthenticationPolicy = \.requiresAuthentication$/mu);
    }
  });

  it("speaks plainly: action names, descriptions and phrases in Ozzie's own words, each phrase naming the app", () => {
    const words = literals(read(ACTIONS)).filter(l => !/^"ozzie:\/\/|^"[a-z]+(?:\.[a-z]+)+"$/u.test(l));
    expect(words.length).toBeGreaterThan(8);
    for (const text of words) {
      expect(text, text).not.toMatch(/\bskills?\b|\bsessions?\b|\bagents?\b|\blogs?\b|\bconnectors?\b|\bharness\b|\bMCP\b/iu);
      expect(text, text).not.toMatch(/binary|javascriptcore|script|helper|section|extension|intent|appex|sandbox|entitlement/iu);
    }
    const phrases = [...code(read(ACTIONS)).matchAll(/phrases: \[([^\]]*)\]/gu)].flatMap(m => literals(m[1]!));
    expect(phrases.length).toBeGreaterThanOrEqual(6);
    for (const phrase of phrases) expect(phrase, phrase).toContain("\\(.applicationName)");
    for (const title of ["Is Sunday covered", "Open Ozzie's Sunday page", "Open Ozzie's Today page"]) expect(words).toContain(`"${title}"`);
  });
});

describe("the Siri actions' bundle", () => {
  it("may read exactly the copy for Shortcuts and its marker, read-only, inside the App Sandbox", () => {
    const plist = read("Entitlements-intents.plist");
    expect([...plist.matchAll(/<key>([^<]*)<\/key>/gu)].map(m => m[1])).toEqual([
      "com.apple.security.app-sandbox", "com.apple.security.temporary-exception.files.home-relative-path.read-only",
    ]);
    expect(plist).toMatch(/<key>com\.apple\.security\.app-sandbox<\/key>\s*<true\/>/u);
    expect([...plist.matchAll(/<string>([^<]*)<\/string>/gu)].map(m => m[1])).toEqual([
      `/Library/Application Support/${APP_ID}/${SHORTCUTS_FILE}`, `/Library/Application Support/${APP_ID}/${SHORTCUTS_ON_FILE}`,
    ]);
  });

  it("is an App Intents extension of this app, built from the three Swift files with the answers linked in, and bundled", () => {
    expect(read("intents/Info.plist")).toMatch(/<key>EXExtensionPointIdentifier<\/key>\s*<string>com\.apple\.appintents-extension<\/string>/u);
    const project = read("intents/OzzieIntents.xcodeproj/project.pbxproj");
    expect(project).toContain("productType = \"com.apple.product-type.extensionkit-extension\";");
    expect(project).toContain(`PRODUCT_BUNDLE_IDENTIFIER = ${APP_ID}.intents;`);
    expect(project).toContain("CODE_SIGNING_ALLOWED = NO;");
    expect([...project.matchAll(/path = "?\.\.\/(helpers\/[\w-]+\.swift)"?;/gu)].map(m => m[1]).sort()).toEqual([SHARED, ACTIONS, EXTENSION].sort());
    expect([...project.matchAll(/\/\* ([\w-]+\.swift) in Sources \*\/ = \{/gu)].map(m => `helpers/${m[1]}`).sort()).toEqual([SHARED, ACTIONS, EXTENSION].sort());
    expect(project).toMatch(/-sectcreate,\s*-Xlinker,\s*__TEXT,\s*-Xlinker,\s*__ozzie_answers,\s*-Xlinker,\s*"\$\(OZZIE_ANSWERS_SCRIPT\)",/u);
    const config = JSON.parse(read("tauri.conf.json")) as { bundle: { macOS: { files?: Record<string, string> } } };
    expect(config.bundle.macOS.files).toEqual({ "Extensions/OzzieIntents.appex": "binaries/OzzieIntents.appex" });
  });
});

/** The answers script as `pnpm build:shortcuts` builds it. */
async function answersScript(): Promise<string> {
  const built = await build({ configFile: new URL("../../../core/mcp/vite.shortcuts.config.ts", import.meta.url).pathname, logLevel: "silent", build: { write: false, emptyOutDir: false } });
  return ((Array.isArray(built) ? built[0]! : built as Rollup.RollupOutput).output[0] as Rollup.OutputChunk).code;
}

/** Why the built extension can't be checked here: not built (no Xcode), or older than core/mcp. Null when it can. */
async function appexUnavailable(): Promise<string | null> {
  if (!existsSync(join(APPEX, "Contents/Info.plist"))) return "binaries/OzzieIntents.appex isn't built (it needs Xcode): `cargo build` in product/desktop/src-tauri builds it";
  if (!readFileSync(join(APPEX, "Contents/MacOS/OzzieIntents")).includes(Buffer.from(await answersScript(), "utf8"))) {
    return "binaries/OzzieIntents.appex is older than core/mcp: run `pnpm build:shortcuts`, then `cargo build` in product/desktop/src-tauri";
  }
  return null;
}
const appexWhy = await appexUnavailable();
if (appexWhy) console.warn(`Skipping the built Siri actions test: ${appexWhy}`);

describe.skipIf(appexWhy !== null)("the built Siri actions (binaries/OzzieIntents.appex)", () => {
  it("carry this build's answers and the metadata Siri and Shortcuts find them by", () => {
    const metadata = JSON.parse(readFileSync(join(APPEX, "Contents/Resources/Metadata.appintents/extract.actionsdata"), "utf8")) as {
      actions: Record<string, { title?: { key?: string }; authenticationPolicy?: unknown }>;
      autoShortcuts: { actionIdentifier: string; phraseTemplates: { key: string }[] }[];
    };
    expect(Object.keys(metadata.actions).sort()).toEqual(["IsSundayCoveredIntent", "OpenSundayPageIntent", "OpenTodayPageIntent"]);
    // 1 is .requiresAuthentication: never answered or opened from a locked Mac (review I, L2; review J, L3).
    for (const [name, action] of Object.entries(metadata.actions)) expect(action.authenticationPolicy, name).toBe(1);
    expect(metadata.autoShortcuts.map(s => s.actionIdentifier).sort()).toEqual(["IsSundayCoveredIntent", "OpenSundayPageIntent", "OpenTodayPageIntent"]);
    for (const s of metadata.autoShortcuts) for (const p of s.phraseTemplates) expect(p.key).toContain("${applicationName}");
    const info = spawnSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(APPEX, "Contents/Info.plist")]);
    const plist = JSON.parse(info.stdout.toString()) as Record<string, unknown>;
    expect(plist["CFBundleIdentifier"]).toBe(`${APP_ID}.intents`);
    expect(plist["EXAppExtensionAttributes"]).toEqual({ EXExtensionPointIdentifier: "com.apple.appintents-extension" });
  });
});

// The check program: the Siri actions' own Swift (shared answers and actions, without the extension's entry point)
// with a small main that calls what each action's perform() calls, for a home folder given on the command line, and
// (`ozzie`) the Ozzie that an extension at a given path came with.
const CHECK_MAIN = `import Foundation
@main
enum SiriActionsCheck {
    static func main() {
        let args = CommandLine.arguments
        guard args.count == 3 else { exit(64) }
        let home = args[2]
        switch args[1] {
        case "sunday": print(SiriActions.sundayAnswer(home: home) ?? "<none>")
        case "open-today", "open-sunday":
            switch SiriActions.opening(args[1] == "open-today" ? .today : .sunday, home: home) {
            case .link(let url): print("link \\(url.absoluteString)")
            case .said(let sentence): print("said \\(sentence)")
            }
        case "ozzie":
            let appex = URL(fileURLWithPath: args[2], isDirectory: args[2].hasSuffix("/"))
            let app = SiriActions.ozzie(of: appex)
            print(app.isFileURL ? app.path : "<not a file>")
        default: exit(64)
        }
    }
}
`;

describe.skipIf(process.platform !== "darwin")("Siri actions answering (the actions' code, compiled with a check program)", () => {
  const work = mkdtempSync(join(tmpdir(), "ozzie-siri-actions-"));
  const CHECK = join(work, "check");
  let helperCurrent = false;
  beforeAll(async () => {
    const script = await answersScript();
    // A helper that is built but older than core/mcp fails the run rather than quietly dropping the comparison with
    // it (review I, L5). Only a helper that isn't built here at all leaves the comparison to core/mcp/shortcuts.ts.
    if (existsSync(HELPER)) {
      expect(readFileSync(HELPER).includes(Buffer.from(script, "utf8")),
        `binaries/ozzie-shortcuts-${triple} is older than core/mcp: run \`pnpm build:shortcuts\`, then \`cargo build\` in product/desktop/src-tauri`).toBe(true);
      helperCurrent = true;
    } else console.warn("Comparing the Siri actions with core/mcp/shortcuts.ts only: the ozzie-shortcuts helper isn't built here");
    writeFileSync(join(work, "answers.js"), script);
    writeFileSync(join(work, "check.swift"), CHECK_MAIN);
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const compiled = spawnSync("/usr/bin/xcrun", ["swiftc", "-parse-as-library", "-target", `${arch}-apple-macos14.0`, "-module-cache-path", join(work, "mc"),
      "-o", CHECK, new URL(SHARED, SRC).pathname, new URL(ACTIONS, SRC).pathname, join(work, "check.swift"),
      "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__ozzie_answers", "-Xlinker", join(work, "answers.js")], { timeout: 240_000 });
    expect(compiled.status, compiled.stderr.toString()).toBe(0);
  }, 300_000);
  afterAll(() => { rmSync(work, { recursive: true, force: true }); });

  const homes: string[] = [];
  afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
  function home(on: boolean): { home: string; folder: string } {
    const h = mkdtempSync(join(tmpdir(), "ozzie-siri-home-"));
    homes.push(h);
    const folder = join(h, "Library", "Application Support", APP_ID);
    mkdirSync(folder, { recursive: true });
    if (on) writeFileSync(join(folder, SHORTCUTS_ON_FILE), "", { mode: 0o600 });
    return { home: h, folder };
  }
  /** What the actions' code says for `home`; nothing on stderr, and an empty environment, so HOME can't be what it reads. */
  function check(h: string, what = "sunday"): string {
    const result = spawnSync(CHECK, [what, h], { env: {}, timeout: 20_000 });
    expect(result.status, result.stderr.toString()).toBe(0);
    expect(result.stderr.toString()).toBe("");
    return result.stdout.toString("utf8").replace(/\n$/u, "");
  }
  function helper(h: string): string | null {
    if (!helperCurrent) return null;
    const result = spawnSync(HELPER, ["sunday"], { env: { HOME: h }, timeout: 20_000 });
    expect(result.status, result.stderr.toString()).toBe(0);
    return result.stdout.toString("utf8").replace(/\n$/u, "");
  }
  const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
  /** The fictional Sunday's overview as native writes it: checked five minutes ago for a Sunday a week away, or (`current` false) at the fixture's own time. */
  async function copy(current = true): Promise<string> {
    const data = harnessData({ mode: "live", now: FRESH });
    const envelopes = shortcutsEnvelopes(await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => FRESH })));
    if (current) {
      const week = new Date(Date.now() + 7 * 86_400_000);
      const day = (n: number) => String(n).padStart(2, "0");
      for (const e of envelopes) {
        e.check_time = new Date(Date.now() - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/u, "Z");
        (e.payload as Record<string, unknown>)["sunday"] = `${week.getFullYear()}-${day(week.getMonth() + 1)}-${day(week.getDate())}`;
      }
    }
    return sharedCheckText(envelopes, [], FRESH, "B4K7Q2X9M3T8");
  }

  it("says what the helper says, and what core/mcp/shortcuts.ts says, over the same copy", async () => {
    const { home: h, folder } = home(true);
    for (const text of [await copy(), await copy(false)]) {
      writeFileSync(join(folder, SHORTCUTS_FILE), text, { mode: 0o600 });
      const before = Date.now();
      const said = check(h);
      const expected = [before, Date.now()].map(nowMs => shortcutsAnswer("sunday", { on: true, text, nowMs, timeZone: ZONE }));
      expect(expected).toContain(said);
      const helped = helper(h);
      if (helped !== null) expect([said, ...expected]).toContain(helped);
    }
    writeFileSync(join(folder, SHORTCUTS_FILE), await copy(), { mode: 0o600 });
    expect(check(h)).toContain("2 open spots across 2 roles");
  });

  it("says only that it's turned off without the switch, even beside a copy, and when the switch is a link, a pipe or a folder", async () => {
    const { home: h, folder } = home(false);
    writeFileSync(join(folder, SHORTCUTS_FILE), await copy(), { mode: 0o600 });
    // Every action, each finishing within check()'s own time limit: a pipe for a switch can't hold one up.
    const off = (marker: string) => {
      expect(check(h), marker).toBe(OFF);
      expect(helper(h) ?? OFF, marker).toBe(OFF);
      expect(check(h, "open-today"), marker).toBe(`said ${OFF}`);
      expect(check(h, "open-sunday"), marker).toBe(`said ${OFF}`);
    };
    off("none");
    const marker = join(folder, SHORTCUTS_ON_FILE);
    writeFileSync(join(folder, "elsewhere"), "");
    symlinkSync(join(folder, "elsewhere"), marker);
    off("link");
    rmSync(marker);
    expect(spawnSync("/usr/bin/mkfifo", [marker]).status).toBe(0);
    off("pipe");
    rmSync(marker);
    mkdirSync(marker);
    off("folder");
  }, 120_000);

  it("reads a copy that's missing, a link, a pipe, a folder or too large as no saved check", async () => {
    const { home: h, folder } = home(true);
    const file = join(folder, SHORTCUTS_FILE);
    expect(check(h)).toBe(NO_CHECK);
    writeFileSync(join(folder, "real.json"), await copy());
    symlinkSync(join(folder, "real.json"), file);
    expect(check(h)).toBe(NO_CHECK);
    rmSync(file);
    expect(spawnSync("/usr/bin/mkfifo", [file]).status).toBe(0);
    expect(check(h)).toBe(NO_CHECK);
    rmSync(file);
    mkdirSync(file);
    expect(check(h)).toBe(NO_CHECK);
    rmSync(file, { recursive: true });
    writeFileSync(file, " ".repeat(MAX_SHARED_BYTES + 1));
    expect(check(h)).toBe(NO_CHECK);
  });

  it("opens Today or Sunday only while the switch is on, and otherwise says it's turned off", () => {
    const on = home(true).home, off = home(false).home;
    expect(check(on, "open-today")).toBe("link ozzie://today");
    expect(check(on, "open-sunday")).toBe("link ozzie://sunday");
    expect(check(off, "open-today")).toBe(`said ${OFF}`);
    expect(check(off, "open-sunday")).toBe(`said ${OFF}`);
  });

  it("opens a page in the Ozzie that holds the actions: three folders up from the extension, with or without a trailing slash", () => {
    // The opening itself (NSWorkspace) is checked by hand on an installed copy.
    for (const app of ["/x/Ozzie.app", "/x/My Apps/Ozzie.app"]) {
      for (const appex of [`${app}/Contents/Extensions/OzzieIntents.appex`, `${app}/Contents/Extensions/OzzieIntents.appex/`]) {
        expect(check(appex, "ozzie"), appex).toBe(app);
      }
    }
  });

  it("writes nothing", async () => {
    const { home: h, folder } = home(true);
    writeFileSync(join(folder, SHORTCUTS_FILE), await copy(), { mode: 0o600 });
    const before = readdirSync(folder).sort();
    for (const what of ["sunday", "open-today", "open-sunday"]) check(h, what);
    expect(readdirSync(folder).sort()).toEqual(before);
    expect(readdirSync(h)).toEqual(["Library"]);
  });
});
