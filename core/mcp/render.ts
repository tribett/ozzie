// What each tool of the server says, in plain words: Ozzie's own sentences (core/src/harness/compose.ts, the same
// templates Ask Ozzie's answers use) for every fact in the shared tool results, with ISO times written out. Labels
// stay labels: names live only in Ozzie on the leader's Mac, and nothing here could restore them.
import type { Skill, ToolEnvelope } from "../src/harness/contract.js";
import { composeFacts, NOT_FREE, NOT_RANKED, overviewRowSources } from "../src/harness/compose.js";
import { idsIn } from "../src/harness/fixed.js";
import { showTimes } from "../src/harness/session.js";
import { NATIVE_TOOL_ALLOWLIST } from "../src/harness/contract.js";
import { isoMillis } from "../src/harness/fixed.js";
import { LIVE_CHECK_VALID_MS } from "../src/sunday-capture.js";
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
  stale: "This check is out of date, or it is a saved copy of a check. Treat it as a past check, not how things stand now.",
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

/**
 * Ozzie's sentences for every fact one tool result holds, in Ozzie's order, with the closing notes once. All of them in
 * one piece (composeFacts), however many: the overview's rows are grouped once under its sentence, and a count that only
 * repeats the rows listed in full isn't said, as in Ask.
 */
export function factsText(envelope: ToolEnvelope): string[] {
  const ids = [...idsIn(envelope)].filter(id => id.startsWith("f")).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const paragraphs = composeFacts(ids, [envelope]);
  const lines = paragraphs.filter(p => p !== NOT_FREE && p !== NOT_RANKED);
  return [...lines, ...[NOT_FREE, NOT_RANKED].filter(p => paragraphs.includes(p))].map(words);
}

/** Each Planning Center product's own result in a copy, where the overview's rows about it are said in full. */
const OWN_TOOL: Readonly<Record<string, string>> = {
  "Planning Center Calendar": "rooms.conflicts", "Planning Center People": "followups.unowned", "Planning Center Groups": "groups.clashes",
};
/**
 * Where a section's facts come from, with check times: the result's own source, and for the overview each source its
 * rooms, follow-ups and group meetings come from (review item 5), at that source's own check time when the copy holds its
 * result. Sources checked at the same time are said once: "Planning Center Services, Calendar and People, checked …".
 */
function sourcesOf(envelope: ToolEnvelope, all: readonly ToolEnvelope[]): string {
  const own = (source: string) => all.find(e => e.tool === OWN_TOOL[source] && e.completeness !== "denied");
  const worth = (source: string) => Number((own(source)?.payload as { worth_a_look?: unknown } | undefined)?.worth_a_look) > 0;
  // The row for room or follow-up details that couldn't be confirmed is about whichever of the two has open questions.
  const unsure = ["Planning Center Calendar", "Planning Center People"].filter(worth);
  const rows = envelope.tool === "sunday.overview" ? (envelope.payload as { findings?: unknown }).findings : null;
  const extra = Array.isArray(rows) ? rows.flatMap(r => overviewRowSources(r as Record<string, unknown>, unsure.length ? unsure : ["Planning Center Calendar", "Planning Center People"])) : [];
  const times = new Map<string, string[]>();
  for (const source of [envelope.source, ...new Set(extra)].filter((s, i, list) => list.indexOf(s) === i)) {
    const at = when(own(source)?.check_time ?? envelope.check_time);
    times.set(at, [...times.get(at) ?? [], source]);
  }
  const PC = "Planning Center ";
  const named = (sources: string[]) => sources.every(s => s.startsWith(PC)) && sources.length > 1
    ? `${PC}${sources.slice(0, -1).map(s => s.slice(PC.length)).join(", ")} and ${sources.at(-1)!.slice(PC.length)}` : sources.join(", ");
  return [...times].map(([at, sources]) => `${named(sources)}, checked ${at}`).join("; ");
}

/** The Church rules' own source (tools.ts `#rules`): settings on this Mac, never a read of Planning Center. */
const RULES_SOURCE = "Church rules on this Mac";
/**
 * How complete a result is said to be, decided again each time the copy is read. Ozzie marks a result out of date only
 * when it writes the copy, and a copy left behind (Ozzie quit, or this Mac asleep) is never written again, so the reader
 * says a live check's result is out of date once its own check time is older than the limit Ozzie writes with (tools.ts
 * `#stale`, sunday-capture.ts LIVE_CHECK_VALID_MS), in the copy's own words. As when written: the fictional example
 * (the overview's `mode`) is never out of date, a saved copy already is, and the Church rules on this Mac are no read
 * of Planning Center. Nothing is added to the copy; `now` is this Mac's clock when the copy is read.
 */
function completenessAt(envelope: ToolEnvelope, all: readonly ToolEnvelope[], now: number): string {
  const c = envelope.completeness;
  if (c !== "complete" && c !== "partial") return c;
  if (envelope.source === RULES_SOURCE) return c;
  // Only a live check ages, as tools.ts #stale has it (the overview's `mode`; every copy of a check holds the overview).
  const mode = (all.find(e => e.tool === "sunday.overview")?.payload as { mode?: unknown } | undefined)?.mode;
  if (mode !== "live") return c;
  const checked = isoMillis(envelope.check_time);
  return checked !== null && now > checked + LIVE_CHECK_VALID_MS ? "stale" : c;
}

function section(envelope: ToolEnvelope, all: readonly ToolEnvelope[] = [envelope], now = Date.now()): string {
  const head = `${HEADINGS[envelope.tool as SharedTool] ?? "From the check"} (from ${sourcesOf(envelope, all)})`;
  // An overview cut to fit is said as that, never as reads that didn't complete unless some didn't (review item 6).
  const p = envelope.payload as { left_out_for_length?: unknown; reads_not_completed?: unknown };
  const left = envelope.tool === "sunday.overview" && typeof p.left_out_for_length === "number" ? p.left_out_for_length : 0;
  const cut = left > 0 ? `Worth a look: the list was too long to say in full, so ${left === 1 ? "1 finding was" : `${left} findings were`} left out of this copy.` : "";
  const completeness = completenessAt(envelope, all, now);
  const unread = completeness === "partial" && left > 0 && p.reads_not_completed === 0 ? "" : COMPLETENESS[completeness] ?? "";
  const note = [unread, cut].filter(Boolean).join("\n");
  const body = factsText(envelope);
  return [`## ${head}`, ...(note ? [note] : []), ...(body.length ? body : ["Nothing to report here."])].join("\n");
}

/**
 * The sections for these tools from the shared check, in the given order; those it doesn't hold are left out. `now`: this
 * Mac's clock as the copy is read (completenessAt).
 */
export function checkText(check: SharedCheck | null, tools: readonly SharedTool[], now = Date.now()): string {
  if (!check) return NOT_SHARED;
  const found = tools.flatMap(t => check.envelopes.filter(e => e.tool === t));
  // The facts' own check time, never when the copy was saved: a copy saved today can hold last week's check.
  const intro = `From Ozzie's last saved check, checked ${when(check.checked_at)} (copy ${check.copy_id}). ${aboutLabels(check.copy_id)} ${ONLY_DESCRIBES}`;
  if (!found.length) return `${intro}\n\nThe last saved check doesn't include this.`;
  return [intro, ...found.map(e => section(e, check.envelopes, now))].join("\n\n");
}

/** The Church rules in words, then the procedures Ozzie follows (their titles and purposes, as shown in Ozzie). */
export function rulesText(check: SharedCheck | null, skills: ReadonlyMap<string, Skill>, now = Date.now()): string {
  const rules = checkText(check, ["rules.current"], now);
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
  "invalid-arguments": "the AI asked to look something up in a way Ozzie doesn't allow",
};
/**
 * A fidelity failure whose AI step ended because the answer listed more facts than Ozzie checks in one answer (native step
 * outcome `too-many-facts`): every id it chose was one Ozzie had read, so "couldn't be checked" would be untrue (review L5).
 */
const TOO_MANY_FACTS = "the AI's answer listed more facts than Ozzie checks in one answer";
const tooManyFacts = (t: SharedTask) => t.failure === "fidelity" && t.events.some(e => e.type === "model" && /^[1-9]\d? too-many-facts$/u.test(e.detail));
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
  const state = t.state === "failed" ? `didn't finish: ${tooManyFacts(t) ? TOO_MANY_FACTS : FAILURE[t.failure ?? ""] ?? "it stopped"}`
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
