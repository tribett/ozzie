// "Copy a report" (onboarding spec §4.3, P6): a fixture full of names, a church name, plan titles, team names and a
// key-like string, put everywhere the report takes a value, yields a report with none of them; only fixed code words,
// versions and times. Native's own report is used only when every line is a known `word: code`. Fictional data only.
import { describe, expect, it } from "vitest";
import { buildReport, nativeReportLines, type ReportInput } from "../src/setup-report.js";

const CHURCH = "Grace Fellowship of Springfield";
const ORG = "123456";
const NAMES = ["Riley Thornbury", "Zoë Alvarez", "José Núñez", "Pat Example"];
const PLANS = ["Advent 1", "Ozzie Demo — Main Sunday (fictional)"];
const TEAMS = ["Nursery", "Kids Check-In", "Worship Band"];
// Key-shaped fakes, built from parts at run time so no credential-shaped literal sits in the source (the public export's
// secret scan reads it); each is still the full shape a real key has, which is what the report must never hold.
const KEY = ["sk", "proj", "AbCdEf0123456789xyzXYZ0123456789abcdEFGH"].join("-");
const LOWER_KEY = ["sk", "ant", "api03", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
const GOOGLE_KEY = ["AIza", "SyD-fictional0123456789abcdefghijk"].join("");
const SECRETS = [CHURCH, ORG, ...NAMES, ...PLANS, ...TEAMS, KEY, LOWER_KEY, GOOGLE_KEY];
const never = [CHURCH, ...NAMES, ...PLANS, ...TEAMS];

const CLEAN: ReportInput = {
  app: { version: "0.2.0", macos: "15.5", chip: "Apple M2 Pro", memory_gb: 16 },
  rows: { planning_center: "connected", service: "watching", ai: "ready", notices: "allowed", start_with_mac: "on", phone: "on" },
  ai_route: "own", ai_company: "openai", local_ai: false,
  last_check: { outcome: "complete", at_ms: Date.parse("2026-11-17T15:12:30Z") },
  checked_at_ms: Date.parse("2026-11-17T15:14:00Z"),
  scopes: "services-and-operations+check-ins",
  native: "planning_center: connected\nai_route: own\nai_provider: openai\nnotices: allowed\nstart_with_mac: on\nmemory_gb: 16",
  never,
};

describe("the setup report", () => {
  it("is codes, versions and times, one `word: code` a line", () => {
    const report = buildReport(CLEAN);
    expect(report).toBe([
      "ozzie-setup-report: 1", "app: 0.2.0", "macos: 15.5", "chip: apple-m2-pro", "memory-gb: 16",
      "planning-center: connected", "service: watching", "ai: ready", "notices: allowed", "start-with-mac: on", "phone: on",
      "ai-route: own", "ai-company: openai", "local-ai: no", "last-check: complete", "last-check-at: 2026-11-17T15:12Z", "checked-at: 2026-11-17T15:14Z",
      "scopes: services-and-operations+check-ins",
      "from-native: yes", "planning-center: connected", "ai-route: own", "ai-company: openai", "notices: allowed", "start-with-mac: on", "memory-gb: 16",
    ].join("\n") + "\n");
    for (const line of report.trim().split("\n")) expect(line).toMatch(/^[a-z][a-z-]*: [a-z0-9][a-z0-9.+:-]*(?:T[0-9:]+Z)?$/u);
  });

  it("carries none of a fixture's names, church, plan titles, team names or keys, wherever they were put", () => {
    // Every value the report takes, filled with something it must never say.
    const dirty = (s: string): ReportInput => ({
      app: { version: s, macos: s, chip: s, memory_gb: Number(ORG) * 1000 },
      rows: { planning_center: s, service: s, ai: s, notices: s, start_with_mac: s, phone: s } as never,
      ai_route: s as never, ai_company: s as never, ai_host: s, local_ai: s as never,
      last_check: { outcome: s, at_ms: Date.parse("2026-11-17T15:12:00Z") }, checked_at_ms: Date.parse("2026-11-17T15:14:00Z"),
      scopes: s, native: `planning_center: connected\nchurch: ${s}`, never,
    });
    for (const s of SECRETS) {
      const report = buildReport(dirty(s));
      for (const secret of SECRETS) expect(report.toLowerCase(), `${s} → ${secret}`).not.toContain(secret.toLowerCase());
      expect(report).toContain("from-native: left-out");
    }
  });

  it("keeps native's own report as native writes it (ai_setup.rs `report`), connected or not", () => {
    // Native's own test fixture, line for line (ai_setup.rs, 1da3be72): every key is the page's, so nothing is dropped.
    const connected = "app: 0.2.1\nmacos: 26.1\nchip: apple-m2-pro\nmemory-gb: 16\nplanning-center: connected\nservice: watching\nai: ready\nai-route: own\nai-company: other\nlocal-ai: yes\nnotices: unknown\nstart-with-mac: on\nscopes: services+check-ins";
    expect(nativeReportLines(connected)).toEqual(connected.split("\n"));
    // Not connected: native says "scopes: none", which must not drop the rest.
    const none = "app: 0.2.1\nmacos: 26.1\nplanning-center: not-connected\nservice: none\nai: none\nai-route: none\nai-company: none\nlocal-ai: unknown\nnotices: unknown\nstart-with-mac: off\nscopes: none";
    expect(nativeReportLines(none)).toEqual(none.split("\n"));
    const report = buildReport({ ...CLEAN, native: none });
    expect(report).toContain("from-native: yes");
    expect(report).not.toContain("from-native: left-out");
  });

  it("leaves native's report out whole when any line isn't a known word with a code", () => {
    expect(nativeReportLines("planning_center: connected\nai: ready")).toEqual(["planning-center: connected", "ai: ready"]);
    for (const bad of [
      `ai: ready\nkey: ${KEY}`, `ai: ready\nchurch: ${CHURCH}`, `organization: ${ORG}`, "ai: ready\nnotes: something else entirely", "ai ready",
      `ai-host: ${LOWER_KEY}.example.org`, "app: 0.2.0\nplan: 92902197", "ai: Ready", `team: ${TEAMS[0]}`, "chip: apple-m2 pro",
    ]) expect(nativeReportLines(bad), bad).toBeNull();
    // A host that names the church is left out even though it's shaped like a host.
    expect(nativeReportLines("ai-host: ai.gracefellowship.org", ["Gracefellowship"])).toBeNull();
    expect(nativeReportLines("")).toEqual([]);
    expect(nativeReportLines(null)).toEqual([]);
  });

  it("names a host only for Another AI company, and never one that names the church", () => {
    const other = (host: string) => buildReport({ ...CLEAN, native: null, ai_company: "other", ai_host: host });
    expect(other("api.together.xyz")).toContain("ai-host: api.together.xyz");
    expect(other("ai.gracefellowship.org")).not.toContain("ai-host");
    expect(other("ai.grace.org")).not.toContain("ai-host");
    expect(other("api.planningcenteronline.com")).not.toContain("ai-host");
    expect(other("https://api.together.xyz/v1")).not.toContain("ai-host");
    // A key pasted into the address can't ride out in it.
    expect(other(`${LOWER_KEY}.example.org`)).not.toContain("ai-host");
    expect(other("sk-proj-abc.example.org")).not.toContain("ai-host");
    expect(buildReport({ ...CLEAN, native: null, ai_host: "api.together.xyz" })).not.toContain("ai-host");
    expect(buildReport({ ...CLEAN, native: null, ai_route: "local", ai_company: "other", ai_host: "api.together.xyz" })).not.toMatch(/ai-host|ai-company/u);
  });

  it("says unknown, or nothing, for what isn't known", () => {
    const report = buildReport({ rows: { planning_center: "unknown", service: "none", ai: "none", notices: "unknown", start_with_mac: "unknown" }, ai_route: "none" });
    expect(report).toBe([
      "ozzie-setup-report: 1", "planning-center: unknown", "service: none", "ai: none", "notices: unknown", "start-with-mac: unknown",
      "ai-route: none", "local-ai: unknown",
    ].join("\n") + "\n");
  });
});
