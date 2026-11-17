// Ozzie's Sunday check from the command line, over a saved copy of a check of a fictional church.
// No Planning Center account, no AI model, no Keychain, no network: it loads the fictional example
// Sunday the desktop app shows under "Show the example", applies example Church rules, runs the same
// fixed check code the app runs (core/src), and returns the findings as text or JSON. Nothing is written
// anywhere; run.mjs prints what `main` returns.
//
// Every name and id below comes from core/src/fictional-sunday.ts and fictional-operations.ts: invented
// test data, no real person or church. The sentences are the core's own where it has them: the spoken
// briefing's sentence for each Sunday finding, its "Why I flagged this" lines, the rooms and follow-ups
// labels and next steps, and the "What I didn't check" lines.
import { nov22Capture, TEAMS, withFictionalBackgroundChecks } from "../src/fictional-sunday.js";
import { FICTIONAL_ROOM, withFictionalOperations } from "../src/fictional-operations.js";
import { sundayOperations, type SundayOperations } from "../src/operations-capture.js";
import { buildSpokenBriefing } from "../src/spoken-briefing.js";
import { buildSundayBrief, shownUncertainties, type Finding, type SundayBrief } from "../src/sunday-brief.js";
import type { SundayCapture, SundayRules } from "../src/sunday-capture.js";

/** Example Church rules. A church sets its own in the app; these only show what each rule adds. */
export const EXAMPLE_RULES: SundayRules = {
  sundayLeads: [{ team_id: TEAMS.nursery, lead_position: "Nursery lead" }],
  checkInAfterSundaysInARow: 3,
  rooms: [{ room_id: FICTIONAL_ROOM, exclusive: true, setup_minutes: 15 }],
  kidsTeams: [{ team_id: TEAMS.nursery, min_confirmed: 2 }],
};

/** The fictional Nov 22 Sunday with its rooms, follow-ups, group meetings and Nursery's background checks, as one saved check. */
export function exampleCapture(): SundayCapture {
  return { ...withFictionalBackgroundChecks(withFictionalOperations(nov22Capture())), kids_teams: [TEAMS.nursery] };
}

export interface CheckItem {
  /** The finding's kind in the core (sunday-brief.ts, operations-findings). */
  kind: string;
  /** What Ozzie found, in plain English. */
  text: string;
  /** "Why I flagged this": the rule and the source facts. */
  why: string[];
  /** Where the facts were read. */
  source: string;
  /** When they were read (ISO), or null when the check doesn't say. */
  checked_at: string | null;
}
export interface CheckReport {
  plan: { title: string | null; dates: string | null };
  time_zone: string | null;
  checked_at: string | null;
  decisions: CheckItem[];
  looks: CheckItem[];
  not_checked: string[];
}

const SERVICES = "Planning Center Services";
const plain = (s: string) => s.replace(/[  ]/g, " ");

/** One Sunday finding in the spoken briefing's own words (names from this check, on this Mac only). */
function sentence(brief: SundayBrief, f: Finding, names: Record<string, string>): string {
  const one = buildSpokenBriefing({ attention: null, sunday: { ...brief, findings: [f] } },
    { timeZone: brief.time_zone ?? "UTC", includeNames: true, names });
  const line = one.sections.find(s => s.id === (f.tone === "decision" ? "decisions" : "looks"))!.sentences[0]!;
  // The briefing opens its first Sunday decision with "For Sunday, "; each item here stands alone.
  return line.startsWith("For Sunday, ") ? line.charAt(12).toUpperCase() + line.slice(13) : line;
}

function earliest(times: string[]): string | null {
  return [...times].sort()[0] ?? null;
}

/** Rooms, follow-ups and group meetings, with the core's labels and next steps. Names and labels are local only. */
function operationsItems(ops: SundayOperations, names: Record<string, string>): { decisions: CheckItem[]; looks: CheckItem[] } {
  const decisions: CheckItem[] = [], looks: CheckItem[] = [];
  const label = (id: string) => ops.labels[id] ?? "A room or follow-up";
  for (const f of ops.result?.findings ?? []) {
    const checked_at = earliest(f.evidence.map(e => e.check_time));
    if (f.kind === "unowned-overdue") {
      decisions.push({
        kind: f.kind, text: `${f.label}: ${label(f.workflow_id)}, step "${label(f.step_id)}". ${f.next_action}`,
        why: ["Planning Center People shows this follow-up past due with no one assigned."], source: "Planning Center People (workflows)", checked_at,
      });
    } else {
      const item = {
        kind: f.kind, text: `${f.label}: two bookings overlap in ${label(f.resource_id)}. ${f.next_action}`,
        why: [f.certainty === "confirmed" ? "Your Church rules say this room isn't shared, and Planning Center Calendar shows the bookings overlapping."
          : "Planning Center Calendar shows the bookings overlapping, and no Church rule settles whether the room can be shared."],
        source: "Planning Center Calendar", checked_at,
      };
      (f.certainty === "confirmed" ? decisions : looks).push(item);
    }
  }
  if (shownUncertainties(ops.result).length) {
    looks.push({ kind: "uncertainty", text: "Some room or follow-up details couldn't be confirmed.", why: [], source: "Planning Center Calendar and People", checked_at: ops.checked_at });
  }
  for (const m of ops.group_meetings) {
    const who = names[m.person_id] ?? "Someone on Sunday's plan";
    const what = m.serving.map(s => s.position).filter(p => p !== null).join(", ");
    looks.push({
      kind: "group-meeting", text: `${who} has a group meeting at the same time they serve${what ? ` (${what})` : ""}.`,
      why: ["Planning Center Groups shows a group meeting during this person's serving time in Services. This is a schedule fact, not a judgment about anyone."],
      source: "Planning Center Groups and Services", checked_at: m.checked_at,
    });
  }
  return { decisions, looks };
}

/** Runs the check over a capture: the same fixed functions the app runs, evaluated as of the capture's own time. */
export function sundayCheck(capture: SundayCapture, rules: SundayRules): CheckReport {
  const brief = buildSundayBrief(capture, rules, capture.completed_at, true);
  const ops = sundayOperations(capture, rules, { now: capture.completed_at });
  const names = capture.names;
  const item = (f: Finding): CheckItem => ({
    kind: f.kind, text: sentence(brief, f, names), why: f.why, source: f.source ?? SERVICES, checked_at: f.checked_at ?? brief.checked_at,
  });
  const extra = ops ? operationsItems(ops, names) : { decisions: [], looks: [] };
  return {
    plan: { title: brief.plan.title, dates: brief.plan.dates },
    time_zone: brief.time_zone,
    checked_at: brief.checked_at,
    decisions: [...brief.findings.filter(f => f.tone === "decision").map(item), ...extra.decisions],
    looks: [...brief.findings.filter(f => f.tone === "look").map(item), ...extra.looks],
    not_checked: [...brief.not_checked, ...(ops?.not_checked ?? [])],
  };
}

function when(iso: string | null, zone: string | null): string {
  if (!iso) return "time not recorded";
  return plain(new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: zone ?? "UTC", timeZoneName: "short",
  }).format(new Date(iso)));
}

/** The report as plain text: needs a decision, worth a look, each with why, source and check time; then what wasn't checked. */
export function renderReport(report: CheckReport): string {
  const out: string[] = [
    "Ozzie Sunday check: the fictional example",
    "A saved copy of a check of a fictional church. Nothing was read from Planning Center, nothing went to an AI model, nothing was saved.",
    "",
    `Plan: ${report.plan.title ?? "Untitled plan"}${report.plan.dates ? `, ${report.plan.dates}` : ""}`,
    `Checked: ${when(report.checked_at, report.time_zone)}`,
  ];
  const section = (heading: string, items: CheckItem[]) => {
    out.push("", `${heading} (${items.length})`);
    if (!items.length) out.push("  Nothing here.");
    items.forEach((it, n) => {
      out.push("", `${n + 1}. ${it.text}`);
      if (it.why.length) out.push("   Why I flagged this:", ...it.why.map(w => `   - ${w}`));
      out.push(`   Source: ${it.source}, checked ${when(it.checked_at, report.time_zone)}`);
    });
  };
  section("Needs a decision", report.decisions);
  section("Worth a look", report.looks);
  out.push("", "What I didn't check", ...report.not_checked.map(l => `- ${l}`));
  return out.join("\n") + "\n";
}

/** The command: `--json` for the report as JSON, otherwise plain text. Returns what to print; never prints or writes. */
export function main(args: readonly string[]): string {
  const report = sundayCheck(exampleCapture(), EXAMPLE_RULES);
  return args.includes("--json") ? JSON.stringify(report, null, 2) + "\n" : renderReport(report);
}
