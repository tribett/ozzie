// Ozzie's plugin for Claude's directory (product/claude-plugin/ozzie, checked and zipped by product/claude-plugin/build.ts):
// the folder passes the directory's written rules and Ozzie's own; its version is the app's; it starts only the read-only
// helper inside Ozzie for Mac, the same one "Add Ozzie to Claude" names; its words name exactly the server's four reads;
// and the three example prompts it offers are answered from the fictional check. The checks are shown to catch what they
// are for, on copies of the folder.
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundledSkills } from "../../core/src/harness/bundled-skills.js";
import { HarnessSession } from "../../core/src/harness/session.js";
import { HarnessTools } from "../../core/src/harness/tools.js";
import { McpServer, TOOLS, type Response } from "../../core/mcp/server.js";
import { sharedCheckText, sharedEnvelopes } from "../../core/mcp/snapshot.js";
import { harnessData } from "../../core/test/harness/fixtures.js";
import { appVersion, frontMatter, HELPER, PLUGIN_DIR, PLUGIN_FILES, pluginProblems, REPO, SKILL, syncVersion, zipPlugin } from "../claude-plugin/build.js";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const pluginText = (path: string) => readFileSync(join(PLUGIN_DIR, path), "utf8");
const manifest = JSON.parse(pluginText(".claude-plugin/plugin.json")) as Record<string, unknown>;
const readme = pluginText("README.md");
const skill = pluginText(`skills/${SKILL}/SKILL.md`);

/** A copy of the plugin folder to break on purpose. */
function copy(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "ozzie-plugin-")), "ozzie");
  cpSync(PLUGIN_DIR, dir, { recursive: true });
  return dir;
}

describe("the plugin folder", () => {
  it("passes every check written for the directory and for Ozzie", () => {
    expect(pluginProblems(PLUGIN_DIR, appVersion())).toEqual([]);
  });

  it("carries the app's version, in the layout the build script writes", () => {
    const version = appVersion();
    expect(manifest["version"]).toBe(version);
    expect(read("product/desktop/src-tauri/Cargo.toml")).toMatch(new RegExp(`^version = "${version.replaceAll(".", "\\.")}"$`, "mu"));
    expect(pluginText(".claude-plugin/plugin.json")).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
  });

  it("is the plugin named ozzie, by FlockConnect LLC, Apache-2.0, with the app's own icon and the repository's license", () => {
    expect(manifest).toMatchObject({ name: "ozzie", displayName: "Ozzie", license: "Apache-2.0", author: { name: "FlockConnect LLC" }, icon: "./icon.png", network: { hosts: [] } });
    expect(readFileSync(join(PLUGIN_DIR, "icon.png")).equals(readFileSync(join(REPO, "product/desktop/src-tauri/icons/icon.png")))).toBe(true);
    expect(pluginText("LICENSE")).toBe(read("core/LICENSE"));
  });
});

describe("what the plugin starts", () => {
  it("is only the read-only helper inside Ozzie for Mac, with nothing added, the same one Add Ozzie to Claude names", () => {
    expect(JSON.parse(pluginText(".mcp.json"))).toEqual({ mcpServers: { ozzie: { command: HELPER, args: [] } } });
    const bundle = JSON.parse(read("core/test/mcp/fixtures/claude-bundle.json")) as { server: { mcp_config: { command: string; args: string[] } } };
    expect(bundle.server.mcp_config).toEqual({ command: HELPER, args: [] });
    // That path is where the release app puts the helper: Ozzie.app's own folder, named as Tauri bundles it.
    const tauri = JSON.parse(read("product/desktop/src-tauri/tauri.conf.json")) as { productName: string; bundle: { externalBin: string[] } };
    expect(tauri.productName).toBe("Ozzie");
    expect(tauri.bundle.externalBin).toContain("binaries/ozzie-share");
    expect(HELPER).toBe(`/Applications/${tauri.productName}.app/Contents/MacOS/ozzie-share`);
    expect(read("product/desktop/src-tauri/src/share_helper.rs")).toContain('pub const SHARE_HELPER: &str = "ozzie-share";');
  });

  it("refuses a second program, an argument, a setting for the helper, hooks, a bin folder, or any file nobody reviewed", () => {
    const cases: [string, (dir: string) => void, RegExp][] = [
      ["a second program", d => writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { ozzie: { command: HELPER, args: [] }, more: { command: "node", args: ["x.js"] } } })), /must start exactly one thing/u],
      ["an argument", d => writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { ozzie: { command: HELPER, args: ["--write"] } } })), /must start exactly one thing/u],
      ["a setting", d => writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { ozzie: { command: HELPER, args: [], env: { OZZIE_SHARED_CHECK: "/tmp/x.json" } } } })), /must start exactly one thing/u],
      ["a launcher", d => writeFileSync(join(d, ".mcp.json"), JSON.stringify({ mcpServers: { ozzie: { command: "npx", args: ["ozzie@latest"] } } })), /launcher or shell/u],
      ["hooks", d => { mkdirSync(join(d, "hooks")); writeFileSync(join(d, "hooks/hooks.json"), "{\"hooks\":{}}"); }, /should hold exactly/u],
      ["a bin folder", d => { mkdirSync(join(d, "bin")); writeFileSync(join(d, "bin/ozzie"), "#!/bin/sh\n"); }, /bin folder/u],
      ["a Finder file", d => writeFileSync(join(d, ".DS_Store"), "x"), /system file/u],
      ["a component key", d => { const m = { ...manifest, hooks: "./hooks.json" }; writeFileSync(join(d, ".claude-plugin/plugin.json"), JSON.stringify(m)); }, /uses only its default files/u],
      ["another version", d => syncVersion(d, "9.9.9"), /the app is/u],
      ["a host", d => { const m = { ...manifest, network: { hosts: ["api.example.com"] } }; writeFileSync(join(d, ".claude-plugin/plugin.json"), JSON.stringify(m)); }, /reaches no host/u],
      ["a word people aren't shown", d => writeFileSync(join(d, "README.md"), `${readme}\nIt starts an MCP server.\n`), /README\.md uses a word/u],
      ["an em dash", d => writeFileSync(join(d, "README.md"), `${readme}\nOzzie — for churches.\n`), /dash/u],
      ["a short README", d => writeFileSync(join(d, "README.md"), "# Ozzie\n\nReads Ozzie.\n"), /at least 40/u],
      ["a skill named apart from its folder", d => writeFileSync(join(d, `skills/${SKILL}/SKILL.md`), skill.replace(`name: ${SKILL}`, "name: other")), /its folder/u],
    ];
    for (const [label, breakIt, problem] of cases) {
      const dir = copy();
      try {
        breakIt(dir);
        expect(pluginProblems(dir, appVersion()).join("\n"), label).toMatch(problem);
      } finally { rmSync(join(dir, ".."), { recursive: true, force: true }); }
    }
  });
});

describe("what the plugin says", () => {
  const titles = TOOLS.map(t => t.title);

  it("lists exactly the server's four reads, by their titles, and Claude's guidance names no other", () => {
    const section = readme.split("## What Claude can read")[1]!.split("\n## ")[0]!;
    expect([...section.matchAll(/^- \*\*([^*]+)\*\*:/gmu)].map(m => m[1])).toEqual(titles);
    const guided = skill.split("\n## ")[0]!;
    expect([...guided.matchAll(/^- \*\*([^*]+)\*\* \(`([a-z_]+)`\):/gmu)].map(m => [m[1], m[2]])).toEqual(TOOLS.map(t => [t.title, t.name]));
    // Every snake_case name in the guidance is one of the four.
    for (const m of skill.matchAll(/`([a-z]+(?:_[a-z]+)+)`/gu)) expect(TOOLS.map(t => t.name), m[1]).toContain(m[1]);
    // Claude Code and Cowork can open files: the guidance keeps Claude out of Ozzie's folder, where the names are, and
    // has it weigh the check's age itself (a copy left after Ozzie quits isn't marked out of date by the reader).
    expect(skill).toContain("don't open or search files in Ozzie's own folder on this Mac to find it");
    expect(skill).toContain("compare it with today's date. If the check is from an earlier day, say it's a past check");
    expect(readme).toContain("Ozzie keeps the names in its own folder in your Library, so don't give Claude that folder.");
    const fm = frontMatter(skill)!;
    expect(fm.get("name")).toBe(SKILL);
    expect(fm.get("description")).toMatch(/^Use when someone asks about their church's coming Sunday/u);
  });

  it("promises only what Ozzie does: read-only, labels instead of names, off until turned on, Planning Center only", () => {
    expect(readme).toContain("Claude sees labels like [Person 1] instead, and it can't change or send anything through Ozzie.");
    expect(readme).toContain("Sharing is off until you turn it on, and turning it off removes the shared copy.");
    expect(readme).toContain("Only a Planning Center check is shared. Checks of other church systems aren't.");
    // The desktop app shares only the Planning Center check (App.tsx: sharing reads pcHarnessData). If that changes, so must the README.
    expect(read("product/desktop/src/App.tsx")).toMatch(/const sharing = useSharing\(pcHarnessData,/u);
    // Every read really is read-only.
    const listed = new McpServer({ read: () => null, skills: new Map() }).handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }) as { result: { tools: { annotations: Record<string, unknown> }[] } };
    expect(listed.result.tools).toHaveLength(4);
    for (const t of listed.result.tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    // What a person reads in the Settings switch, quoted exactly.
    expect(read("product/desktop/src/connection-page.tsx")).toContain("<span>Use Ozzie's last check in other AI apps</span>");
    expect(read("product/desktop/src/connection-page.tsx")).toContain('label: "Other AI apps, Spotlight and Shortcuts"');
    expect(read("product/desktop/src/other-ai-apps-setup.tsx")).toContain('export const ADD_TO_CLAUDE = "Add Ozzie to Claude";');
    expect(read("product/desktop/src/sunday-page.tsx")).toContain(">See a fictional example</button>");
    expect(read("product/desktop/src/first-run-screens.tsx")).toContain('example: "See an example church first",');
    expect(read("core/src/service-day.ts")).toContain('export const SERVICES_PAGE = "Services";');
    expect(readme).not.toMatch(/\bfree\b|\bverified\b|\bofficial\b|\bsecure\b|\bnever leaves\b/iu);
  });

  it("offers three example prompts that the fictional check answers, with the Church rules a new install starts with", async () => {
    const prompts = [...readme.split("## Try it")[1]!.split("\n## ")[0]!.matchAll(/^- "([^"]+)"$/gmu)].map(m => m[1]!);
    // Each prompt, the read that answers it, and what that read says for the fictional check. A reviewer's fresh
    // install has the app's default rules, with no room rule.
    const answered: [string, string, RegExp[]][] = [
      ["What still needs a decision for Sunday in Ozzie's last check?", "sunday_readiness", [/For Sunday, November 22, 3 things need a decision and 5 are worth a look\./u, /\[Role 1\] at 9:30 AM still needs 1 more person/u]],
      ["Are any rooms double-booked this Sunday, or follow-ups nobody owns?", "rooms_follow_ups_groups", [/Worth a look: \[Room 1\] has bookings that overlap on November 22 from 10:45 AM to 11:00 AM/u, /\[Workflow 1\], step \[Step 1\], was due .* and has no owner\./u]],
      ["What are our Church rules in Ozzie, and when did Ozzie last check Sunday?", "church_rules", [/Your Church rules suggest a check-in after 3 weeks in a row\. They don't ask for a scheduled lead\./u, /From Ozzie's last saved check, checked 3:00 PM UTC on November 20/u]],
    ];
    expect(prompts).toEqual(answered.map(a => a[0]));
    const rules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };
    expect(read("product/desktop/src/sunday-source.ts")).toContain(`export const defaultRules: SundayRules = { sundayLeads: [], checkInAfterSundaysInARow: 3 };`);
    const data = harnessData({ rules });
    const envelopes = await sharedEnvelopes(new HarnessTools(data, new HarnessSession(), { now: () => data.capture!.completed_at }));
    const server = new McpServer({ read: () => sharedCheckText(envelopes, [], "2026-11-20T15:06:00Z", "B4K7Q2X9M3T8"), skills: await bundledSkills() });
    for (const [prompt, tool, says] of answered) {
      const r = server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: {} } }) as Response;
      const text = ((r as { result: { content: { text: string }[] } }).result.content).map(c => c.text).join("\n");
      for (const s of says) expect(text, prompt).toMatch(s);
    }
  });
});

describe("the build script", () => {
  it("sets only the version, and leaves a matching file untouched", () => {
    const dir = copy();
    try {
      const before = JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8")) as Record<string, unknown>;
      expect(syncVersion(dir, appVersion())).toBe(false);
      expect(syncVersion(dir, "9.9.9")).toBe(true);
      expect(JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8"))).toEqual({ ...before, version: "9.9.9" });
    } finally { rmSync(join(dir, ".."), { recursive: true, force: true }); }
  });

  it.skipIf(!existsSync("/usr/bin/zip") || !existsSync("/usr/bin/unzip"))("zips exactly the plugin's files, the manifest at the zip's root, as Upload plugin asks", () => {
    const out = mkdtempSync(join(tmpdir(), "ozzie-plugin-zip-"));
    try {
      expect(zipPlugin(join(out, "ozzie.zip"))).toEqual([...PLUGIN_FILES].sort());
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
