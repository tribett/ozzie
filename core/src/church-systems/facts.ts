// The "also read" facts from another church system, the sibling of core/src/church-reads: groups with how many
// members, events with how many attended, forms with how many submissions. Pure: no I/O, no clock, no model.
// Each fact carries its source, check time and how its read ended. A count is never a guessed zero: when it is null,
// `why_null` says whether the system doesn't give it, Ozzie doesn't read it yet, or its read didn't finish.
// Ids only: names and labels resolve on this Mac through placeholders.ts.
import { instant, isKnownZone, SYSTEMS, type CapturePart, type ReadOutcome, type SystemCapture, type SystemId } from "./types.js";

/** How the reads for one part of the capture ended; "not-read" when the capture has no read for it at all. */
/**
 * "held-for-zone": the events were placed in a zone other than the one the leader confirmed (or none was confirmed), so
 * none is shown until a fresh read in the confirmed zone.
 */
export type FactOutcome = ReadOutcome | "not-read" | "held-for-zone";
export interface PartRead { outcome: FactOutcome; checked_at: string | null }
/**
 * Why a count is null. Closed: "not-given", the system doesn't give it; "not-read-yet", the system has it but Ozzie
 * doesn't read it yet; "not-checked", its read didn't finish; "not-in-newest", Ozzie counts only the newest few (for
 * Breeze, at most 5 forms a check) and didn't count this one; "not-ended", the service hadn't ended when Ozzie checked,
 * so its check-ins weren't final (Breeze's people checked in by name are read only once the service has ended);
 * "no-end-time", the system gives the service no end time, so its check-ins are never read; "upcoming", the event
 * hadn't ended when Ozzie checked, so whatever count the system gives (Genesis: 0) isn't said (live, 2026-11-19).
 */
export type NullCount = "not-given" | "not-read-yet" | "not-checked" | "not-in-newest" | "not-ended" | "no-end-time" | "upcoming";
export const NEWEST_ONLY = "not-in-newest" satisfies NullCount;
interface FactBase {
  source: string; checked_at: string | null; outcome: FactOutcome;
  /** The read was cut short: the count is at least this many. */
  at_least: boolean;
  /** Why the count is null; null when there is a count. */
  why_null: NullCount | null;
}
export interface GroupFact extends FactBase { group_id: string; members: number | null }
export interface EventFact extends FactBase { event_id: string; starts_at: string; ends_at: string | null; attendance: number | null }
export interface FormFact extends FactBase { form_id: string; submissions: number | null }
export interface SystemFacts {
  system: SystemId; source: string;
  groups: GroupFact[]; events: EventFact[]; forms: FormFact[];
  /** How the reads that list each part ended, so a page can say what wasn't checked rather than show nothing. */
  reads: { groups: PartRead; events: PartRead; forms: PartRead };
  /** How the reads that count each part's members, attendance or submissions ended ("not-read" where Ozzie has none). */
  counts: { groups: PartRead; events: PartRead; forms: PartRead };
  /** What Ozzie can't read from this system, in plain sentences (cannotSee). */
  cannot_see: readonly string[];
  /** Events are held back until the zone they were placed in is the one the leader confirmed (Genesis). */
  waiting_for_zone: boolean;
}

type Counted = "members" | "attendance" | "submissions";
/**
 * For each system, what a null count means when its reads finished. Ozzie doesn't read B1 Church's attendance yet, and
 * B1 shares form submission counts only with a key that can make changes; Ozzie doesn't read Breeze's tag sizes, form
 * entries or attendance yet.
 */
export const NULL_COUNTS: Readonly<Record<SystemId, Readonly<Record<Counted, Exclude<NullCount, "not-checked">>>>> = Object.freeze({
  b1: Object.freeze({ members: "not-given", attendance: "not-read-yet", submissions: "not-read-yet" }),
  // Breeze: tag sizes aren't read; attendance is read for the service's own event only (any other event: not yet);
  // form entries are counted for the 5 newest forms only.
  breeze: Object.freeze({ members: "not-read-yet", attendance: "not-read-yet", submissions: "not-in-newest" }),
  genesis: Object.freeze({ members: "not-given", attendance: "not-given", submissions: "not-given" }),
});

/**
 * Counts that are exact whenever there is one. Breeze gives a form's whole entry list in one answer, and native code
 * nulls every count if a request failed, so a Breeze form with a count is exact. Its entries read is cut short only
 * because Ozzie counts the 5 newest forms, which the capture can't say: that is never "at least" for a form counted.
 */
const EXACT_COUNTS: Readonly<Record<SystemId, ReadonlySet<FactPart>>> = Object.freeze({
  b1: new Set<FactPart>(), breeze: new Set<FactPart>(["forms"]), genesis: new Set<FactPart>(),
});

/**
 * Systems that give an event's attendance before it has happened (Genesis sends 0 for next week's picnic, live
 * 2026-11-19): a count is said only once the event has ended. Breeze's is read only after its service ends (native).
 */
const COUNTS_BEFORE_END: ReadonlySet<SystemId> = new Set(["genesis"]);
/** Systems whose attendance Ozzie reads for the service's own event only. */
const SERVICE_ONLY_ATTENDANCE: ReadonlySet<SystemId> = new Set(["breeze"]);

/** Worst first: a refusal, then an answer Ozzie couldn't use, then the rest of the failures, then cut short. */
const SEVERITY: readonly ReadOutcome[] = ["key-refused", "refused", "invalid-response", "not-found", "rate-limited", "timeout",
  "unreachable", "too-large", "not-requested", "truncated", "ok"];

type FactPart = Extract<CapturePart, "groups" | "events" | "forms">;
/**
 * For each system and part, the reads that list it and the reads that count it (members, attendance, submissions):
 * only reads native code makes. A count read is skipped when the list is empty, so it never decides how the list read
 * ended. Where a count comes in the list itself (B1 and Genesis groups, Genesis events), the list read
 * is also its count read; where Ozzie doesn't read a count, there is none. Every word here fills that part in READS.
 */
export const FACT_READS: Readonly<Record<SystemId, Readonly<Record<FactPart, { list: readonly string[]; count: readonly string[] }>>>> = Object.freeze({
  b1: { groups: { list: ["b1.groups"], count: ["b1.groups"] }, events: { list: ["b1.events"], count: [] },
    forms: { list: ["b1.forms"], count: [] } },
  breeze: { groups: { list: ["breeze.tags"], count: [] }, events: { list: ["breeze.events"], count: ["breeze.attendance"] },
    forms: { list: ["breeze.forms"], count: ["breeze.form_entries"] } },
  genesis: { groups: { list: ["genesis.groups"], count: ["genesis.groups"] }, events: { list: ["genesis.events"], count: ["genesis.events"] },
    forms: { list: ["genesis.forms"], count: ["genesis.form_submissions"] } },
});

function partRead(capture: SystemCapture, read_words: readonly string[]): PartRead {
  const words = new Set(read_words);
  const reads = capture.reads.filter(r => words.has(r.read));
  if (!reads.length) return { outcome: "not-read", checked_at: null };
  const outcomes = new Set(reads.map(r => r.outcome));
  return {
    outcome: SEVERITY.find(o => outcomes.has(o))!,
    checked_at: reads.map(r => r.checked_at).sort((a, b) => instant(a) - instant(b))[0]!,
  };
}

/**
 * The also-read facts in a capture from any of the three systems. `window`: only events starting in it (start
 * included, end not); a window whose times aren't explicit instants holds no event. `confirmedZone`: the zone the
 * leader confirmed in Ozzie. Where native places events in the leader's zone (Genesis), events are shown only when the
 * capture's zone is exactly that one, a zone this Mac knows; otherwise none is shown and the events read says
 * "held-for-zone". Groups and forms don't depend on the zone.
 */
export function systemFacts(capture: SystemCapture,
  options: { window?: { starts_at: string; ends_at: string }; confirmedZone?: string | null } = {}): SystemFacts {
  const source = SYSTEMS[capture.system].name;
  const nulls = NULL_COUNTS[capture.system];
  const table = FACT_READS[capture.system];
  const of = (pick: "list" | "count") => ({ groups: partRead(capture, table.groups[pick]), events: partRead(capture, table.events[pick]),
    forms: partRead(capture, table.forms[pick]) });
  const reads = of("list"), counts = of("count");
  // Reads that count and nothing else. Where the count travels in the list's own rows (the list read is also the count
  // read), a list cut short has left items out, not made the counts of the items present partial.
  const ownCount = {
    groups: partRead(capture, table.groups.count.filter(w => !table.groups.list.includes(w))),
    events: partRead(capture, table.events.count.filter(w => !table.events.list.includes(w))),
    forms: partRead(capture, table.forms.count.filter(w => !table.forms.list.includes(w))),
  };
  const finished = (read: PartRead) => read.outcome === "ok" || read.outcome === "truncated";
  // The fact carries its list read's outcome and check time; only the count carries its own read's reason.
  // Before the service's end, its check-ins aren't final yet. With no end time they are never read (no-end-time).
  const serviceEnd = capture.service?.ends_at ?? null;
  const serviceNotEnded = serviceEnd !== null && instant(capture.completed_at) < instant(serviceEnd);
  // `own`: the service's own event where a system reads attendance for it alone (Breeze); its count follows the count read.
  const base = (part: FactPart, count: number | null, counted: Counted, own = false) => {
    const list = reads[part], counter = counts[part];
    const word = own ? "not-given" : nulls[counted];
    const why_null: NullCount | null = count !== null ? null
      : !finished(list) ? "not-checked"
      : word === "not-read-yet" ? "not-read-yet"
      // The service's own check-ins, skipped because the check finished before the service ended: not final yet.
      : own && counter.outcome === "not-requested" && capture.service !== null && serviceEnd === null ? "no-end-time"
      : own && counter.outcome === "not-requested" && serviceNotEnded ? "not-ended"
      // "The system doesn't give it" only once the count read finished whole: a cut-short count read may not have reached it.
      // Counting only the newest few cuts the count read short by design: a form left out is not-in-newest, not unchecked.
      : word === "not-in-newest" && (counter.outcome === "ok" || counter.outcome === "truncated") ? "not-in-newest"
      : table[part].count.length && counter.outcome !== "ok" ? "not-checked"
      : word;
    return {
      source, checked_at: list.checked_at, outcome: list.outcome,
      // A lower bound only where the count's own read was cut short (a full page of submissions, say), and never for a
      // count that is always whole (EXACT_COUNTS).
      at_least: count !== null && ownCount[part].outcome === "truncated" && !EXACT_COUNTS[capture.system].has(part), why_null,
    };
  };
  const window = options.window ? [instant(options.window.starts_at), instant(options.window.ends_at)] as const : null;
  const inWindow = (starts_at: string) => !window || (instant(starts_at) >= window[0] && instant(starts_at) < window[1]);
  const confirmed = isKnownZone(options.confirmedZone) ? options.confirmedZone : null;
  const held = SYSTEMS[capture.system].eventsNeedZone && capture.events.length > 0 &&
    !(confirmed !== null && capture.church.time_zone === confirmed);
  if (held) {
    reads.events = { outcome: "held-for-zone", checked_at: reads.events.checked_at };
    counts.events = { outcome: "held-for-zone", checked_at: counts.events.checked_at };
  }
  return {
    system: capture.system, source, reads, counts, waiting_for_zone: held,
    groups: capture.groups.map(g => ({ group_id: g.id, members: g.members, ...base("groups", g.members, "members") })),
    events: (held ? [] : capture.events).filter(e => inWindow(e.starts_at)).map(e => {
      // Attendance only for an event that had ended when Ozzie checked: before then a count (Genesis gives 0) says
      // nothing about who came (live check 2026-11-19: "Spring Family Picnic … 0 attended" for next week's picnic).
      const upcoming = COUNTS_BEFORE_END.has(capture.system) && e.attendance !== null && instant(e.ends_at ?? e.starts_at) > instant(capture.completed_at);
      const attendance = upcoming ? null : e.attendance;
      const counted = base("events", attendance, "attendance", SERVICE_ONLY_ATTENDANCE.has(capture.system) && e.id === capture.service?.id);
      return { event_id: e.id, starts_at: e.starts_at, ends_at: e.ends_at, attendance, ...counted, ...(upcoming ? { why_null: "upcoming" as const } : {}) };
    }),
    forms: capture.forms.map(f => ({ form_id: f.id, submissions: f.submissions, ...base("forms", f.submissions, "submissions") })),
    cannot_see: cannotSee(capture.system),
  };
}

/** Breeze's API shares only what a church enters on its older Volunteers page; the newer scheduler is invisible to it. */
const NEWER_SCHEDULER = "Ozzie can't see roles or volunteers on Breeze's newer scheduling page: Breeze only shares what's on its older Volunteers page.";
const NO_SCHEDULES = (name: string) => `Ozzie can't check whether your service is covered from ${name}: it doesn't share volunteer schedules.`;
// None of the three APIs has a background-check read, but a church could keep one in a field Ozzie doesn't read: "doesn't".
const NO_CHECKS = (name: string) => `Ozzie doesn't read background checks from ${name}.`;
/**
 * What Ozzie can't read from each system, from its documented API, the live reads and what Ozzie reads of it. Closed:
 * these sentences and no others. Plain English: Ozzie reads and checks; people decide. No service is called "Sunday".
 */
const CANNOT_SEE: Readonly<Record<SystemId, readonly string[]>> = Object.freeze({
  b1: Object.freeze([
    // B1 lists a blockout only until its last day begins in UTC.
    "Ozzie can't check B1 Church blockouts that end on the day of a service once that day has begun in Greenwich time (6 pm the evening before in Chicago in winter, 7 pm in summer): B1 stops listing them then.",
    "Ozzie can't tell whether your church chose the time zone B1 Church shows, or B1 set it for you.",
    "Ozzie doesn't read attendance from B1 Church yet.",
    "Ozzie doesn't read how many times a B1 Church form was filled in: for most forms B1 shares that only with a key that can make changes.",
    // A key without forms admin sees only the forms its maker can manage.
    "Ozzie can't see every B1 Church form: it sees only the forms the person who made the key can manage, so it doesn't report your church's forms as complete.",
    // The page holds every B1 check until a zone is confirmed (coverage.ts `waiting_for_zone`); with it, native takes
    // only the times on the plan's real day, worked out from the zone.
    "Ozzie can't check a B1 Church plan until you've confirmed your church's time zone in Ozzie, whether B1 Church gives one or not.",
    // With no time typed as the service, native uses the plan's other times and records the times read cut short.
    "Ozzie checks only the times on the plan's own day that B1 marks as the service. If a plan has none marked that way, Ozzie uses the plan's other times and marks the check Worth a look.",
    "Ozzie can't trust the day B1 Church saves for a church in New Zealand, Tonga, Samoa or nearby, where B1 can save plans a day early, so it works the day out from your confirmed time zone.",
    // B1's events read returns only events of groups the key's own person belongs to.
    "Ozzie can't see B1 Church events except for groups the person who made the key belongs to and groups your church put on a shared calendar.",
    "Ozzie can't read B1 Church events that repeat, so it leaves them out.",
    // The plan picker carries B1's "prepared" flag: a plan not yet shared with volunteers (notSharedYet).
    // The plan list is read from B1's overview, which lists only plans with roles.
    "Ozzie doesn't list B1 Church plans that have no roles yet, and it marks plans that aren't shared with volunteers yet in the list of plans.",
    // B1's own support docs: "no built-in background-check feature".
    "Ozzie can't read background checks from B1 Church: B1 has no built-in background-check feature, and Ozzie doesn't read a custom field or group your church might keep one in.",
  ]),
  breeze: Object.freeze([
    NEWER_SCHEDULER,
    "Ozzie can't tell how many people a Breeze role needs when Breeze didn't share a number of people needed for that role.",
    "Ozzie can't tell from Breeze whether a volunteer who hasn't answered was sent the request: Breeze shows them only as no response.",
    "Ozzie can't place a Breeze time in an hour the clocks skip or repeat, so it can't check a service that starts in one.",
    // Breeze's event list (the service's time and name) is cached and may lag up to 15 minutes behind its site.
    "Ozzie can't see a change to a Breeze service's time or name until Breeze shares it, which can take up to 15 minutes.",
    // A volunteer on the event in no role arrives in `on_service`: counted apart, offered for no role, filling none.
    "Ozzie can't tell what a Breeze volunteer listed on the service with no role is doing, so it counts them apart and fills no role with them.",
    "Ozzie can't read blockout dates from Breeze.",
    "Ozzie can't suggest who could help from Breeze: it doesn't tie a team to each role.",
    "Ozzie can't read how many people have each tag from Breeze yet.",
    // The service's count is Breeze's check-ins of named people (type=person); anonymous head counts are another kind.
    "Ozzie doesn't count Breeze form entries beyond 5 forms, or anything for a service beyond the people checked in to it by name.",
    "Ozzie doesn't read Breeze's anonymous head counts, so a service counted only that way shows no one checked in by name.",
    NO_CHECKS("Breeze"),
  ]),
  genesis: Object.freeze([NO_SCHEDULES("Genesis"),
    "Ozzie can't place Genesis events until you tell it your church's time zone: Genesis gives their times without one.",
    "Ozzie can't place Genesis events that have no start time, so it leaves them out.",
    NO_CHECKS("Genesis")]),
});
/**
 * What Ozzie can't see in each system that bears on checking the service itself: the service page's "What I didn't
 * check" lists only these (round 4: Breeze's page listed twelve, most about tags, forms and head counts); the whole list
 * is in Settings and under "Also read".
 */
// Chosen by what each line is about, never by its place in the list (review of round 4, L6): the "also read" lines are
// about attendance, forms, events, tags, head counts, the plan list and a volunteer with no role (said as a notice).
const ALSO_READ_LINE = /attendance|form|events|tag|head count|plans that have no roles|with no role/u;
const SERVICE_CANNOT_SEE: Readonly<Record<SystemId, ReadonlySet<string>>> = Object.freeze({
  b1: new Set(CANNOT_SEE.b1.filter(l => !ALSO_READ_LINE.test(l))),
  // The number needed is said by brief.ts in its own words (numbersNotShared), for the roles it is about.
  breeze: new Set(CANNOT_SEE.breeze.filter(l => !ALSO_READ_LINE.test(l) && !/how many people a Breeze role needs/u.test(l))),
  genesis: new Set<string>(),
});
/**
 * Of those, the rare or technical ones a pastor doesn't act on (round 5): folded on the service page under "More that
 * Ozzie can't see". Chosen by subject: clock changes, Breeze's 15-minute lag, and how B1 Church's zone and day are worked
 * out once the zone is confirmed.
 */
const RARE_LINE = /clocks skip or repeat|up to 15 minutes|chose the time zone|until you've confirmed|times on the plan's own day|New Zealand/u;
/**
 * What Ozzie can't read from `system`; `"service"`: only what bears on checking the service (SERVICE_CANNOT_SEE) and a
 * pastor acts on; `"service-more"`: the rest of those, the rare or technical ones.
 */
export const cannotSee = (system: SystemId, scope?: "service" | "service-more"): readonly string[] =>
  scope === "service" ? CANNOT_SEE[system].filter(l => SERVICE_CANNOT_SEE[system].has(l) && !RARE_LINE.test(l))
    : scope === "service-more" ? CANNOT_SEE[system].filter(l => SERVICE_CANNOT_SEE[system].has(l) && RARE_LINE.test(l))
    : CANNOT_SEE[system];

/**
 * Said once, where a system shares no number of people needed for a role (Breeze's older volunteers page has none):
 * Ozzie can't say whether a role is full, so it shows who is on each one instead. `roles`: the roles without a number
 * when only some lack one; null when none has one. Never a reason the check is partial (round 4).
 */
export function numbersNotShared(system: SystemId, roles: readonly string[] | null): string {
  const name = SYSTEMS[system].name;
  if (roles === null) return `${name} doesn't share how many people each role needs, so Ozzie can't say whether a role is full. It shows who is on each one instead.`;
  const list = roles.length < 2 ? roles.join("") : `${roles.slice(0, -1).join(", ")} and ${roles.at(-1)}`;
  return `${name} didn't share how many people ${list} ${roles.length === 1 ? "needs" : "need"}, so Ozzie can't say whether ${roles.length === 1 ? "it is" : "they are"} full.`;
}

/**
 * The one plain question the page asks the leader once for this system, or null when there is none: whether a zone
 * the system gave (and this Mac knows) is the church's own, named so the leader sees what is asked; or, where the
 * system gives none (Genesis), which zone the church meets in, until the leader has given one this Mac knows
 * (`time_zone`, as in the capture or the Sunday check's result). A zone name is not personal data.
 */
export function toConfirm(system: SystemId, time_zone: string | null,
  options: { localStart?: string; source?: "system" | "person"; zoneName?: string } = {}): string | null {
  const info = SYSTEMS[system];
  const known = isKnownZone(time_zone);
  // `localStart`: this service's start in that zone, formatted by the caller ("Sunday, November 22 at 10:00 AM"), so the
  // leader sees what a yes would mean; no time math is done here. Shown only when it is one short line of weekday and
  // month names, "at", digits, AM or PM, and ", : . -" (never a name, label, markup or invisible character).
  const start = typeof options.localStart === "string" ? options.localStart.trim() : "";
  const shown = start.length > 0 && start.length <= 60 && /^[A-Za-z0-9 ,:.-]+$/u.test(start) &&
    (start.match(/[A-Za-z]+/gu) ?? []).every(word => START_WORDS.has(word)) ? ` That makes this service start at ${start}.` : "";
  // How the zone is named: the caller's everyday name for it ("Eastern Time (New York)"), when it is one short line of
  // letters, spaces and parentheses; otherwise the zone's own name.
  const given = typeof options.zoneName === "string" ? options.zoneName.trim() : "";
  const named = given.length > 0 && given.length <= 60 && /^[A-Za-z .()'-]+$/u.test(given) ? given : time_zone;
  // Where the zone came from: the capture doesn't say, so only the page can. Without it, words true either way.
  const zone = options.source === "system" ? `${info.name} says your church's time zone is ${named}.`
    : options.source === "person" ? `You gave ${named} as your church's time zone.`
    : `This check has ${named} as your church's time zone.`;
  if (info.zoneMayBeDefault && known) return `${zone}${shown} Is that right?`;
  if (info.zoneAsked && !known) return "Which time zone does your church meet in?";
  return null;
}

/** The only words a caller's formatted start time may hold, beside digits and ", : . -". */
const START_WORDS: ReadonlySet<string> = new Set(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
  "at", "AM", "PM"]);

/** What the page says while a Sunday check waits for the leader to confirm the church's time zone (`waiting_for_zone`). */
export const waitingForZone = (): string => "Ozzie is waiting for you to confirm your church's time zone before it checks this plan.";

/**
 * What the page says when the Sunday check comes back "no-roles" (coverage.ts): the service's planning was read whole
 * and has no roles. Empty for a system with no Sunday check.
 */
export function noRoles(system: SystemId): readonly string[] {
  const info = SYSTEMS[system];
  if (!info.sundayCheck) return Object.freeze([]);
  // Breeze: no roles seen can't be told apart from roles on its newer scheduling page, so it says "found no roles".
  return Object.freeze(system === "breeze" ? ["Ozzie found no roles for this service in Breeze.", NEWER_SCHEDULER]
    : [`Planning for this service has no roles in ${info.name}.`]);
}

/** What the page says beside a role whose number needed is null because the system didn't share one; null for systems with no Sunday check. */
export const unknownNeed = (system: SystemId): string | null =>
  SYSTEMS[system].sundayCheck ? `${SYSTEMS[system].name} didn't share a number of people needed for this role.` : null;

/** What the page says about the people on the service with no role (`on_service_count`); null when there are none. */
export function onServiceWithoutRole(count: number): string | null {
  if (!Number.isSafeInteger(count) || count < 1) return null;
  // "Listed": the system lists them on the service; Ozzie doesn't know what they are doing there.
  return count === 1 ? "1 person is listed on this service without a role." : `${count} people are listed on this service without a role.`;
}

/**
 * One plain sentence for the page about how a read ended, for every outcome word; null for "ok". Closed: these
 * sentences and no others, never the system's own text.
 */
export function readProblem(system: SystemId, outcome: FactOutcome): string | null {
  const name = SYSTEMS[system].name;
  switch (outcome) {
    case "ok": return null;
    case "truncated": return `Ozzie read only part of this from ${name}.`;
    case "not-requested": return `Ozzie didn't read this from ${name} this time.`;
    // Breeze: a refusal after other reads worked is that read alone; the check went on.
    case "refused": return system === "breeze" ? "Breeze didn't let Ozzie read this part." : `${name} didn't let Ozzie read this.`;
    case "not-found": return `${name} couldn't find this.`;
    // The check stops at a slow-down and nothing retries it: the leader checks again.
    case "rate-limited": return `${name} asked Ozzie to slow down, so this check stopped early. Check again in a few minutes.`;
    case "timeout": return `${name} took too long to answer.`;
    case "unreachable": return `Ozzie couldn't reach ${name}.`;
    case "too-large": return `${name} sent more than Ozzie reads at once.`;
    case "invalid-response": return `${name} sent something Ozzie couldn't read.`;
    case "key-refused": return `${name} didn't accept this key.`;
    case "not-read": return `Ozzie didn't read this from ${name}.`;
    case "held-for-zone": return "Ozzie is waiting for you to confirm your church's time zone before it shows these.";
  }
}

/**
 * The read boxes a B1 Church key needs ticked, as B1Admin groups them. One list: when the native side reports exactly
 * which boxes its reads need, this line is the only change.
 */
// Live: a key with only the groups read box gave the same full check and plan list as one with people, groups and content.
export const B1_KEY_BOXES: readonly string[] = Object.freeze(["groups"]);
const boxes = (names: readonly string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** One plain sentence for each reason a count is missing (`why_null`). Closed: these sentences and no others. */
export function whyNullSentence(system: SystemId, why: NullCount): string {
  const name = SYSTEMS[system].name;
  switch (why) {
    case "not-given": return `${name} doesn't give this number.`;
    case "not-read-yet": return `Ozzie doesn't read this number from ${name} yet.`;
    case "not-checked": return "Ozzie couldn't check this number this time.";
    // True for a form beyond the 5 newest and an archived one. A check stopped part way records why (native breeze.rs
    // `count_entries`, round 3), so a form it didn't reach is not-checked.
    case "not-in-newest": return system === "breeze" ? "Ozzie counts entries for at most 5 Breeze forms, and didn't count this one."
      : `Ozzie counts only the newest forms from ${name}, and this one wasn't among them.`;
    case "not-ended": return "The service hasn't ended yet, so check-ins aren't final.";
    case "no-end-time": return `${name} gives this service no end time, so Ozzie doesn't count the people checked in to it.`;
    case "upcoming": return "Not yet: this event hasn't happened.";
  }
}

/**
 * The label beside a plan in the plan list, from its `shared`: none when it is shared with volunteers, notSharedYet
 * when it isn't yet, and a plain "couldn't tell" when that couldn't be read. Only B1 Church says.
 */
export function sharedLabel(system: SystemId, shared: boolean | null): string | null {
  if (system !== "b1" || shared === true) return null;
  return shared === false ? notSharedYet(system) : "Ozzie couldn't tell whether this plan is shared with volunteers yet.";
}

/**
 * On the checked plan's result, when it isn't shared with volunteers yet (`plan_shared` false); null otherwise. No claim
 * about who was asked: a plan can be marked not shared after people were, and each assignment's `asked` says so.
 */
export const notSharedNotice = (system: SystemId, shared: boolean | null): string | null =>
  system === "b1" && shared === false ? "This plan isn't shared with volunteers yet in B1 Church, so they may not have seen it." : null;

/** The label beside a plan in the plan list that isn't shared with volunteers yet (B1's "prepared"); null elsewhere. */
export const notSharedYet = (system: SystemId): string | null => system === "b1" ? "Not shared with volunteers yet in B1 Church." : null;

/** What a church needs to do so Ozzie can read each system, in plain words. Closed: these sentences and no others. */
const HOW_TO_CONNECT: Readonly<Record<SystemId, readonly string[]>> = Object.freeze({
  b1: Object.freeze([
    `An admin makes an API key in B1 Church under Settings > Developer > API Keys, ticking only the read ${B1_KEY_BOXES.length === 1 ? "box" : "boxes"} for ${boxes(B1_KEY_BOXES)}: Ozzie needs nothing else.`,
    // Team lists and their names come from B1's group-member read, which needs Group Members: View.
    "Leave the key's expiry date empty, or the key stops working on that date.",
    "Make the key as a person who can view group members in B1 Church (Group Members: View): team lists and names depend on it, and the key sees only what that person can see.",
  ]),
  breeze: Object.freeze(["The account owner copies the API key from the account's API Key page in Breeze (Manage Account > API Key).",
    "Breeze is becoming Tithely Church Management, so you may see that name instead.",
    "That key can make changes in Breeze, but Ozzie only reads."]),
  genesis: Object.freeze([
    "An owner or admin makes a key in Genesis under Settings > Integrations, in the section AI Assistants & Developer API: on the API keys tab, press Create key, give the key a name, and tick Read for Groups, Events and Forms only.",
    // Genesis's Create key dialog ticks People read by default (live check 2026-11-19); Ozzie reads no names there.
    "Untick Read for People, which Genesis ticks for you: Ozzie doesn't read anyone's name from Genesis.",
    "Genesis shows the key only once, so paste it into Ozzie straight away.",
  ]),
});
export const howToConnect = (system: SystemId): readonly string[] => HOW_TO_CONNECT[system];

/**
 * A name a system gives as a slug, made readable: "visitor-connection-card" (Genesis's form names, live 2026-11-19)
 * reads "Visitor connection card". Any other name is left exactly as the church wrote it.
 */
export function readableName(name: string): string {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)+$/u.test(name) ? `${name.charAt(0).toUpperCase()}${name.slice(1).replace(/[-_]+/gu, " ")}` : name;
}
