// The spoken version of Today: a short plain-English script read aloud on this Mac.
// Pure: built only from the attention report, the Sunday brief and the rooms / follow-ups check
// already on screen, in the same order (needs a decision, worth a look, not checked, check times).
// It never adds a fact, never reads email or calendar text aloud, and leaves names out unless the
// person turns names on. Rooms, follow-ups and group meetings are counts only: no room, workflow or
// step name is ever spoken. The script never goes to an AI model; the native side speaks it with the
// Mac's own voice, and `<`, `>` and `&` never reach it (no markup a voice could act on).
import type { AttentionReport } from "./attention-import/index.js";
import { operationsNotChecked, type SundayOperations } from "./operations-capture.js";
import { blockoutRoles, blockoutTime, findingService, roleReasons, rolesUnchecked, rosterNeedsYou, rosterSummary, serviceOfTeam, unnumberedRoster, withServices,
  type Finding, type FindingServices, type SundayBrief, type TeamServices } from "./sunday-brief.js";
import type { DecidedBrief, DecidedItem } from "./sunday-decisions.js";
import { SUNDAY_WORDS, type DayWords } from "./service-day.js";

/** The fixed speaking rate the native voice uses, in words per minute. */
export const SPOKEN_WORDS_PER_MINUTE = 170;
/** A briefing stays within two minutes; anything more is pointed to on screen. */
export const MAX_SPOKEN_SECONDS = 120;
/** Under the native voice's 4000-character limit (MAX_SPEECH_CHARS in local_tools.rs). */
export const MAX_SPOKEN_CHARS = 3800;
/** Items read aloud per section before the rest are pointed to on screen; fewer when that's still too long. */
const PER_SECTION = 4;

export interface BriefingInput {
  attention: AttentionReport | null;
  /** Emails Today shows as "Ignored on purpose" because they contained instructions. */
  ignoredInstructions?: number;
  /** Emails and calendar items Today lists as read with nothing needed. */
  quietCount?: number;
  sunday: SundayBrief | null;
  /** The Sunday brief with the person's own decisions applied. Resolved items aren't read as open. */
  decided?: DecidedBrief | null;
  /**
   * Rooms, follow-ups and group meetings for that Sunday, as the Sunday page shows them. null: that
   * check has none of their reads (said as not checked); undefined: not part of this briefing.
   */
  operations?: SundayOperations | null;
}
export interface BriefingOptions {
  /** Sunday times, as the Sunday page shows them. */
  timeZone: string;
  /**
   * The words for the watched service's real day (service-day.ts), for when there is no brief yet ("Wednesday hasn't
   * been checked yet."). A brief's own `day` wins. Absent: the Sunday words.
   */
  day?: DayWords;
  /** Email and calendar times, as Today shows them (the import's own zone). Defaults to `timeZone`. */
  attentionTimeZone?: string;
  /**
   * When the check was made, as the Sunday page says it (this Mac's clock). Defaults to `timeZone`; set when `timeZone`
   * is a church's own zone that may not be this Mac's (round 3).
   */
  checkedTimeZone?: string;
  /** Off by default: "Someone on the Greeter team". On: names from this check, spoken on this Mac only. */
  includeNames?: boolean;
  names?: Readonly<Record<string, string>>;
  /**
   * With more than one service watched, each team's service by its own name (desktop services-merge.ts teamServices):
   * every role is said with its service ("Greeter (Youth Night)"), since one briefing speaks of every service. Absent with
   * one service, which reads as before.
   */
  teamServices?: TeamServices;
  /**
   * With more than one service watched, each finding's service by a name a person would recognise (desktop
   * services-merge.ts findingServices): a part of the check with no role to say it with opens with its service, as Ask
   * says it ("At Youth Night, one role couldn't be checked, …"). Absent with one service, which reads as before.
   */
  findingServices?: FindingServices;
}
export type SectionId = "intro" | "decisions" | "looks" | "unchecked" | "times" | "close";
export interface BriefingSection { id: SectionId; heading: string; sentences: string[] }
export interface SpokenBriefing { sections: BriefingSection[]; text: string; words: number; seconds: number }

const one = (n: number, singular: string, plural: string) => n === 1 ? `one ${singular}` : `${n} ${plural}`;
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
/** What the voice may hear: no `<`, `>` or `&`, so nothing in a source name can read as markup. */
const speakable = (s: string) => s.replace(/[<>&]/g, " ");
const plain = (s: string) => s.replace(/[  ]/g, " ");
function when(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(d);
  return plain(`${day} at ${time}`);
}
const clock = (iso: string, timeZone: string) => plain(new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(new Date(iso)));

/**
 * `d`: the service's day words; `name` it mid-sentence ("Wednesday", "this weekend"), never a fixed "Sunday" for a
 * service on another day (onboarding spec §5).
 */
interface Ctx {
  timeZone: string; nameOf: (id: string | undefined) => string | null; d: DayWords; name: string; services?: TeamServices | undefined;
  findings?: FindingServices | undefined;
}
const dayCtx = (d: DayWords) => ({ d, name: d.kind === "weekday" ? d.day : d.thisOne });
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/**
 * When a role's line has no time of its own: the service's day words ("this Wednesday"), or nothing once the role is said
 * with its own service (several services watched), whose day words are every service's ("your services").
 */
const noTime = (f: Finding, ctx: Ctx) => serviceOfTeam(f.position?.team_id, ctx.services) ? "" : ` ${ctx.d.thisOne}`;

function needsPeople(f: Finding, ctx: Ctx): string {
  const pos = f.position!;
  const at = pos.interval ? ` at the ${clock(pos.interval.starts_at, ctx.timeZone)} service` : noTime(f, ctx);
  const n = f.people?.suggestions.length ?? 0, c = f.people?.conflicts.length ?? 0, u = f.people?.unverified.length ?? 0;
  // "For this time" only when there is one: a role said with its own service may have none.
  const help = n + c === 0 ? `No one else on this team is clear${at ? " for this time" : ""}.`
    : n === 0 ? `No one else on the team is clear with no overlap found; ${c === 1 ? "one person has" : `${c} people have`} a possible conflict.`
      : `${n === 1 ? "One person" : `${n} people`} on the team could help with no overlap found${c ? `, and ${c === 1 ? "one" : c} with a possible conflict` : ""}.`;
  // People whose availability couldn't be confirmed are neither clear nor ruled out: say how many.
  const unchecked = u ? ` ${u === 1 ? "One person's" : `${u} people's`} availability couldn't be checked.` : "";
  return `${pos.name} still needs ${f.remaining === 1 ? "one more person" : `${f.remaining} more people`}${at}. ${help}${unchecked}`;
}

/** Kids team count: confirmed people only (pending isn't counted), never "adults". */
function fewConfirmed(f: Finding, ctx: Ctx): string {
  const pos = f.position!, c = f.confirmed?.length ?? 0, asked = f.asked?.length ?? 0;
  const at = pos.interval ? ` at the ${clock(pos.interval.starts_at, ctx.timeZone)} service` : noTime(f, ctx);
  const who = c === 0 ? "No confirmed people" : `Only ${one(c, "confirmed person", "confirmed people")}`;
  const more = asked ? ` ${asked === 1 ? "One more is asked but hasn't" : `${asked} more are asked but haven't`} answered.` : "";
  const unsure = f.tone === "look" ? " Planning Center doesn't show which service time some confirmed people serve, so it's worth a look." : "";
  return `${who} in ${pos.name}${at}. Your Church rules ask for at least ${f.needed ?? 2}.${more}${unsure}`;
}
/**
 * Background check: only "no current check on file" or when it runs out relative to the service's day. Never a name, even with
 * names turned on (review L3): a briefing can be heard by anyone in the room. The Sunday page shows who.
 */
function background(f: Finding, ctx: Ctx): string {
  const one = `One person on ${f.position?.name ?? "a kids team"}`;
  // With more than one service watched, the team's own service, never every service's words ("your services").
  const day = serviceOfTeam(f.position?.team_id, ctx.services) ?? ctx.name;
  switch (f.check) {
    case "expires-before-sunday": return `${one} has a background check on file that expires before ${day}.`;
    case "expires-on-sunday": return `${one} has a background check on file that expires on ${day}.`;
    default: return `${one} has no current background check on file.${f.tone === "look" ? " Your Planning Center login may not be able to see background checks." : ""}`;
  }
}
/**
 * A decision's line after "For Sunday, ": the fixed words a kids team's line opens with in lower case ("for Sunday, one
 * person on Nursery…", never "One person"); a line that opens with a role keeps the role's own name as it is.
 */
const afterFor = (text: string) => /^(?:One person on |No confirmed people |Only )/u.test(text) ? lower(text) : text;
/** A Sunday item that needs a decision, by kind. */
function decision(f: Finding, ctx: Ctx): string {
  return f.kind === "too-few-confirmed" ? fewConfirmed(f, ctx) : f.kind === "background-check" ? background(f, ctx) : needsPeople(f, ctx);
}

function look(f: Finding, ctx: Ctx, stale: boolean): string {
  const name = ctx.nameOf(f.person_id);
  const pos = f.position?.name ?? "";
  switch (f.kind) {
    case "too-few-confirmed": return fewConfirmed(f, ctx);
    case "background-check": return background(f, ctx);
    case "pending":
      // Where the request lives: Planning Center, or the system the finding came from, which may not say whether it was sent.
      return `${name ? `${name} hasn't accepted ${pos} yet.` : `Someone scheduled for ${pos} hasn't accepted yet.`} ${f.notification === "sent"
        ? "The request was sent; there's no answer yet." : f.notification === undefined && f.source ? `${f.source} doesn't say whether the request was sent.`
          : `${f.source ?? "Planning Center"} shows the request hasn't been sent yet.`}`;
    case "streak":
      // The streak finding carries no position, so none is named (no guessing from other findings).
      return `${name ?? "Someone"} has been scheduled ${f.sundays} weeks in a row. Your Church rules suggest a quick check-in.`;
    case "lead-missing":
      return `No one is scheduled to lead ${pos}${noTime(f, ctx)}. Your Church rules ask for a scheduled lead.`;
    case "lead-unverified":
      return `Ozzie couldn't confirm the scheduled lead for ${pos}, so it isn't counting it as covered.`;
    case "blockout": {
      const one = blockoutTime(f), at = one ? ` at ${clock(one.starts_at, ctx.timeZone)}` : "";
      const when = !one && (f.serving?.length ?? 0) > 1 ? "at those times" : "at that time";
      return name ? `${name} is scheduled for ${blockoutRoles(f)}${at} and has a blockout in ${f.source ?? "Planning Center"} ${when}.`
        : `Someone scheduled for ${blockoutRoles(f)}${at} has a blockout in ${f.source ?? "Planning Center"} ${when}.`;
    }
    default:
      return f.stale || stale ? `This check is out of date. Check ${f.source ?? "Planning Center"} again before relying on it.`
        // Only facts about roles as the system lists them (sunday-brief.ts role_facts): said as roles, as the page says it.
        // One role's plain reasons are read after it; more roles' are only pointed to, so the briefing stays short (and
        // within the voice's limit) however many roles a church leaves untimed. With more than one service watched, its
        // service first, as Ask says it.
        : f.role_facts ? `${rolesUnchecked(f.role_facts.roles, findingService(f.id, ctx.findings))}, so Ozzie won't call ${findingService(f.id, ctx.findings) ? "it" : ctx.name} covered.${
          f.role_facts.roles === 1 ? roleReasons(f) : " The roles and why are listed on screen."}`
        : `Part of ${ctx.d.thisOne} couldn't be checked, so Ozzie won't call ${ctx.name} covered.`;
  }
}

/**
 * Rooms, follow-ups and group meetings as counts: what needs a decision and what's worth a look. Never a name. `counted`:
 * how many items those lines stand for, as the Sunday page counts them (one line can say two follow-ups).
 */
function operationsLines(ops: SundayOperations | null | undefined, d: DayWords): { decisions: string[]; looks: string[]; counted: { decisions: number; looks: number } } {
  if (!ops || ops.stale) return { decisions: [], looks: [], counted: { decisions: 0, looks: 0 } };
  const findings = ops.result?.findings ?? [];
  const unowned = findings.filter(f => f.kind === "unowned-overdue");
  const owners = unowned.length;
  // Where to choose, named as the follow-up's card names it once it was read from Planning Center People's workflows
  // (sunday-page.tsx `nextStep`); otherwise the core's own words, which name no product.
  const where = unowned.every(f => f.evidence.some(e => e.source === "normalized-workflow")) ? "Planning Center People" : "your church tools";
  const review = findings.filter(f => f.kind === "room-overlap" && f.certainty === "confirmed").length;
  const overlaps = findings.filter(f => f.kind === "room-overlap" && f.certainty !== "confirmed").length;
  const unchecked = new Set(ops.result?.unchecked_scope_ids ?? []);
  const unsure = (ops.result?.uncertainties ?? []).some(u => u.scope_id === null || !unchecked.has(u.scope_id));
  const meetings = ops.group_meetings.length;
  const plan = d.kind === "weekday" ? `${d.day}'s plan` : "the plan";
  const decisions = [
    ...(owners ? [`${owners === 1 ? "One follow-up has" : `${owners} follow-ups have`} no owner and ${owners === 1 ? "is" : "are"} past due. Choose who will handle ${owners === 1 ? "it" : "them"} in ${where}.`] : []),
    ...(review ? [`${review === 1 ? "One room use needs" : `${review} room uses need`} review: bookings overlap in a room your Church rules say isn't shared.`] : []),
  ];
  const looks = [
    ...(overlaps ? [overlaps === 1 ? "Two room bookings overlap, and it's worth a look." : `${overlaps} pairs of room bookings overlap, and they're worth a look.`] : []),
    ...(unsure ? ["Some room or follow-up details couldn't be confirmed."] : []),
    ...(meetings ? [`${meetings === 1 ? `One person on ${plan} has` : `${meetings} people on ${plan} have`} a group meeting at the same time they serve.`] : []),
  ];
  return { decisions, looks, counted: { decisions: owners + review, looks: overlaps + (unsure ? 1 : 0) + meetings } };
}

/** Read the first few items; point to the screen for the rest so the briefing stays short. */
function bounded(items: string[], limit: number, rest: (n: number) => string): string[] {
  return items.length <= limit ? [...items] : [...items.slice(0, limit), rest(items.length - limit)];
}

/** Reads fewer items per section until the script fits two minutes and the native voice's limit. */
export function buildSpokenBriefing(input: BriefingInput, options: BriefingOptions): SpokenBriefing {
  let briefing = compose(input, options, PER_SECTION);
  for (let limit = PER_SECTION - 1; limit >= 1 && (briefing.seconds > MAX_SPOKEN_SECONDS || briefing.text.length > MAX_SPOKEN_CHARS); limit--) {
    briefing = compose(input, options, limit);
  }
  return briefing;
}

function compose(input: BriefingInput, options: BriefingOptions, limit: number): SpokenBriefing {
  const { attention, sunday } = input;
  const names = options.includeNames ? options.names ?? {} : {};
  const ctx: Ctx = {
    timeZone: options.timeZone, ...dayCtx(sunday?.day ?? options.day ?? SUNDAY_WORDS), services: options.teamServices, findings: options.findingServices,
    nameOf: id => id && Object.hasOwn(names, id) && typeof names[id] === "string" && names[id]!.trim() ? names[id]!.trim() : null,
  };
  // With more than one service watched, each role with its service: one briefing speaks of every service.
  const items: DecidedItem[] = (sunday ? input.decided?.items ?? sunday.findings.map(finding => ({ finding, state: "open" as const, decision: null, changes: [] })) : [])
    .map(i => options.teamServices ? { ...i, finding: withServices(i.finding, options.teamServices) } : i);
  const open = items.filter(i => i.state !== "resolved");
  const resolved = items.length - open.length;
  const again = (i: DecidedItem, text: string) => i.state === "reopened" ? `This needs attention again: ${text}` : text;

  const decisions: string[] = [];
  const looks: string[] = [];
  for (const f of attention?.findings ?? []) {
    const text = `${f.title} ${f.statement} ${f.communication} Next step: ${lower(f.next_step)}`;
    (f.uncertain ? looks : decisions).push(f.uncertain ? `Worth a look: ${text}` : text);
  }
  const sundayDecisions = open.filter(i => i.finding.tone === "decision")
    .map((i, n) => again(i, n === 0 && i.state !== "reopened" ? `For ${ctx.name}, ${afterFor(decision(i.finding, ctx))}` : decision(i.finding, ctx)));
  decisions.push(...sundayDecisions);
  const operations = sunday ? operationsLines(input.operations, ctx.d) : { decisions: [], looks: [], counted: { decisions: 0, looks: 0 } };
  decisions.push(...operations.decisions);
  const decisionLines = bounded(decisions, limit, n => `And ${n} more that ${n === 1 ? "needs" : "need"} a decision, listed on screen.`);
  if (resolved) decisionLines.push(ctx.d.kind === "weekday" ? `You already decided ${one(resolved, `${ctx.d.day} item`, `${ctx.d.day} items`)}, for ${ctx.d.thisOne} only.`
    : `You already decided ${one(resolved, "item", "items")}, for ${ctx.d.thisOne} only.`);
  // Ozzie's voice throughout: the tool is never a person, so never "I" (round 5). A church system that shares no number
  // needed (Breeze) is never "nothing needs a decision": who is listed, and that Ozzie can't say it is covered.
  const roster = sunday ? unnumberedRoster(sunday) : null;
  if (!decisionLines.length) decisionLines.push(roster
    ? `For ${ctx.name}, ${rosterSummary(roster).charAt(0).toLowerCase()}${rosterSummary(roster).slice(1)} ${sunday?.source ?? "The church system"} doesn't share how many people each role needs, so Ozzie can't say whether ${ctx.name} is covered.`
    : "Nothing Ozzie read needs a decision.");

  looks.push(...open.filter(i => i.finding.tone === "look").map(i => again(i, look(i.finding, ctx, Boolean(sunday?.stale)))));
  // A role nobody has said yes to, on such a service: said as a fact, with no names.
  if (roster) for (const r of rosterNeedsYou(roster).filter(r => !r.waiting.length)) {
    looks.push(r.declined.length ? `Nobody on ${r.name} has said yes: ${one(r.declined.length, "person", "people")} said no.` : `Nobody is listed on ${r.name} yet.`);
  }
  looks.push(...operations.looks);
  const lookLines = bounded(looks, limit, n => `And ${n} more worth a look, listed on screen.`);
  if (input.ignoredInstructions) lookLines.push(`Ozzie ignored ${one(input.ignoredInstructions, "email", "emails")} that contained instructions. It never follows instructions found inside email, and nothing was done.`);
  if (input.quietCount) lookLines.push(`Ozzie read ${input.quietCount} other ${input.quietCount === 1 ? "email or calendar item" : "emails and calendar items"}. Nothing is needed from you there.`);

  const unchecked = bounded([
    ...(sunday ? sunday.not_checked : [`${capital(ctx.name)} hasn't been checked yet.`]),
    ...(sunday && input.operations !== undefined ? input.operations ? input.operations.not_checked : operationsNotChecked(null) : []),
    ...(attention ? attention.gaps : ["No email or calendar was read."]),
  ], limit, n => `And ${n} more ${n === 1 ? "thing" : "things"} Ozzie couldn't check, listed on screen.`);
  const times: string[] = [];
  const mailZone = options.attentionTimeZone ?? ctx.timeZone;
  if (attention) times.push(attention.kind === "fictional-import"
    ? `The email and calendar items are the fictional example, imported ${when(attention.imported_at, mailZone)}. No mailbox was read.`
    : `Email and calendar were read ${when(attention.imported_at, mailZone)}.`);
  if (sunday) {
    const at = when(sunday.checked_at ?? sunday.completed_at, options.checkedTimeZone ?? ctx.timeZone);
    times.push(sunday.mode === "fictional" ? `The ${ctx.d.kind === "weekday" ? `${ctx.d.day} ` : ""}check is the fictional example, read ${at}.`
      : sunday.mode === "recording" ? `${capital(ctx.name)} comes from the saved copy of a check made ${at}. It isn't a fresh check.`
        : `${sunday.source ?? "Planning Center"} was checked ${at}.${sunday.stale ? " That's more than 30 minutes ago, so it may not be current." : ""}`);
  }

  // Items, not lines: each follow-up, room and group meeting counts as on the Sunday page and Today (live review 2026-11-18).
  const decided = decisions.length - operations.decisions.length + operations.counted.decisions;
  const looked = looks.length - operations.looks.length + operations.counted.looks;
  const summary = roster && decided === 0 ? `Ozzie can't say whether ${ctx.name} is covered${looked ? `, and ${one(looked, "is", "are")} worth a look` : ""}.`
    : decided + looked === 0 ? "Nothing Ozzie read needs you right now."
    : `${decided ? `${one(decided, "thing needs", "things need")} a decision` : "nothing needs a decision"}${looked ? `, and ${one(looked, "is", "are")} worth a look` : ""}.`;
  const sections: BriefingSection[] = ([
    { id: "intro", heading: "", sentences: [`Here is today's briefing. ${summary.charAt(0).toUpperCase()}${summary.slice(1)}`] },
    { id: "decisions", heading: "Needs a decision", sentences: decisionLines },
    { id: "looks", heading: "Worth a look", sentences: lookLines },
    { id: "unchecked", heading: "What Ozzie couldn't check", sentences: unchecked },
    { id: "times", heading: "When this was checked", sentences: times },
    { id: "close", heading: "", sentences: ["Stopping or skipping this briefing doesn't mark anything done. The details and sources are on screen."] },
  ] as BriefingSection[]).filter(s => s.sentences.length > 0).map(s => ({ ...s, sentences: s.sentences.map(speakable) }));
  const text = sections.map(s => s.sentences.join(" ")).join("\n\n");
  const words = text.split(/\s+/).filter(Boolean).length;
  return { sections, text, words, seconds: Math.round(words / SPOKEN_WORDS_PER_MINUTE * 60) };
}
