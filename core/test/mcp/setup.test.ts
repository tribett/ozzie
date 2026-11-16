// Ready-made setup for other AI apps (core/mcp/setup.ts): the exact text each app gets for a helper path, with fixed
// fictional paths. Every text starts only the helper, with no arguments; a line for Terminal is one shell word per part
// whatever the path holds (checked by running it through /bin/sh with a program that only prints its arguments); the
// file Claude opens names the same helper and the server's own four tools.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../../mcp/server.js";
import {
  CLAUDE_BUNDLE_NOTE, CLAUDE_BUNDLE_TOOLS, claudeBundleManifest, claudeBundleNote, SETUP_APP_IDS, SETUP_APPS, SETUP_NAME, setupApp, shellWord, usablePath,
} from "../../mcp/setup.js";

const HELPER = "/Applications/Ozzie.app/Contents/MacOS/ozzie-share";
const ODD = "/Applications/Church's \"Tools\" $HOME `x` \\ é/Ozzie.app/Contents/MacOS/ozzie-share";
/** What /bin/sh hands a program given this line, with the program's name replaced by one that prints its arguments. */
const argv = (line: string, program: string): string[] => {
  expect(line.startsWith(`${program} `)).toBe(true);
  const out = execFileSync("/bin/sh", ["-c", `show() { for a in "$@"; do printf '%s\\0' "$a"; done; }; show ${line.slice(program.length + 1)}`], { env: { HOME: "/nonexistent", PATH: "/usr/bin:/bin" } });
  return out.toString("utf8").split("\0").slice(0, -1);
};

describe("the list of apps", () => {
  it("has each app once, Claude first, and a last entry for any other app", () => {
    expect(SETUP_APPS.map(app => app.id)).toEqual([...SETUP_APP_IDS]);
    expect(SETUP_APPS[0]!.id).toBe("claude");
    expect(SETUP_APPS.at(-1)!.id).toBe("other");
    expect(new Set(SETUP_APPS.map(app => app.name)).size).toBe(SETUP_APPS.length);
    expect(SETUP_APPS.filter(app => app.oneClick).map(app => app.id)).toEqual(["claude"]);
    expect(setupApp("codex").name).toBe("Codex");
    expect(SETUP_APPS.filter(app => app.pathLabel).map(app => app.id)).toEqual(["other"]);
    // VS Code's `code` isn't a command in Terminal until VS Code is asked to install it (review L M2).
    expect(setupApp("vs-code").steps[0]).toContain("Shell Command: Install 'code' command in PATH");
  });

  it("gives every app steps in plain words", () => {
    for (const app of SETUP_APPS) {
      expect(app.steps.length).toBeGreaterThanOrEqual(2);
      for (const step of app.steps) {
        const words = step.replace(/`[^`]*`/gu, " ");
        expect(words, `${app.id}: ${step}`).not.toMatch(/\b(?:skills?|sessions?|agents?|logs?|connectors?|harness|MCP|servers?|JSON|stdio|protocol|config file)\b/iu);
        expect(step.split("`").length % 2, `${app.id}: backticks in pairs`).toBe(1);
      }
    }
  });
});

describe("the text for each app", () => {
  it("is the list most apps read, naming only the helper", () => {
    for (const id of ["claude", "cursor", "lm-studio", "other"] as const) {
      for (const path of [HELPER, ODD]) expect(JSON.parse(setupApp(id).text(path))).toEqual({ mcpServers: { ozzie: { command: path, args: [] } } });
    }
  });

  it("is one Terminal line that hands the app exactly the helper's path, whatever the path holds", () => {
    for (const path of [HELPER, ODD, "/a b/it's/ozzie-share", "/-rf/ozzie-share"]) {
      expect(argv(setupApp("claude-code").text(path), "claude")).toEqual(["mcp", "add", "--scope", "user", SETUP_NAME, "--", path]);
      expect(argv(setupApp("codex").text(path), "codex")).toEqual(["mcp", "add", SETUP_NAME, "--", path]);
      expect(argv(setupApp("gemini").text(path), "gemini")).toEqual(["mcp", "add", "--scope", "user", SETUP_NAME, path]);
      const code = argv(setupApp("vs-code").text(path), "code");
      expect(code.slice(0, 1)).toEqual(["--add-mcp"]);
      expect(code).toHaveLength(2);
      expect(JSON.parse(code[1]!)).toEqual({ name: "ozzie", type: "stdio", command: path });
    }
    expect(setupApp("claude-code").text(HELPER)).toBe(`claude mcp add --scope user ozzie -- '${HELPER}'`);
    expect(setupApp("codex").text(HELPER)).toBe(`codex mcp add ozzie -- '${HELPER}'`);
    for (const app of SETUP_APPS) expect(app.text(HELPER), app.id).not.toMatch(/[\r\n]\s*$/u);
  });

  it("quotes a shell word so nothing in it is run", () => {
    expect(shellWord("a'b")).toBe("'a'\\''b'");
    expect(argv(`echo ${shellWord("$(touch /nonexistent/x); `id` 'q' \\")}`, "echo")).toEqual(["$(touch /nonexistent/x); `id` 'q' \\"]);
  });

  it("is only made for a plain absolute path", () => {
    expect(usablePath(HELPER)).toBe(true);
    expect(usablePath(ODD)).toBe(true);
    for (const bad of ["", "ozzie-share", "./ozzie-share", "/a\nb", "/a\u0000b", "/a\u2028b", "/a\u0085b", "/a\u009bb", "/a/${__dirname}/b", `/${"a".repeat(1024)}`]) expect(usablePath(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("the file Claude opens", () => {
  it("names the helper inside this Ozzie, run with no arguments, on a Mac only", () => {
    const manifest = claudeBundleManifest(HELPER, "0.1.6");
    expect(manifest.server).toEqual({ type: "binary", entry_point: CLAUDE_BUNDLE_NOTE, mcp_config: { command: HELPER, args: [] } });
    expect(manifest.name).toBe("ozzie");
    expect(manifest.version).toBe("0.1.6");
    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.compatibility).toEqual({ platforms: ["darwin"] });
    expect(Object.keys(manifest)).not.toContain("user_config");
    expect(claudeBundleNote(HELPER)).toContain(HELPER);
  });

  it("is the saved example native's copy of the manifest is held to (share_bundle_tests.rs)", () => {
    const saved = JSON.parse(readFileSync(new URL("./fixtures/claude-bundle.json", import.meta.url), "utf8")) as unknown;
    expect(JSON.parse(JSON.stringify(claudeBundleManifest(HELPER, "0.0.0")))).toEqual(saved);
  });

  it("lists the server's own four tools and promises only what the copy holds", () => {
    expect(CLAUDE_BUNDLE_TOOLS.map(tool => tool.name)).toEqual(TOOLS.map(tool => tool.name));
    const manifest = claudeBundleManifest(HELPER, "0.1.6");
    const words = [manifest.description, manifest.long_description, ...manifest.tools.map(tool => tool.description)].join(" ");
    expect(words).toContain("labels like [Person 1]");
    expect(words).toContain("the names Ozzie read from Planning Center stay in Ozzie");
    expect(words).toContain("can't check Planning Center, change anything or send anything");
    expect(words).not.toMatch(/never (?:sees )?a name|background/iu);
  });
});
