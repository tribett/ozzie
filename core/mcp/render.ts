// What each tool of the server says, in plain words: Ozzie's own sentences (core/src/harness/compose.ts, the same
// templates Ask Ozzie's answers use) for every fact in the shared tool results, with ISO times written out. Labels
// stay labels: names live only in Ozzie on the leader's Mac, and nothing here could restore them.
import type { Skill, ToolEnvelope } from "../src/harness/contract.js";
import { composeAnswer, NOT_FREE, NOT_RANKED } from "../src/harness/compose.js";
import { answerText, idsIn, VOCABULARY } from "../src/harness/fixed.js";
import { showTimes } from "../src/harness/session.js";
import { NATIVE_TOOL_ALLOWLIST } from "../src/harness/contract.js";
import type { SharedCheck, SharedTask, SharedTool } from "./snapshot.js";

/**
 * Said whenever there is no copy to show: sharing off in Ozzie, no copy yet, or a file that isn't one Ozzie wrote (missing,
 * not a regular file, too large, outside the format). One text for all of them, so the other app learns nothing about
 * which, or about any other file; and nothing urges anyone to turn sharing on, which is the leader's choice.
 */
export const NOT_SHARED = "Nothing from Ozzie is shared on this Mac right now: sharing is off in Ozzie, or there's no current check to share. Whether to share is up to the leader, in Ozzie.";
/** Labels are numbered per copy: the same label in another copy can be someone else. */
const aboutLabels = (copy: string) => "People, roles, rooms and follow-ups appear as labels such as [Person 1] and [Role 1]. Their names stay in Ozzie on the leader's Mac and are never shared. "
  + `A label means the same thing only within this copy (copy ${copy}); in another copy the same label may refer to a different person, role or room.`;
const ONLY_DESCRIBES = "This copy only describes what Ozzie read. It can't check Planning Center again or change anything, and people decide what to do.";

const COMPLETENESS: Readonly<Record<string, string>> = {
  complete: "",
  partial: "Worth a look: part of what this depends on couldn't be read, so it may be incomplete.",
  stale: "This check is out of date or a saved recording. Treat it as a past check, not how things stand now.",
  denied: "This isn't part of the church's Planning Center connection.",
};
const HEADINGS: Readonly<Record<SharedTool, string>> = {
  "sunday.overview": "Overview",
  "sunday.open_needs": "Roles that still need people",
  "sunday.pending_requests": "Requests without an answer yet",
  "sunday.rule_checkins": "Check-ins the Church rules suggest",
  "sunday.not_checked": "What this check couldn't cover",
  "rooms.conflicts": "Room bookings",
  "followups.unowned": "Follow-ups without an owner",
  "groups.clashes": "Group meetings at serving times",
  "rules.current": "Church rules",
};

const words = (text: string) => showTimes(text, null);
const when = (iso: string) => words(iso);

/** Ozzie's sentences for every fact one tool result holds, in Ozzie's order, with the closing notes once. */
export function factsText(envelope: ToolEnvelope): string[] {
  const ids = [...idsIn(envelope)].filter(id => id.startsWith("f")).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const lines: string[] = [];
  const closing = new Set<string>();
  for (let i = 0; i < ids.length; i += VOCABULARY.answer.max_facts) {
    const facts = ids.slice(i, i + VOCABULARY.answer.max_facts);
    const composed = composeAnswer(answerText({ answer: "facts", facts, draft: null }), [envelope]);
    if (composed.kind !== "facts") continue;
    for (const p of composed.paragraphs) {
      if (p === NOT_FREE || p === NOT_RANKED) closing.add(p);
      else lines.push(p);
    }
  }
  return [...lines, ...[NOT_FREE, NOT_RANKED].filter(p => closing.has(p))].map(words);
}

function section(envelope: ToolEnvelope): string {
  const head = `${HEADINGS[envelope.tool as SharedTool] ?? "From the check"} (from ${envelope.source}, checked ${when(envelope.check_time)})`;
  const note = COMPLETENESS[envelope.completeness] ?? "";
  const body = factsText(envelope);
  return [`## ${head}`, ...(note ? [note] : []), ...(body.length ? body : ["Nothing to report here."])].join("\n");
}

/** The sections for these tools from the shared check, in the given order; those it doesn't hold are left out. */
export function checkText(check: SharedCheck | null, tools: readonly SharedTool[]): string {
  if (!check) return NOT_SHARED;
  const found = tools.flatMap(t => check.envelopes.filter(e => e.tool === t));
  // The facts' own check time, never when the copy was saved: a copy saved today can hold last week's check.
  const intro = `From Ozzie's last saved check, checked ${when(check.checked_at)} (copy ${check.copy_id}). ${aboutLabels(check.copy_id)} ${ONLY_DESCRIBES}`;
  if (!found.length) return `${intro}\n\nThe last saved check doesn't include this.`;
  return [intro, ...found.map(section)].join("\n\n");
}

/** The Church rules in words, then the procedures Ozzie follows (their titles and purposes, as shown in Ozzie). */
export function rulesText(check: SharedCheck | null, skills: ReadonlyMap<string, Skill>): string {
  const rules = checkText(check, ["rules.current"]);
  const procedures = [...skills.values()].sort((a, b) => a.title.localeCompare(b.title)).map(s => `- ${s.title}: ${s.purpose}`);
  const how = ["## How Ozzie works through Sunday", "Ozzie follows these written procedures. Each one only reads what was checked; none of them sends anything or changes Planning Center.", ...procedures];
  return [rules, how.join("\n")].join("\n\n");
}

const KIND: Readonly<Record<SharedTask["kind"], string>> = { ask: "A question asked in Ozzie (the question itself is never kept)", skill: "", check: "A Sunday check of Planning Center" };
const FAILURE: Readonly<Record<string, string>> = {
  denied: "it wasn't allowed", stale: "the check was out of date", partial: "part of the check couldn't be read",
  "provider-failure": "Planning Center didn't answer", unverified: "a result couldn't be verified", "invalid-task": "it wasn't a task Ozzie runs",
  limit: "a limit was reached", timeout: "it took too long", cancelled: "it was stopped",
  egress: "a safety check stopped a message before it left the Mac", fidelity: "the answer couldn't be checked against what was read",
  transport: "the AI service couldn't be reached", "no-model": "no AI service is set up", interrupted: "Ozzie was closed while it ran",
};
const STATE: Readonly<Record<SharedTask["state"], string>> = {
  proposed: "proposed", admitted: "about to start", running: "still running", verified: "finished, and its answer was checked against what was read",
  failed: "didn't finish", cancelled: "stopped by a person",
};
const TOOL_WORDS: Readonly<Record<(typeof NATIVE_TOOL_ALLOWLIST)[number], string>> = {
  "sunday.overview": "the Sunday overview", "sunday.open_needs": "roles that need people", "sunday.who_could_help": "who is on a team",
  "sunday.pending_requests": "requests without an answer", "sunday.rule_checkins": "suggested check-ins", "sunday.not_checked": "what wasn't checked",
  "rooms.conflicts": "room bookings", "followups.unowned": "follow-ups without an owner", "groups.clashes": "group meetings",
  "today.attention": "the example email import", "rules.current": "the Church rules", "planning_center.refresh": "a fresh Planning Center check",
  "drafts.prepare_note": "a draft for a person to review",
};
const ALLOWED: ReadonlySet<string> = new Set(NATIVE_TOOL_ALLOWLIST);

function taskLine(t: SharedTask, skills: ReadonlyMap<string, Skill>): string {
  const what = t.kind === "skill" ? `Ozzie's "${skills.get(t.skill_id)?.title ?? "procedure"}" procedure` : KIND[t.kind];
  const state = t.state === "failed" ? `didn't finish: ${FAILURE[t.failure ?? ""] ?? "it stopped"}`
    : t.state === "verified" && t.kind === "check" ? "finished" : STATE[t.state];
  const read = [...new Set(t.events.filter(e => e.type === "tool").map(e => e.detail.split(" ")[0]!).filter(n => ALLOWED.has(n)))]
    .map(n => TOOL_WORDS[n as keyof typeof TOOL_WORDS]);
  const steps = t.events.filter(e => e.type === "model" && !e.detail.includes(" ")).length;
  const extra = [read.length ? `looked at ${read.join(", ")}` : "", steps ? `used ${steps} AI ${steps === 1 ? "step" : "steps"}` : ""].filter(Boolean);
  return `- ${when(t.created_at)}: ${what}. ${state.charAt(0).toUpperCase()}${state.slice(1)}.${extra.length ? ` It ${extra.join(" and ")}.` : ""}`;
}

/** Recent tasks from Ozzie's record of what it did, newest first. Never a question, an answer or a name: the record has none. */
export function happenedText(check: SharedCheck | null, skills: ReadonlyMap<string, Skill>): string {
  if (!check) return NOT_SHARED;
  const head = `What Ozzie did recently on the leader's Mac, as of ${when(check.shared_at)} when copy ${check.copy_id} was saved, newest first. Ozzie keeps only what ran and how it ended, never what was asked or answered.`;
  if (!check.tasks.length) return `${head}\n\nNothing recorded yet.`;
  return [head, check.tasks.map(t => taskLine(t, skills)).join("\n")].join("\n\n");
}
