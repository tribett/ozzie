// The command-line example (core/examples/sunday-check.ts) over its fixed fictional check: its output shape, a few
// exact lines, the same counts the app's Sunday page shows, and the launcher printing the same thing.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EXAMPLE_RULES, exampleCapture, main, sundayCheck, type CheckReport } from "../../examples/sunday-check.js";
import { sundayOperations } from "../../src/operations-capture.js";
import { buildSundayBrief, sundayShownCount } from "../../src/sunday-brief.js";
import { applyDecisions } from "../../src/sunday-decisions.js";

const text = main([]);
const lines = text.split("\n");
const report = JSON.parse(main(["--json"])) as CheckReport;

describe("the Sunday check example", () => {
  it("opens with what it is, the plan and when it was checked", () => {
    expect(lines.slice(0, 5)).toEqual([
      "Ozzie Sunday check: the fictional example",
      "A saved copy of a check of a fictional church. Nothing was read from Planning Center, nothing went to an AI model, nothing was saved.",
      "",
      "Plan: Ozzie Demo — Main Sunday (fictional), November 22, 2026",
      "Checked: Friday, November 20 at 10:00 AM EST",
    ]);
  });

  it("is shown in core/README.md as it starts, line for line, from its first line (review M, L8)", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
    const sample = /The start of its output:\n\n```\n([\s\S]*?)\n```/u.exec(readme)?.[1];
    expect(sample).toBeDefined();
    expect(text.startsWith(`${sample!}\n`)).toBe(true);
  });

  it("lists what needs a decision, then what is worth a look, then what it didn't check", () => {
    const at = (s: string) => lines.indexOf(s);
    expect(at("Needs a decision (5)")).toBeGreaterThan(0);
    expect(at("Worth a look (5)")).toBeGreaterThan(at("Needs a decision (5)"));
    expect(at("What I didn't check")).toBeGreaterThan(at("Worth a look (5)"));
    expect(text).toContain("1. Greeter still needs one more person at the 9:30 AM service. One person on the team could help with no overlap found, and one with a possible conflict. One person's availability couldn't be checked.\n"
      + "   Why I flagged this:\n   - Planning Center reports 1 remaining request for Greeter.\n");
    expect(lines).toContain("4. Follow-up needs an owner: Welcome follow-up (fictional), step \"Call a first-time guest\". Choose who will handle this follow-up in your church tools.");
    expect(lines).toContain("3. Avery Brightwater has been scheduled 3 weeks in a row. Your Church rules suggest a quick check-in.");
    expect(lines.at(-2)).toBe("- Whether someone is willing to serve isn't something Planning Center records.");
  });

  it("gives every item its source and check time", () => {
    const items = lines.filter(l => /^\d+\. /.test(l));
    const sources = lines.filter(l => l.startsWith("   Source: "));
    expect(items).toHaveLength(10);
    expect(sources).toHaveLength(10);
    expect(sources.every(l => / checked \w+day, November 20 at \d+:\d\d (AM|PM) EST$/.test(l))).toBe(true);
    for (const item of [...report.decisions, ...report.looks]) {
      expect(Object.keys(item)).toEqual(["kind", "text", "why", "source", "checked_at"]);
      expect(item.source).toMatch(/^Planning Center /);
      expect(item.checked_at).toBe("2026-11-20T15:00:00Z");
    }
  });

  it("prints the same findings as JSON with --json", () => {
    expect(Object.keys(report)).toEqual(["plan", "time_zone", "checked_at", "decisions", "looks", "not_checked"]);
    expect(report.decisions.map(d => d.kind)).toEqual(["needs-people", "needs-people", "too-few-confirmed", "unowned-overdue", "room-overlap"]);
    expect(report.looks.map(d => d.kind)).toEqual(["lead-missing", "pending", "streak", "background-check", "group-meeting"]);
    expect(report.decisions.map((d, n) => `${n + 1}. ${d.text}`).every(l => lines.includes(l))).toBe(true);
  });

  it("counts what the app's Sunday page counts, from the same check", () => {
    const capture = exampleCapture();
    const brief = buildSundayBrief(capture, EXAMPLE_RULES, capture.completed_at, true);
    const shown = sundayShownCount(applyDecisions(brief, []), sundayOperations(capture, EXAMPLE_RULES, { now: capture.completed_at }));
    const r = sundayCheck(capture, EXAMPLE_RULES);
    expect({ decisions: r.decisions.length, looks: r.looks.length }).toEqual({ decisions: shown.decisions, looks: shown.looks });
  });

  it("never names whose background check it is, and never scores or labels anyone", () => {
    const check = report.looks.find(l => l.kind === "background-check")!;
    for (const name of Object.values(exampleCapture().names)) expect(JSON.stringify(check)).not.toContain(name);
    expect(text).not.toMatch(/\bscore|at risk|drifting|\bagent\b|\bharness\b/i);
  });

  it("imports only the core, and nothing that reaches a network, a file or another program", () => {
    const source = readFileSync(fileURLToPath(new URL("../../examples/sunday-check.ts", import.meta.url)), "utf8");
    const specs = [...source.matchAll(/from\s+"([^"]+)"/g)].map(m => m[1]!);
    expect(specs.length).toBeGreaterThan(0);
    expect(specs.every(s => s.startsWith("../src/") && !s.startsWith("../src/harness/"))).toBe(true);
    expect(source).not.toMatch(/\bfetch\(|node:|process\./);
  });

  it("the launcher prints exactly what main returns", () => {
    const run = fileURLToPath(new URL("../../examples/run.mjs", import.meta.url));
    for (const args of [[], ["--json"]]) {
      const out = spawnSync(process.execPath, [run, ...args], { encoding: "utf8", timeout: 30_000 });
      expect(out.status).toBe(0);
      expect(out.stderr).toBe("");
      expect(out.stdout).toBe(main(args));
    }
  }, 60_000);
});
