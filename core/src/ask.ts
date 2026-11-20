// Ask Ozzie: a leader asks about what Ozzie has already read. This is the second placeholder
// boundary (never-list 7: real people's names never go to a model), held to the same rules as
// draft-request.ts. The app sends only the prepared question (`asked.sent`) on, through the harness
// (core/src/harness/index.ts prepareAgentQuestion) and native agent_step; the fact sheet and its
// request below are the earlier route's, whose native command and check were removed on 2026-11-16
// (audit item 11). They are kept for the boundary they share and its tests.
//
// What the earlier fact-sheet request held:
//  1. ASK_SYSTEM: fixed here. It also carries the meaning of
//     every fact code, so the user message holds almost no prose for a short name to collide with.
//  2. Fact lines built here from the Sunday brief, never from source text: one-letter codes,
//     counts, local times and session labels only. People are always [Person N] and positions are
//     always [Role N] (coordinator decision 2026-11-13: a position name can hold a name the roster
//     doesn't, such as "Pastor Dave's Class"); the native grammar accepts nothing else in those
//     fields. Plan titles, notes, team leaders, email text and event titles are never included. The
//     fictional email/calendar import is only included beside the fictional Sunday example, so
//     invented records are never mixed with real church data.
//  3. The question, the only free text. It is normalized (NFKC, a symbol that becomes two or more
//     letters kept as its own word so "Riley™" is "Riley TM", invisible characters removed, line
//     breaks and controls turned into spaces, square brackets turned into parentheses so a leader
//     can't forge a label); position names and roster names are replaced by their labels.
//     Questions with an email address or phone number, or asking for prayers, sermons, scripture,
//     a Bible verse or devotionals, for pastoral comfort or counsel, to send or change anything, or to
//     rank or describe people, are refused here with a plain message. So is any question naming a
//     background check (or its usual names): those are never prepared for a model, even as
//     placeholders, and the app answers them on this Mac instead (owner decision 2026-11-14).
//  4. Names in the question are matched as whole words (coordinator decision 2026-11-13, after
//     substring matching refused ordinary words: "same" for Sam, "time" for Tim, "willing" for
//     Will): every roster name term (full name, each part, each part with its punctuation removed,
//     and every run of consecutive parts joined, so "MaryKate" and "Delacruz" for "de la Cruz") in
//     folded form (case, accents, stroked letters such as ø and ł, fullwidth and invisible
//     characters ignored). Only a letter of a spaced script continues a word: digits, symbols,
//     punctuation, spaces and letters of unspaced scripts are boundaries, so "Riley2", "Rileyさん",
//     "Riley的" and "คุณRiley" are all found. An optional plural or possessive "s" ("Riley's",
//     "Rileys") is allowed. Terms in unspaced scripts (Han, Hangul, Kana, Thai) match anywhere. Names
//     spelled out letter by letter are found too: with one or two of " .-_'·" between the letters for
//     three-letter terms ("S.a.m"), and up to three of anything but letters, numbers and line breaks
//     for longer ones ("R/i/l/e/y", "R, i, l, e, y"). A term only one person has becomes that
//     person's label; adjacent terms join into one label only when each belongs to that one person
//     ("Thornbury, Riley"); a term several people share (a family surname) becomes "[a team member]".
//     A question left with nothing but labels is refused.
//     Deliberately not caught: a name broken into two words ("Ri ley"), glued to other letters
//     ("RileyTM" typed as letters, "Samwise"), or written in look-alike letters of another script.
//  5. Fail closed: after replacement the whole user message must hold no roster name as a whole
//     word. The native route (model.rs `check_ask`, NameGuard::present_as_word) repeats the same
//     whole-word check against every name this session has shown, before any key, budget or
//     network. Rewording keeps its strict substring guard unchanged.
// A list of names can't catch names Planning Center doesn't hold (nicknames, family members); the
// panel says so and asks leaders not to type other personal details.
//
// Replies are checked before anyone sees them (acceptAskReply) and names are put back on this Mac
// only (restoreAnswer). A rejected reply is never shown or restored.
import type { AttentionReport } from "./attention-import/index.js";
import type { BriefPerson, Finding, SundayBrief } from "./sunday-brief.js";
import { applyDecisions, type DecisionChoice, type SundayDecision } from "./sunday-decisions.js";
import { BACKGROUND_LINE, forModels } from "./kids-rules.js";
import { BOOKS, containsName, fold, nameTerms, NOT_OURS, UNSPACED } from "./draft-request.js";
import { backgroundWording, newerCharacter } from "./harness/background-wording.js";
import { SUNDAY_WORDS, type DayWords } from "./service-day.js";
import { SYSTEMS } from "./church-systems/types.js";

// Pinned natively by model_tests.rs (`the_fixed_ask_text_matches_the_webview_exactly`).
export const ASK_SYSTEM = [
  "You are Ozzie, church administration software. You prepare and explain; people decide and people go.",
  "Answer the leader's question using only the fact lines in the message, which come from checks already made on this Mac.",
  "If the facts don't fully answer it, begin with exactly: I can't tell from what I read. Then say what is missing.",
  "Never invent people, availability or willingness. No overlap found does not mean someone is free or willing; only they can say.",
  "Never rank, score, compare or label people, and keep people in the order given.",
  "Refer to people and roles only by their bracketed labels, written exactly, such as [Person 1] or [Role 1]. Add no names and no other bracketed text.",
  "You cannot send messages or change Planning Center, and nothing has been sent or changed. Never say otherwise.",
  "No prayers, sermons, scripture, blessings or devotional content.",
  "Write plain text without markdown, warm and short: under 120 words, and never show the codes.",
  "Don't describe where the facts came from; the screen already shows the source and when it was read.",
  "If asked to draft a note, write one short sentence, then a line that starts with exactly Draft note: followed by a short, kind note the leader can send themselves. Make it easy to say no, add no guilt or pressure, and sign it [Your name].",
  "Fact lines have fields separated by a vertical bar. Times are local, written YYYY-MM-DD HH:MM.",
  "S is the Sunday check: its mode (L live check, R saved recording that is not current, X example data invented for a demonstration), when it was read, how many reads, and how many didn't complete.",
  "D is the Sunday's date. F1, F2 and so on are findings.",
  "N: a role still needs people; then the role, the service time and how many more.",
  "M: the church rules ask for a scheduled Sunday lead for the role, and none is scheduled.",
  "W: a person is pending for a role; then the role, the time, the person, and s (request sent, no answer yet) or n (request not sent yet).",
  "B: a person is scheduled for a role and has a blockout in Planning Center at that time; then the role, the time, the person, and c (confirmed) or p (pending). Planning Center still counts them, so the role isn't open.",
  "K: a person is scheduled this many Sundays in a row; the church rules suggest a check-in, which is about care, not performance.",
  "G: part of the check couldn't be verified; then how many reads didn't complete, and s if the check is too old to treat as current.",
  "U: a Sunday lead is scheduled for the role, but their answer or serving time couldn't be confirmed.",
  "A: a kids team has fewer confirmed people at a service time than the church rules ask; then the role, the time, how many are confirmed, how many the rules ask for, how many more are asked with no answer yet, how many more have a request not sent yet, and u if some confirmed people aren't placed at a time. Pending isn't counted, and ages aren't checked.",
  "Lines under an N finding list people on that role's team; none means no one else on the team was found.",
  "Each person line has s no overlap found, c possible conflict, v availability needs confirmation or x left out; then reasons:",
  "t on the team with no overlap found, u an unanswered request elsewhere at this time, p penciled in elsewhere with the request not sent, q pending elsewhere at this time, o confirmed elsewhere at this time, b a blockout covers this time, r a blockout that can't be checked, a other schedules couldn't be read, e records say not on the team, not eligible or not available, n a detail couldn't be verified.",
  "Other lines under a finding: y confirmed for that role already; w scheduled to lead but hasn't accepted; L a team leader Planning Center lists for that team, which is oversight, not a Sunday assignment (- none listed, ? couldn't be read).",
  "H: the leader already decided this for this Sunday: o covered outside Planning Center, n not needed this Sunday, e no scheduled lead expected; then r if a later check changed something, so it needs a fresh look. Treat a decided finding without r as settled by the leader.",
  "E is an example email and calendar import of invented records, and when it was imported. E1, E2 and so on are events that need a person's decision: l a message says the room is unavailable while the calendar still lists it, c a message says it is cancelled while the calendar still shows it, m messages disagree; then the start time, n if the message says volunteers have not been contacted or ? if unknown, and u if the import is uncertain.",
  "Z: how many fact lines were left out for length. Q is the leader's question.",
].join(" ");
/** Separates the fact lines from the question; the native route splits on its last occurrence. */
export const QUESTION_PREFIX = "\nQ | ";
export const ASK_MAX_TOKENS = 600;
export const MAX_QUESTION_CHARS = 500;
/** The question after labels replace names; labels can be longer than the names they stand for. */
export const MAX_SENT_QUESTION_CHARS = 600;
export const MAX_USER_CHARS = 8000;
export const MAX_ANSWER_CHARS = 2000;
export const DRAFT_MARKER = "Draft note:";
export const NOT_COVERED = "I can't tell from what I read.";

export interface AskModelRequest { system: string; user: string; max_tokens: number }
type Names = Record<string, string>;

/** Labels for one app session: a person or position keeps the same label for every question. Local only. */
export class AskSession {
  readonly #people = new Map<string, string>();
  readonly #roles = new Map<string, string>();
  /** `scope` is the organization, so the same Planning Center person keeps one label across checks. */
  person(scope: string, id: string): string {
    const key = `${scope}\u0000${id}`;
    let label = this.#people.get(key);
    if (!label) { label = `[Person ${this.#people.size + 1}]`; this.#people.set(key, label); }
    return label;
  }
  role(name: string): string {
    let label = this.#roles.get(name);
    if (!label) { label = `[Role ${this.#roles.size + 1}]`; this.#roles.set(name, label); }
    return label;
  }
}

export interface AskSources {
  brief: SundayBrief | null;
  /** capture.names: used here to find and restore names, never placed in a request. */
  names: Names;
  /** capture.organization. */
  organization: string;
  /** Today's attention report. Only used beside the fictional Sunday example, because it is a fictional import. */
  attention?: AttentionReport | null;
  /** The leader's Sunday decisions. Only the choice and whether a later check reopened it are used;
   *  the reason a person typed (which may name anyone) never enters the facts. */
  decisions?: readonly SundayDecision[];
}
export interface AskOptions { timeZone?: string; attentionTimeZone?: string }
/** A finding the facts described, with the labels that point back to it. */
export interface AskLink { readonly finding: Finding | null; readonly page: "sunday" | "today"; readonly terms: readonly string[] }
export interface AskContext {
  /** Placeholder-only fact lines, exactly as they will be sent. */
  readonly facts: string;
  readonly scope: string;
  /** Local only. */
  readonly names: Readonly<Names>;
  /** Label to Planning Center person id, for the people in the facts. Local only. */
  readonly people: ReadonlyMap<string, string>;
  /** Label to the exact position name it stands for. Local only. */
  readonly roles: ReadonlyMap<string, string>;
  readonly basedOn: {
    readonly mode: SundayBrief["mode"]; readonly checkedAt: string | null; readonly completedAt: string;
    readonly reads: number; readonly failed: number; readonly attentionImportedAt: string | null;
  };
  /** Why the facts are incomplete, in plain English. Shown as "Worth a look". */
  readonly gaps: readonly string[];
  readonly links: readonly AskLink[];
  /** False only if the facts could not be made free of anything name-like; nothing can then be asked. */
  readonly usable: boolean;
}

// ---- Shared checks -------------------------------------------------------------------------

const LABEL = /\[(?:Person [1-9]\d{0,3}|Role [1-9]\d{0,3}|Your name|a team member)\]/gu;
/** Stands in for a name part several people share, such as a family surname. */
export const TEAM_MEMBER = "[a team member]";
const labelsIn = (text: string) => [...new Set(text.match(LABEL) ?? [])];
const withoutLabels = (text: string, w: string) => text.replace(LABEL, w);
/** Labels may touch whitespace or the edges, an opening quote or bracket before, and after: a
 *  possessive 's, closing punctuation, then whitespace or the end (as draft-request STANDALONE). */
const BEFORE = /[\s("'“‘]/u;
const AFTER = /^(?:['’]s)?[,.!?:;)"'”’]*(?:\s|$)/u;
/** "unknown": a square bracket outside an allowed label; "apart": a label touching other text. Raw and NFKC. Mirrored natively. */
function labelProblem(text: string, allowed: ReadonlySet<string>): "unknown" | "apart" | null {
  const forms = [text, text.normalize("NFKC")];
  for (const t of forms) {
    if (/[[\]]/.test(withoutLabels(t, ""))) return "unknown";
    for (const m of t.matchAll(LABEL)) if (!allowed.has(m[0])) return "unknown";
  }
  for (const t of forms) for (const m of t.matchAll(LABEL)) {
    const before = [...t.slice(Math.max(0, m.index - 2), m.index)].pop();
    if ((before !== undefined && !BEFORE.test(before)) || !AFTER.test(t.slice(m.index + m[0].length))) return "apart";
  }
  return null;
}
/** The boundary's name check over a whole text: labels removed outright, and replaced by spaces. */
const nameIn = (text: string, names: Names) => containsName(withoutLabels(text, ""), names) || containsName(withoutLabels(text, " "), names);

// Contact details (coordinator decision 2026-11-13), mirrored natively by `contact_detail` with
// the shared vectors in core/test/ask-parity.json.
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const DIGIT = /\p{Nd}/u;
const LINE_BREAK = /[\n\r\v\f\u0085\u2028\u2029]/u;
const SPACE = /[ \t  -   　]/u;
const DOT = /[.。．｡]/u;
const DATE_SEPARATOR = /^[-/.‐-―−]$/u;
/** "x@y" with letters or numbers on both sides ("pat@church"), or, with up to three spaces around
 *  the @, a letter or number before it and a dotted domain after it ("pat @ example.org"). */
function emailAt(chars: readonly string[], at: number): boolean {
  const word = (c: string | undefined) => c !== undefined && LETTER_OR_NUMBER.test(c);
  const before = chars[at - 1];
  if ((word(before) || (before !== undefined && "._%+-".includes(before))) && word(chars[at + 1])) return true;
  let left = at - 1, right = at + 1;
  while (left >= 0 && at - left <= 3 && SPACE.test(chars[left]!)) left--;
  while (right < chars.length && right - at <= 3 && SPACE.test(chars[right]!)) right++;
  if (left === at - 1 && right === at + 1) return false;
  if (!word(chars[left])) return false;
  let domain = right;
  while (domain < chars.length && (word(chars[domain]) || chars[domain] === "-")) domain++;
  return domain > right && DOT.test(chars[domain] ?? "") && word(chars[domain + 1]);
}
interface DigitGroup { digits: number; gap: string }
/** `min` or more digits once dates (2026-11-22, 11/22/2026) and times (9:30, 10:30-11:30, 9.30) are set aside. */
function phoneLike(groups: readonly DigitGroup[], min = 7): boolean {
  let total = 0;
  for (let i = 0; i < groups.length;) {
    const a = groups[i]!, b = groups[i + 1], c = groups[i + 2];
    const date = b && c && a.gap === b.gap && DATE_SEPARATOR.test(a.gap) &&
      ((a.digits === 4 && b.digits <= 2 && c.digits <= 2) || (a.digits <= 2 && b.digits <= 2 && c.digits === 4));
    // A dotted time only when the dots don't run on, so "06.12.34.56.78" stays a phone number.
    const time = b && a.digits <= 2 && b.digits === 2 &&
      (a.gap === ":" || (a.gap === "." && (i === 0 || groups[i - 1]!.gap !== ".") && b.gap !== "."));
    if (date || time) {
      if (total >= min) return true;
      total = 0; i += date ? 3 : 2; continue;
    }
    total += a.digits; i++;
  }
  return total >= min;
}
/** `min` or more digits (any decimal digits) whose groups are separated by one to `maxGap` of anything but letters,
 *  numbers and line breaks. Mirrored natively (`digit_contact`). */
function digitContact(chars: readonly string[], maxGap: number, min: number): boolean {
  let groups: DigitGroup[] = [], digits = 0, gap = "";
  for (const c of [...chars, "\n"]) {
    if (DIGIT.test(c)) {
      if (!digits && groups.length) groups.at(-1)!.gap = gap;
      digits++; gap = "";
      continue;
    }
    if (digits) { groups.push({ digits, gap: "" }); digits = 0; }
    if (!groups.length) continue;
    if (!LETTER_OR_NUMBER.test(c) && !LINE_BREAK.test(c) && [...gap].length < maxGap) gap += c;
    else { if (phoneLike(groups, min)) return true; groups = []; gap = ""; }
  }
  return false;
}
/** An email address, or 7+ digits (any decimal digits) whose groups are separated by one to three of anything
 *  but letters, numbers and line breaks. Mirrored natively (`contact_detail`). */
export function hasContactDetail(text: string): boolean {
  const chars = [...text];
  return chars.some((c, i) => c === "@" && emailAt(chars, i)) || digitContact(chars, 3, 7);
}
type EmailToken = { word: [number, number] } | "at" | "dot" | "tight-dot" | "space" | "other";
/**
 * An email address written out (review 2026-11-14 C11; native `spelled_email`): word, at, word, then one or more
 * dot-word pairs ending in a 2–24 letter top-level domain, where "at" is "@", "[at]", "(at)", "{at}", "<at>" or the
 * word "at", and "dot" is a "." with no space on either side, "[dot]" and the like, or the word "dot". Spaces may
 * surround a written-out at or dot, never a bare ".", so "Ask Pat at noon. Then" is not an address.
 */
function spelledEmail(chars: readonly string[]): boolean {
  const lower = chars.map(c => /^[A-Z]$/u.test(c) ? c.toLowerCase() : c);
  const word = (c: string) => LETTER_OR_NUMBER.test(c) || "_%+-".includes(c);
  const CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}", "<": ">" };
  const bracketed = (i: number): [EmailToken, number] | null => {
    const close = CLOSE[lower[i]!];
    if (!close) return null;
    for (const [inner, token] of [["at", "at"], ["dot", "dot"]] as const) {
      const end = i + 1 + inner.length;
      if (lower.slice(i + 1, end).join("") === inner && lower[end] === close) return [token, inner.length + 2];
    }
    return null;
  };
  const tokens: EmailToken[] = [];
  for (let i = 0; i < lower.length;) {
    const c = lower[i]!;
    if (word(c)) {
      const start = i;
      while (i < lower.length && word(lower[i]!)) i++;
      tokens.push({ word: [start, i] });
      continue;
    }
    const b = bracketed(i);
    if (b) { tokens.push(b[0]); i += b[1]; continue; }
    const token: EmailToken = c === "@" || c === "\uff20" ? "at" : ".。．｡".includes(c) ? "tight-dot" : /^\p{White_Space}$/u.test(c) ? "space" : "other";
    // A run of spaces is one space.
    if (!(token === "space" && tokens.at(-1) === "space")) tokens.push(token);
    i++;
  }
  const textOf = (t: EmailToken) => typeof t === "object" ? lower.slice(t.word[0], t.word[1]).join("") : null;
  const isWord = (t: EmailToken | undefined) => typeof t === "object";
  const joined = tokens.map((t, k): EmailToken => {
    const spaced = k > 0 && k + 1 < tokens.length && tokens[k - 1] === "space" && tokens[k + 1] === "space";
    if (spaced && textOf(t) === "at") return "at";
    if (spaced && textOf(t) === "dot") return "dot";
    if (t === "tight-dot") return isWord(tokens[k - 1]) && isWord(tokens[k + 1]) ? "dot" : "other";
    return t;
  });
  // Spaces only ever sit beside an at or a dot here; drop them there, keep them elsewhere.
  const flat: EmailToken[] = [];
  joined.forEach((t, k) => {
    const beside = (x: EmailToken | undefined) => x === "at" || x === "dot";
    if (t === "space" && (beside(joined[k + 1]) || beside(flat.at(-1)))) return;
    flat.push(t);
  });
  return flat.some((_, k) => {
    if (!isWord(flat[k]) || flat[k + 1] !== "at" || !isWord(flat[k + 2])) return false;
    let last: [number, number] | null = null;
    for (let j = k + 3; j < flat.length; j += 2) {
      const d = flat[j], w = flat[j + 1];
      if (d === "dot" && w !== undefined && typeof w === "object") last = w.word; else break;
    }
    return last !== null && last[1] - last[0] >= 2 && last[1] - last[0] <= 24 && lower.slice(last[0], last[1]).every(c => /^\p{Alphabetic}$/u.test(c));
  });
}
/**
 * hasContactDetail, and the disguises the native agent and Ask routes refuse too (`contact_detail_strict`): an email
 * address written out ("pat [at] example [dot] org", "pat at example dot org"), and 10+ digits whose groups are
 * separated by up to eight of anything but letters, numbers and line breaks ("555----123----4567"). Shared vectors:
 * core/test/ask-parity.json `pendingNative.contact`.
 */
export function hasContactDetailStrict(text: string): boolean {
  const chars = [...text];
  return hasContactDetail(text) || spelledEmail(chars) || digitContact(chars, 8, 10);
}
const contactIn = (text: string) => hasContactDetail(text) || hasContactDetail(text.normalize("NFKC"));
/** The question itself is held to the strict rule, as the native routes hold it. */
const strictContactIn = (text: string) => hasContactDetailStrict(text) || hasContactDetailStrict(text.normalize("NFKC"));

// ---- Facts -----------------------------------------------------------------------------------

const contexts = new WeakSet<AskContext>();

function stamp(iso: string | null | undefined, timeZone: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}
function span(interval: { starts_at: string; ends_at: string } | null, timeZone: string | undefined): string {
  if (!interval) return "-";
  const start = stamp(interval.starts_at, timeZone), end = stamp(interval.ends_at, timeZone);
  return start.slice(0, 10) === end.slice(0, 10) ? `${start}-${end.slice(11)}` : `${start}/${end}`;
}
// Coverage reasons (core/src/coverage.ts) as the one-letter codes ASK_SYSTEM explains. Unknown text never travels: "?".
const REASONS: [RegExp, string][] = [
  [/^Recorded team membership/, "t"],
  [/^Possible conflict: source records an unanswered sent request\./, "u"],
  [/^Possible conflict: unconfirmed scheduling record; invitation not sent\./, "p"],
  [/^Possible conflict: unconfirmed scheduling record; sending couldn't be verified\./, "q"],
  [/^Confirmed overlapping serving assignment\./, "o"],
  [/^Recorded overlapping blockout\./, "b"],
  [/^Blockout(?:s| times) couldn't be verified\./, "r"],
  [/^(?:Serving assignments|Duplicate serving assignment identities|Serving response or time semantics|Serving times) couldn't be verified\./, "a"],
  [/ excludes this suggestion\.$/, "e"],
  [/ couldn't be verified\.$/, "n"],
];
const reasonCodes = (reasons: string[]) => [...new Set(reasons.map(r => REASONS.find(([re]) => re.test(r))?.[1] ?? "?"))].join(",") || "?";
const byId = (a: BriefPerson, b: BriefPerson) => a.person_id.localeCompare(b.person_id, "en", { numeric: true });

const CHOICE: Record<DecisionChoice, string> = { "covered-outside": "o", "not-needed": "n", "lead-expected": "e" };
interface Line { text: string; drop: number }
/** Fact lines for the leader's question. Returns null when nothing has been checked yet. */
export function buildAskContext(session: AskSession, sources: AskSources, options: AskOptions = {}): AskContext | null {
  const { names, organization } = sources;
  if (!sources.brief) return null;
  // Background checks stay on this Mac (review M2/M3): no line about one is ever part of a question.
  const brief = forModels(sources.brief);
  const keptHere = sources.brief.findings.some(f => f.kind === "background-check") || sources.brief.not_checked.some(l => l.startsWith(BACKGROUND_LINE));
  const people = new Map<string, string>(), roles = new Map<string, string>();
  const lines: Line[] = [], links: AskLink[] = [];
  const add = (drop: number, ...fields: (string | number)[]) => lines.push({ text: fields.join(" | "), drop });
  const person = (id: string | undefined) => {
    if (!id) return "-";
    const label = session.person(organization, id);
    people.set(label, id);
    return label;
  };
  // Every position name is a label (header, point 2), restored on this Mac.
  const roleNamed = (position: string | undefined) => {
    const name = position?.trim() ?? "";
    if (!name) return "-";
    const label = session.role(name);
    roles.set(label, name);
    return label;
  };
  const role = (finding: Finding) => roleNamed(finding.position?.name);
  const tz = options.timeZone;
  // Decisions contribute their choice and reopened state only: never the typed reason, earlier reasons or changes.
  const decided = new Map(applyDecisions(brief, sources.decisions ?? []).items.flatMap(i => i.decision ? [[i.finding.id, i] as const] : []));
  const ids = (list: readonly string[] | undefined) => [...new Set(list ?? [])].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  add(0, "S", brief.mode === "live" ? "L" : brief.mode === "recording" ? "R" : "X", stamp(brief.checked_at, tz), brief.sources.reads, brief.sources.failed.length);
  // sort_date is the church's local wall-clock time with a misleading Z: its date part is the Sunday, never converted.
  if (brief.plan.date) add(0, "D", brief.plan.date);
  brief.findings.forEach((f, i) => {
    const id = `F${i + 1}`, before = lines.length;
    const r = role(f), where = span(f.position?.interval ?? null, tz);
    switch (f.kind) {
      case "needs-people": {
        add(0, id, "N", r, where, f.remaining ?? "?");
        const p = f.people;
        const buckets: [string, BriefPerson[], number][] = p ? [["s", p.suggestions, 4], ["c", p.conflicts, 3], ["v", p.unverified, 2], ["x", p.left_out, 1]] : [];
        for (const [code, list, drop] of buckets) for (const x of [...list].sort(byId)) add(drop, id, code, person(x.person_id), reasonCodes(x.reasons));
        for (const x of ids(f.confirmed)) add(2, id, "y", person(x));
        break;
      }
      case "lead-missing":
        add(0, id, "M", r, where);
        for (const x of ids(f.pending_leads)) add(0, id, "w", person(x));
        break;
      case "pending": add(0, id, "W", r, where, person(f.person_id), f.notification === "sent" ? "s" : "n"); break;
      // Each role the blockout overlaps, as Planning Center still counts them on it.
      case "blockout":
        for (const s of f.serving ?? []) add(0, id, "B", roleNamed(s.name), span(s.interval, tz), person(f.person_id), s.status === "pending" ? "p" : "c");
        break;
      case "streak": add(0, id, "K", person(f.person_id), f.sundays ?? "?"); break;
      case "worth-a-look": add(0, id, "G", brief.sources.failed.length, f.stale ? "s" : "-"); break;
      // Kids rules: counts only for the team (background checks never reach here).
      case "too-few-confirmed":
        add(0, id, "A", r, where, f.confirmed?.length ?? 0, f.needed ?? "?", f.asked?.length ?? 0, f.not_sent?.length ?? 0, ...(f.tone === "look" ? ["u"] : []));
        break;
      default: add(0, id, "U", r, where);
    }
    // Team leaders: oversight, not a Sunday assignment. Absent from the brief means the read didn't complete.
    if (f.kind === "needs-people" || f.kind === "lead-missing" || f.kind === "lead-unverified") {
      if (!f.leaders) add(0, id, "L", "?");
      else if (!f.leaders.length) add(0, id, "L", "-");
      else for (const x of ids(f.leaders)) add(0, id, "L", person(x));
    }
    const d = decided.get(f.id);
    if (d?.decision) add(0, id, "H", CHOICE[d.decision.choice], ...(d.state === "reopened" ? ["r"] : []));
    links.push({ finding: f, page: "sunday", terms: [...new Set(lines.slice(before).flatMap(l => l.text.match(LABEL) ?? []))] });
  });
  const attention = brief.mode === "fictional" && sources.attention?.ok ? sources.attention : null;
  if (attention) {
    const atz = options.attentionTimeZone ?? "America/New_York";
    add(0, "E", "X", stamp(attention.imported_at, atz));
    attention.findings.forEach((f, i) => {
      const kinds = new Set(f.evidence.map(e => e.kind));
      const fields: string[] = [`E${i + 1}`, kinds.size > 1 ? "m" : kinds.has("event-cancelled") ? "c" : "l", stamp(f.start_at, atz),
        f.evidence.some(e => e.not_contacted) ? "n" : "?"];
      if (f.uncertain) fields.push("u");
      add(0, ...fields);
    });
    links.push({ finding: null, page: "today", terms: [] });
  }
  // Keep the facts within the request size: leave out people lines, least needed first, and say so.
  const budget = MAX_USER_CHARS - QUESTION_PREFIX.length - MAX_SENT_QUESTION_CHARS - 16;
  let kept = lines, dropped = 0;
  for (let level = 1; level <= 4 && kept.map(l => l.text).join("\n").length > budget; level++) {
    const before = kept.length;
    kept = kept.filter(l => l.drop !== level);
    dropped += before - kept.length;
  }
  const texts = kept.map(l => l.text);
  if (dropped) texts.push(`Z | ${dropped}`);
  const facts = texts.join("\n");
  // Fail closed, though only codes, counts, times and labels are left to check.
  const usable = !nameIn(facts, names) && !contactIn(facts);
  const n = brief.sources.failed.length;
  const gaps = [
    ...(brief.mode === "recording" ? ["This is a saved copy of a check, not a current check."] : []),
    ...(brief.stale ? ["This check is more than 30 minutes old, so it may not be current."] : []),
    ...(n ? [`${n} Planning Center ${n === 1 ? "read" : "reads"} didn't complete.`] : []),
    ...(brief.findings.some(f => f.kind === "worth-a-look" || f.kind === "lead-unverified") ? ["Some coverage couldn't be verified."] : []),
    ...(dropped ? ["Some details were left out to keep the question short."] : []),
    ...(keptHere ? [`Background checks are shown on ${dayPage(brief.day ?? SUNDAY_WORDS)} only; they're never sent to an AI.`] : []),
    ...(attention && (attention.gaps.length || attention.stale || attention.status === "worth-a-look") ? ["Part of the fictional email import needs a closer look."] : []),
  ];
  const context: AskContext = Object.freeze({
    facts, scope: organization, names: Object.freeze({ ...names }), people, roles,
    basedOn: Object.freeze({ mode: brief.mode, checkedAt: brief.checked_at, completedAt: brief.completed_at, reads: brief.sources.reads, failed: n, attentionImportedAt: attention?.imported_at ?? null }),
    gaps: Object.freeze(gaps), links: Object.freeze(links), usable,
  });
  contexts.add(context);
  return context;
}

// ---- The question ----------------------------------------------------------------------------

/** One question, prepared here and nowhere else. Leader-typed text can't become one. */
export interface AskedQuestion {
  readonly request: Readonly<AskModelRequest>;
  /** As the leader typed it. Local only. */
  readonly question: string;
  /** Placeholder form, exactly as sent. */
  readonly sent: string;
  /** Every label in the request, to the person id or position name it stands for. Local only. */
  readonly people: ReadonlyMap<string, string>;
  readonly roles: ReadonlyMap<string, string>;
  readonly allowed: ReadonlySet<string>;
  /** The leader asked for a note to be drafted. */
  readonly draft: boolean;
  readonly context: AskContext;
}
export type AskPrepared = { ok: true; asked: AskedQuestion } | { ok: false; refusal: string };
const asked = new WeakSet<AskedQuestion>();

/**
 * The sidebar page of the watched services, mid-sentence: "the Services page", whatever day they are on (owner decision
 * 2026-11-19; the same words as the desktop's day-phrases.ts `pageRef`).
 */
export const dayPage = (d: DayWords): string => `the ${d.page} page`;
/**
 * A fixed sentence that names "the Sunday page" (an older line kept anywhere), said with the services' page instead, for
 * display only. Nothing else is changed.
 */
export const onDayPage = (text: string, d: DayWords): string =>
  text.replace(/\b([Tt])he Sunday page\b/gu, (_m, t: string) => t === "T" ? dayPage(d).replace(/^t/u, "T") : dayPage(d));

export const REFUSALS = {
  empty: "Type a question first.",
  long: `Please keep the question under ${MAX_QUESTION_CHARS} characters.`,
  nothing: "Nothing has been checked yet, so there's nothing to ask about.",
  contact: "Ozzie doesn't send email addresses or phone numbers to the AI. Ask again without them.",
  religious: "Ozzie doesn't write prayers, sermons, scripture or devotionals. That work stays with people.",
  care: "Ozzie doesn't give pastoral care, comfort or counsel. That stays with people.",
  /** Background checks stay on this Mac (owner decision 2026-11-14); the app answers these here instead (harness-bridge.ts). */
  background: "Ozzie doesn't send questions with background-check or child-safety screening wording to the AI, so this one wasn't sent. Ask about the team by its role instead, or look at the Services page.",
  backgroundNote: "Ozzie doesn't use AI help for notes with background-check or child-safety screening wording, so nothing was sent. Here is what the Services page shows; you can write that note yourself.",
  /** A note request with that wording and nothing from the Services page to show beside it. */
  backgroundNoteAlone: "Ozzie doesn't use AI help for notes with background-check or child-safety screening wording, so nothing was sent. You can write that note yourself, or look at the Services page.",
  /** A character no question may hold once cleaned (hiddenInQuestion): the native and ozzie.church checks refuse it too. */
  hidden: "This question has a hidden or invisible character in it, so Ozzie didn't send it to the AI. Try typing it again in plain words.",
  send: "Ozzie can't send messages or change Planning Center. It can draft a note for you to send yourself.",
  rank: "Ozzie doesn't rank, score or label people. Ask who has no overlap found; people are listed in no particular order.",
  name: "Something in your question could be part of a name in Planning Center. Nothing was sent. Try different wording.",
  facts: "Ozzie couldn't prepare these facts without something that looks like a name, so nothing was sent.",
  apart: "Ozzie couldn't keep a name in your question apart from the words around it. Nothing was sent. Try different wording.",
  onlyNames: "Your question only has names or roles in it. Add what you'd like to know about them.",
  size: "There's too much to send with this question. Try a shorter question.",
  /** The native check found a name this Mac has seen in Planning Center that this screen didn't replace. */
  native: "Ozzie stopped this question because a word in it matches a name it has seen in Planning Center. Nothing was sent. Try asking again in other words, or ask about the role instead of the person.",
} as const;
const refuse = (refusal: string): AskPrepared => ({ ok: false, refusal });

// Requests the panel refuses, matched on the folded placeholder form so a name like "Mark" or
// "Will" (already a label) can't look like an action, and a position such as "Prayer Team" (a
// [Role N] label) can't look like a request for prayer.
const RELIGIOUS_NOUN = "pray\\w*|sermon\\w*|devotion\\w*|scripture\\w*|bless\\w*|psalm\\w*|homil\\w*|benediction\\w*|invocation\\w*|verses?|bible|gospel\\w*";
const MINISTRY = "(?:team|ministry|ministries|room|group|meeting|list|chain|night|service|requests?|partners?|volunteers?|leaders?|lead|coordinator|time|schedule|shift|slot|role|position|study|studies|class|classes|school|choir|band)\\b";
/** Full book names, for "a word from Joshua", "Joshua's encouragement" and "Philippians 4.13". */
const FULL_BOOKS = "genesis|exodus|leviticus|numbers|deuteronomy|joshua|judges|ruth|samuel|kings|chronicles|ezra|nehemiah|esther|job|psalms?|proverbs|ecclesiastes|song\\s+of\\s+(?:songs|solomon)|isaiah|jeremiah|lamentations|ezekiel|daniel|hosea|joel|amos|obadiah|jonah|micah|nahum|habakkuk|zephaniah|haggai|zechariah|malachi|matthew|mark|luke|john|acts|romans|corinthians|galatians|ephesians|philippians|colossians|thessalonians|timothy|titus|philemon|hebrews|james|peter|jude|revelations?";
/** A book and chapter with a verse after a colon or a dot ("John 3:16", "Philippians 4.13", "Jer 29 v. 11"). */
const SCRIPTURE_REFERENCE = `\\b(?:[1-3]\\s?|(?:i{1,3}|first|second|third)\\s+)?(?:${FULL_BOOKS}|${BOOKS})[a-z]*\\.?\\s?\\d{1,3}\\s?(?:[:.]\\s?\\d{1,3}|,?\\s?(?:verses?|vv?\\.)\\s?\\d)`;
/** Lines quoted from scripture often enough to catch without a reference. */
const SCRIPTURE_QUOTES = [
  "be\\s+strong\\s+and\\s+(?:of\\s+good\\s+)?courage(?:ous)?", "do\\s+not\\s+be\\s+discouraged", "fear\\s+not", "i\\s+can\\s+do\\s+all\\s+things",
  "plans\\s+i\\s+have\\s+for\\s+you", "plans\\s+to\\s+prosper", "wings\\s+like\\s+eagles", "be\\s+still\\s+and\\s+know", "fearfully\\s+and\\s+wonderfully",
  "forsake\\w*", "lean\\s+not\\s+on", "all\\s+things\\s+work\\s+together", "new\\s+every\\s+morning", "weary\\s+and\\s+burdened", "cast\\s+all\\s+your",
  "(?:passes|passeth|surpasses|transcends)\\s+all\\s+understanding", "this\\s+is\\s+the\\s+day\\s+that", "love\\s+is\\s+patient",
  "every\\s+good\\s+and\\s+perfect\\s+gift", "my\\s+shepherd", "runneth", "grace\\s+and\\s+peace", "go\\s+in\\s+peace", "peace\\s+be\\s+with\\s+you", "rejoice\\s+in",
].join("|");
const RELIGIOUS_ASK = new RegExp([
  "\\b(?:pray|praying)\\s+(?:for|with|over)\\b",
  `\\b(?:write|draft|compose|create|make|give|suggest|prepare|outline|plan|share|find|pick|choose|recommend|read|say|offer|need|want|end|close|finish|add|include|quote|cite|use|insert|attach|append|sign\\s+off|help\\s+(?:me\\s+)?(?:write|with)|come\\s+up\\s+with|summari[sz]e|turn|rewrite|condense|paraphrase|explain|interpret|expand|adapt|reword|translate|break\\s+down)\\b[^.?!]{0,60}?\\b(?:${RELIGIOUS_NOUN})\\b(?!\\s+${MINISTRY})`,
  `\\b(?:a|an|some|any|short|quick|closing|opening|encouraging)\\s+(?:${RELIGIOUS_NOUN})\\b(?!\\s+${MINISTRY})`,
  // Asking which one to use ("What verse should we read?", "Which psalm …?").
  `\\b(?:what|which)\\s+(?:${RELIGIOUS_NOUN})\\b(?!\\s+${MINISTRY})`,
  `\\b(?:words?|passages?|quotes?|verses?|lines?|encouragement|encouraging\\s+words?|promises?|readings?|thoughts?)\\s+(?:from|out\\s+of|of)\\s+(?:the\\s+)?(?:book\\s+of\\s+)?(?:bible|scriptures?|gospels?|psalms?|(?:[1-3]\\s?)?(?:${FULL_BOOKS}))\\b`,
  `\\b(?:${FULL_BOOKS})'s?\\s+(?:encouragement|exhortation|charge|promise|blessing|command)\\b`,
  SCRIPTURE_REFERENCE,
  `\\b(?:${SCRIPTURE_QUOTES})\\b`,
].join("|"), "u");
// The only allowances (review Q M1, 2026-11-15), each narrow and explicit; everything else falls to RELIGIOUS_ASK.
/** A schedule question: who reads, preaches or leads, at the start of the first sentence only ("Who is scheduled to read
 *  scripture on Sunday?"). Only that frame is set aside, so "Who will read me a psalm?" is still a request for a psalm. */
const SCHEDULE_VERB = /^((?:who(?:'s|\s+is|\s+are|\s+was|\s+will(?:\s+be)?|\s+should)?|whose\s+turn(?:\s+is\s+it)?|(?:is|are)\s+(?:there\s+)?(?:anyone|someone|anybody|somebody))\s+(?:(?:scheduled|signed\s+up|assigned|lined\s+up|set|down|due|on\s+the\s+schedule)\s+to\s+|going\s+to\s+|to\s+)?)(?:read(?:s|ing)?|preach(?:es|ing)?|lead(?:s|ing)?)\b/u;
/** Passing on a chosen item that someone else made: a pass-on verb, then "the", "this", "our" or "the pastor's", then the
 *  item ("Add the sermon title to the bulletin note"). A bare compound ("sermon titles") is never an allowance. */
const CHOSEN_ITEM = /\b(share|add|include|attach|insert|append|send|forward|put|paste|copy)\s+(?:the|this|sunday's|this\s+week's|our|(?:the\s+)?pastor's)\s+(?:sermon|scripture|bible|gospel)\s+(?:titles?|readings?|slides?|recordings?|audio|video)\b/gu;
/** A request for religious content, on the folded placeholder form. */
const religiousAsk = (plain: string) => RELIGIOUS_ASK.test(plain.replace(SCHEDULE_VERB, "who ").replace(CHOSEN_ITEM, "$1 the item"));
/** Pastoral comfort or counsel (never-list 3): Ozzie never offers either, so it isn't asked for. */
const CARE_ASK = new RegExp([
  "\\b(?:comfort|console|consoling|counsel|counselling|counseling)\\b(?!\\s+(?:station|room|area|team|desk|kits?)\\b)",
  "\\b(?:what|how)\\b[^.?!]{0,40}\\b(?:say|tell|write|support|encourage)\\b[^.?!]{0,60}\\b(?:griev\\w*|grief|bereave\\w*|mourn\\w*|hurting|passed\\s+away|died|funeral|diagnos\\w*|cancer|divorce|depress\\w*|miscarriage)",
].join("|"), "u");
/**
 * Whether text names a background check or one of its usual names (owner decision 2026-11-14: never sent to any model,
 * even as placeholders; review Q H2), as prepareAsk reads it. The one list, harness/fixed/background-wording.json,
 * which the native check and ozzie.church read too (harness/background-wording.ts). Questions with one are answered
 * on this Mac (harness-bridge.ts), never prepared here.
 */
export const mentionsBackgroundCheck = (typed: string) => backgroundWording(typed);
const HIDDEN_IN_QUESTION = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}⠀]/u;
/**
 * A character no question may hold (agent.rs `hidden_in_question`, ozzie.church `questionCharactersOk`): controls,
 * format, private-use and surrogate characters, line and paragraph separators, every default-ignorable character, the
 * blank braille pattern, and the background-check list's newer characters. Each folding of the list reads them one way,
 * so a question mixing them could spell its wording past all three (review B3 L-1); the question is refused instead.
 */
export const hiddenInQuestion = (text: string) => HIDDEN_IN_QUESTION.test(text) || [...text].some(newerCharacter);
// Requests to contact people or change records (review 2026-11-14, question side), matched on the folded
// placeholder form with every person label as \u0001 and every role label as \u0002, so they are refused only as
// actual requests: a verb said to Ozzie (at the start of a sentence, after "can you", "please", "I need you to",
// "and then" …) that sends or contacts someone, puts someone on or off a schedule, or changes a record. "Can you
// confirm whether…", "update me", "add up", "call out", "post … here" and "Mark is asking" are questions.
const FRAME = "(?:(?:^|[.!?;:]\\s*)(?:(?:hey|hi|ok|okay)\\s*,?\\s+)?(?:ozzie\\s*[,:]?\\s*)?(?:please\\s+)?" +
  "|\\b(?:can|could|would|will)\\s+you\\s+(?:please\\s+)?(?:just\\s+)?(?:go\\s+ahead\\s+and\\s+)?" +
  "|\\b(?:please|go\\s+ahead\\s+and|i\\s+(?:want|need)\\s+you\\s+to|i'?d\\s+like\\s+you\\s+to|and(?:\\s+then)?|then)\\s+)";
/** Someone a message could go to, or who could be put on a schedule. */
const SOMEONE = "(?:\\u0001|them|him|her|everyone|everybody|anyone|anybody|someone|somebody|people|volunteers|leaders|parents|members|" +
  "(?:the|our|my|all\\s+the)\\s+(?:team|volunteers?|leaders?|team\\s+leaders?|parents|members|group|congregation|staff|\\u0002(?:\\s+(?:team|leaders?|volunteers?|people))?)|" +
  "\\u0002\\s+(?:team|leaders?|volunteers?|people))";
/** What a change is made to: a label, or a word that begins naming a record. */
const RECORD = "(?:\\u0001|\\u0002|it|this|that|these|those|them|the|a|an|all|every|each|my|our|his|her|their|planning\\s+center|sunday|[\\p{L}]+'s)";
const NOT_A_RECORD = "(?:the\\s+|this\\s+|that\\s+|my\\s+|your\\s+)?(?:wording|tone|draft|note|message)\\b";
const SEND_OR_CHANGE = new RegExp([
  // Sending: always a request to contact someone, unless it is the leader asking for something ("send me …").
  `${FRAME}(?:send|text|e-?mail|message|dm|ping|notify|remind|forward)\\b(?!\\s+(?:me|us)\\b)`,
  // Contacting someone, or posting or replying to them.
  `${FRAME}(?:call|phone|ring|contact|reach\\s+out\\s+to|invite|tell|reply\\s+to|respond\\s+to|let)\\s+${SOMEONE}(?![\\p{L}])`,
  `${FRAME}post\\b[^.?!]{0,40}?\\bto\\s+${SOMEONE}(?![\\p{L}])`,
  // Putting someone on or off a schedule.
  `${FRAME}(?:assign|reassign|unassign|schedule|reschedule|unschedule|add|remove|move|swap|put|slot|sign\\s+up|book|replace|drop)\\s+${SOMEONE}(?![\\p{L}])`,
  `${FRAME}(?:assign|reassign|schedule|reschedule|add|put|move|slot|sign)\\b[^.?!]{0,40}?\\b(?:to|on|onto|into|off|from)\\s+(?:the\\s+)?(?:schedule|roster|rota|plan|team|lineup|\\u0002|planning\\s+center)`,
  // Changing a record in Planning Center.
  `${FRAME}(?:change|update|edit|modify|delete|remove|cancel|book|reserve|approve|publish|block|unblock|set|unassign)\\s+(?!${NOT_A_RECORD})${RECORD}(?![\\p{L}])`,
  // Settling one: someone, a role, or a request, booking or assignment ("confirm whether …" is a question).
  `${FRAME}(?:confirm|accept|decline|mark|fill|clear|fix|resolve)\\s+(?:${SOMEONE}|\\u0002|it|this|that|the\\s+(?:requests?|bookings?|reservations?|assignments?|schedule|blockouts?|conflicts?|rooms?|slots?|spots?|roles?|positions?|follow-?ups?))(?![\\p{L}])`,
].join("|"), "u");
const RANKING = /\b(?:rank\w*|scor(?:e|es|ed|ing)|rate|rating|ratings|grade|(?:most|least|more|less)\s+(?:reliable|faithful|committed|dependable|likely|consistent)|best\s+(?:person|people|volunteers?|choice|fit|option|one|pick|candidate)|who(?:'s|\s+is)\s+(?:the\s+)?(?:best|better|worst|strongest|weakest)|better\s+(?:choice|fit|volunteer|person)|top\s+(?:picks?|choices?|candidates?)|strongest|weakest|likeliest)\b/u;
/** Evaluative words about a person (never-list 4), refused in questions and answers alike. */
export const CHARACTER = /(?<![\p{L}\p{N}])(?:(?:un)?reliable|(?:un)?dependable|(?:un)?faithful|uncommitted|flak(?:y|ey)|lazy|laziness|slack(?:er|ers|ing)|fall(?:ing|en|s)?\s+away|backslid\w*|drift(?:ing|ed|s)?(?:\s+away)?|at[\s-]risk|disengag\w*|lukewarm|apathetic|careless|irresponsible|(?:un)?trustworthy|burn(?:ed|t|ing)?[\s-]?out|unmotivated|uninterested|(?:losing|lost)\s+interest|not\s+pulling|let(?:s|ting)?\s+(?:the\s+team|us|everyone|people)\s+down|can(?:'t|not)?\s+be\s+counted\s+on|wayward|lapsed)(?![\p{L}\p{N}])/u;
/** A request for a note to be drafted, on folded text. Also read by the answers written on this Mac (harness/compose.ts). */
export const DRAFT_ASK = /\b(?:draft|write|compose|prepare|word)\b[^.?!]{0,60}\b(?:note|message|email|e-mail|text|reply|letter|invite|invitation)\b/u;

/** A symbol (not a letter) that NFKC turns into two or more letters ("™" → "TM") is kept as its own word, so it
 *  stays the boundary it was as typed. One-letter forms ("Ⓡ" → "R") stay joined to their word. */
const keepSymbolWords = (typed: string) => typed.replace(/[^\p{L}\p{M}]/gu, c => /\p{L}[^]*\p{L}/u.test(c.normalize("NFKC")) ? ` ${c} ` : c);
/** Normalized, invisible and control characters gone, brackets turned into parentheses, one line. */
const clean = (typed: string) => keepSymbolWords(typed).normalize("NFKC").replace(/[\p{Cf}\p{Co}]/gu, "").replace(/\p{Cc}/gu, " ")
  .replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/gu, " ").trim();

// Matching in folded form, one code point at a time, with a map back to the typed text, so a
// match replaces exactly the characters the leader typed.
function folded(text: string) {
  let f = "";
  const from: number[] = [], to: number[] = [];
  for (let i = 0; i < text.length;) {
    const size = text.codePointAt(i)! > 0xffff ? 2 : 1;
    const piece = fold(text.slice(i, i + size));
    for (let k = 0; k < piece.length; k++) { from.push(i); to.push(i + size); }
    f += piece; i += size;
  }
  return { f, from, to };
}
/** Only a letter of a spaced script continues a word (header, point 4). Mirrored natively (`word_char`). */
const wordChar = (c: string | undefined) => c !== undefined && /\p{L}/u.test(c) && !UNSPACED.test(c);
const charAt = (s: string, i: number) => i >= 0 && i < s.length ? String.fromCodePoint(s.codePointAt(i)!) : undefined;
const charBefore = (s: string, i: number) => {
  if (i <= 0) return undefined;
  const low = s.charCodeAt(i - 1);
  return charAt(s, low >= 0xdc00 && low <= 0xdfff && i >= 2 ? i - 2 : i - 1);
};
interface Hit { start: number; end: number; keys: Set<string> }
/** Gaps between the letters of a spelled-out three-letter term ("S.a.m", "T i m"). */
const NARROW_GAP = /^[ .\-_'·]{1,2}$/u;
/** Gaps between the letters of a spelled-out longer term ("R/i/l/e/y", "R, i, l, e, y", "R . i . l . e . y"). */
const WIDE_GAP = /^[^\p{L}\p{N}\n\r\v\f\u0085\u2028\u2029]{1,3}$/u;
interface Token { a: number; b: number; s: string }
/** Three or more one-character words in a row, each gap matching `gap`. */
function spelledRuns(f: string, tokens: readonly Token[], gap: RegExp): Token[][] {
  const single = (t: Token) => [...t.s].length === 1;
  const runs: Token[][] = [];
  for (let i = 0; i < tokens.length;) {
    let j = i;
    while (j + 1 < tokens.length && single(tokens[j]!) && single(tokens[j + 1]!) && gap.test(f.slice(tokens[j]!.b, tokens[j + 1]!.a))) j++;
    if (j - i >= 2) runs.push(tokens.slice(i, j + 1));
    i = j + 1;
  }
  return runs;
}
/**
 * How names are matched (owner decision 2026-11-14, "capitalized only", refined by the coordinator the same day
 * within that rule). Without `common`, every whole-word match of any name term
 * counts (strict; Ask's own default, which the native Ask route mirrors). With `common` (lower-case common
 * English words), one-word terms follow the prose rule (mirrored natively by NameGuard::present_in_prose):
 *  - a weekday or month name ("Sunday", "June"), and "church" in Ozzie's own term "Church rules", counts only
 *    when it sits next to another part of the same member's name ("June Carter", "Adeyemi, Sunday"), whatever
 *    its case, so "this Sunday", "Sundays", "in June" and "Your Church rules" name no one;
 *  - any other term that is in `common`, such as "will" for Will Grace, counts only where its first letter was
 *    typed as a capital, a capital at the start of a sentence included, and never when a contraction follows it
 *    directly (n't, 'll, 'd, 've, 're, 'm, and 's after it, that, what …), so "Don't" is not Don;
 *  - every other term always counts.
 * Terms of two or more words (a full name), joined parts, spelled-out names and unspaced scripts always count.
 */
export interface NameMatchOptions { readonly common?: ReadonlySet<string> }
const CAPITAL = /^[\p{Lu}\p{Lt}]/u;
/** Weekday and month names: under the prose rule, a name only beside another part of the same member's name. */
export const CALENDAR_WORDS: ReadonlySet<string> = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]);
/** Words before which a following "'s" is a contraction ("it's", "let's"), never a possessive. */
const S_CONTRACTED: ReadonlySet<string> = new Set(["it", "that", "what", "who", "there", "here", "he", "she", "let", "where", "how", "when", "why"]);
/** What may stand between two parts of one person's name, in folded text (as JOIN below). */
const NEIGHBOUR_GAP = /^[\s,.'-]{1,3}$/u;
/** For each calendar word or "church" in a member's name, every other part of that member's name, folded. */
function nameNeighbours(names: Readonly<Names>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const full of Object.values(names)) {
    const parts = fold(full).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    for (const part of parts) {
      if (!CALENDAR_WORDS.has(part) && part !== "church") continue;
      const set = out.get(part) ?? new Set<string>();
      for (const other of parts) if (other !== part) set.add(other);
      out.set(part, set);
    }
  }
  return out;
}
/** The word just before position `a` of folded text `f`, when only a short gap of NEIGHBOUR_GAP separates them. */
function wordBefore(f: string, a: number): string | null {
  let i = a;
  while (i > 0 && !wordChar(charBefore(f, i))) i -= charBefore(f, i)!.length;
  if (i === a || !NEIGHBOUR_GAP.test(f.slice(i, a))) return null;
  let j = i;
  while (j > 0 && wordChar(charBefore(f, j))) j -= charBefore(f, j)!.length;
  return j < i ? f.slice(j, i) : null;
}
/** The word just after position `b`, the same way. */
function wordAfter(f: string, b: number): string | null {
  let i = b;
  while (i < f.length && !wordChar(charAt(f, i))) i += charAt(f, i)!.length;
  if (i === b || !NEIGHBOUR_GAP.test(f.slice(b, i))) return null;
  let j = i;
  while (j < f.length && wordChar(charAt(f, j))) j += charAt(f, j)!.length;
  return j > i ? f.slice(i, j) : null;
}
/** A contraction directly after `term`, which ends at `b`: an apostrophe, then n't's t, ll, d, ve, re or m, or s after it, that … */
function contracted(f: string, b: number, term: string): boolean {
  if (f[b] !== "'") return false;
  let j = b + 1;
  while (j < f.length && wordChar(charAt(f, j))) j += charAt(f, j)!.length;
  const suffix = f.slice(b + 1, j);
  return ["ll", "d", "ve", "re", "m"].includes(suffix) || (suffix === "t" && term.endsWith("n")) || (suffix === "s" && S_CONTRACTED.has(term));
}
/** The prose rule for one occurrence [a, b) of a one-word term in folded text `f`, or null when the term isn't one it decides. */
function proseHit(text: string, f: string, from: readonly number[], a: number, b: number, plural: boolean, term: string,
  common: ReadonlySet<string>, neighbours: ReadonlyMap<string, ReadonlySet<string>>): boolean | null {
  const next = wordAfter(f, b);
  if (CALENDAR_WORDS.has(term) || (term === "church" && next === "rules")) {
    const near = neighbours.get(term);
    const before = wordBefore(f, a);
    return !!near && ((before !== null && near.has(before)) || (next !== null && near.has(next)));
  }
  if (!common.has(term)) return null;
  return CAPITAL.test(String.fromCodePoint(text.codePointAt(from[a]!)!)) && (plural || !contracted(f, b, term));
}
/** Roster-name occurrences (header, point 4), longest first, never overlapping `avoid`:
 *  whole words with an optional plural/possessive "s", any occurrence for unspaced scripts, and
 *  names spelled out one letter at a time. Mirrored natively by NameGuard::present_as_word. */
function hits(text: string, terms: Map<string, Set<string>>, avoid: [number, number][] = [], common?: ReadonlySet<string>,
  neighbours: ReadonlyMap<string, ReadonlySet<string>> = new Map()): Hit[] {
  const { f, from, to } = folded(text);
  const found: { a: number; b: number; keys: Set<string> }[] = [];
  for (const [t, keys] of terms) {
    if (!t) continue;
    for (let a = f.indexOf(t); a >= 0; a = f.indexOf(t, a + 1)) {
      const b = a + t.length;
      let end: number | null = null;
      if (UNSPACED.test(t)) end = b;
      else if (!wordChar(charBefore(f, a)) && !wordChar(charAt(f, b))) end = b;
      else if (!wordChar(charBefore(f, a)) && charAt(f, b) === "s" && !wordChar(charAt(f, b + 1))) end = b + 1;
      if (end === null) continue;
      // The prose rule (NameMatchOptions) decides one-word terms that are calendar words or common words.
      if (common && !UNSPACED.test(t) && proseHit(text, f, from, a, end, end > b, t, common, neighbours) === false) continue;
      found.push({ a, b: end, keys });
    }
  }
  // Spelled out: one-character words whose letters, read together, hold a term.
  const tokens = [...f.matchAll(/[\p{L}\p{N}]+/gu)].map(m => ({ a: m.index, b: m.index + m[0].length, s: m[0] }));
  const narrow = spelledRuns(f, tokens, NARROW_GAP), wide = spelledRuns(f, tokens, WIDE_GAP);
  for (const [term, keys] of terms) {
    const t = term.replace(/[^\p{L}\p{N}]+/gu, ""), length = [...t].length;
    if (UNSPACED.test(t) || length < 3) continue;
    for (const run of length === 3 ? narrow : wide) {
      const letters = run.map(r => r.s).join("");
      for (let at = letters.indexOf(t); at >= 0; at = letters.indexOf(t, at + 1)) {
        // Each token is one code point; index tokens by code point to stay aligned.
        const first = [...letters.slice(0, at)].length, last = first + length - 1;
        if (run[first] && run[last]) found.push({ a: run[first]!.a, b: run[last]!.b, keys });
      }
    }
  }
  found.sort((x, y) => (y.b - y.a) - (x.b - x.a) || x.a - y.a);
  const taken: Hit[] = [];
  for (const h of found) {
    const hit = { start: from[h.a]!, end: to[h.b - 1]!, keys: h.keys };
    if (![...taken.map(t => [t.start, t.end] as [number, number]), ...avoid].some(([s, e]) => hit.start < e && s < hit.end)) taken.push(hit);
  }
  return taken.sort((x, y) => x.start - y.start);
}
const labelSpans = (text: string): [number, number][] => [...text.matchAll(LABEL)].map(m => [m.index, m.index + m[0].length]);
/** Replaces spans with labels, adding a space wherever a label would otherwise touch another character. */
function replaceSpans(text: string, spans: { start: number; end: number; label: string }[]): string {
  let out = "", last = 0;
  for (const s of spans) {
    out += text.slice(last, s.start);
    const before = [...out].pop();
    if (before !== undefined && !BEFORE.test(before)) out += " ";
    out += s.label;
    if (!AFTER.test(text.slice(s.end))) out += " ";
    last = s.end;
  }
  return out + text.slice(last);
}
/** The Ask name check (header, points 4 and 5): any roster name left as a whole word, spelled out,
 *  or in an unspaced script, with labels removed outright and replaced by spaces. */
export function containsNameWord(text: string, names: Readonly<Names>, options: NameMatchOptions = {}): boolean {
  const terms = personTerms(names), neighbours = nameNeighbours(names);
  return hits(withoutLabels(text, ""), terms, [], options.common, neighbours).length > 0 ||
    hits(withoutLabels(text, " "), terms, [], options.common, neighbours).length > 0;
}
/** Ask's terms for one name (header, point 4): nameTerms plus every run of two or more consecutive
 *  whole parts joined ("marykate", "delacruz"). Mirrored natively (NameGuard word terms). */
export function askNameTerms(full: string): string[] {
  const terms = new Set(nameTerms({ name: full }));
  const parts = fold(full).trim().split(/\s+/u).map(p => p.replace(/[^\p{L}\p{N}]+/gu, "")).filter(p => p.length > 0);
  for (let i = 0; i < parts.length; i++) for (let j = i + 2; j <= parts.length; j++) terms.add(parts.slice(i, j).join(""));
  return [...terms];
}
function personTerms(names: Readonly<Names>): Map<string, Set<string>> {
  const terms = new Map<string, Set<string>>();
  for (const [id, full] of Object.entries(names)) for (const term of askNameTerms(full)) {
    const ids = terms.get(term) ?? new Set<string>();
    ids.add(id); terms.set(term, ids);
  }
  return terms;
}
/** Separators that may join two parts of one person's name into one label ("Thornbury, Riley"). */
const JOIN = /^[\s,.'’-]{1,3}$/u;
const only = (keys: ReadonlySet<string>) => keys.size === 1 ? [...keys][0] : undefined;

/**
 * Options for a caller other than the Ask panel (the agent harness). Ask itself passes none, so its
 * behaviour, mirrored by the native Ask route, is unchanged.
 *  - roles: more positions to label before any name is replaced (label → exact position name), such as
 *    every position of this plan, not only those in the findings.
 *  - common: the "capitalized only" name rule (NameMatchOptions).
 *  - protect: room, follow-up and event names the caller replaces with its own labels straight after
 *    (review 2026-11-14 C5): kept whole as typed, so no person label lands inside one, and set aside by
 *    the name checks here. The caller must label every one before anything is sent.
 */
export interface PrepareOptions extends NameMatchOptions {
  readonly roles?: ReadonlyMap<string, string>;
  readonly protect?: readonly string[];
}

/** Everything that happens to a question before it can be sent. Refusals send nothing. */
export function prepareAsk(session: AskSession, context: AskContext, typed: string, options: PrepareOptions = {}): AskPrepared {
  if (!contexts.has(context)) throw new Error("Only facts Ozzie built can be sent.");
  if (!context.usable) return refuse(REFUSALS.facts);
  const names = context.names as Names;
  const question = clean(typed);
  if (!question) return refuse(REFUSALS.empty);
  if (question.length > MAX_QUESTION_CHARS) return refuse(REFUSALS.long);
  const match: NameMatchOptions = options.common ? { common: options.common } : {};
  // Position names first, so a position named after someone (or holding a number) stays one label.
  // They are cleaned the way the question was, so a suggested question always finds its position.
  const roleLabels = new Map([...context.roles, ...(options.roles ?? [])]);
  const roleTerms = new Map([...roleLabels].map(([label, role]) => [fold(clean(role)), new Set([label])]));
  const withRoles = replaceSpans(question, hits(question, roleTerms).map(h => ({ ...h, label: [...h.keys][0]! })));
  if (strictContactIn(withRoles)) return refuse(REFUSALS.contact);
  // Place names the caller labels next (PrepareOptions.protect) are kept whole, so a surname inside one
  // ("Thornbury Hall") never becomes a person label; the name checks below look past them too.
  const protectTerms = new Map((options.protect ?? []).filter(n => n.trim()).map(n => [fold(clean(n)), new Set([n])]));
  const protectedSpans = (text: string): [number, number][] => protectTerms.size ? hits(text, protectTerms, labelSpans(text)).map(h => [h.start, h.end]) : [];
  const unprotected = (text: string) => protectedSpans(text).reduceRight((t, [a, b]) => t.slice(0, a) + " ".repeat(b - a) + t.slice(b), text);
  // Then roster names (header, point 4). Adjacent parts join into one label only when each is one and
  // the same person; a part several people share, never guessed, becomes "[a team member]".
  const found = hits(withRoles, personTerms(names), [...labelSpans(withRoles), ...protectedSpans(withRoles)], match.common, nameNeighbours(names));
  const groups: Hit[] = [];
  for (const h of found) {
    const prev = groups.at(-1), id = only(h.keys);
    if (prev && id !== undefined && only(prev.keys) === id && JOIN.test(withRoles.slice(prev.end, h.start))) prev.end = h.end;
    else groups.push({ ...h, keys: new Set(h.keys) });
  }
  const people = new Map(context.people);
  const sent = replaceSpans(withRoles, groups.map(g => {
    const id = only(g.keys);
    if (id === undefined) return { start: g.start, end: g.end, label: TEAM_MEMBER };
    const label = session.person(context.scope, id);
    people.set(label, id);
    return { start: g.start, end: g.end, label };
  }));
  if (!/[\p{L}\p{N}]{2}/u.test(withoutLabels(sent, " "))) return refuse(REFUSALS.onlyNames);
  const plain = fold(withoutLabels(sent, " ")).replace(/\s+/gu, " ").trim();
  // Person labels as \u0001 and role labels as \u0002, for "Text [Person 1]" or "Add [Person 1] to [Role 1]".
  const marked = fold(sent.replace(LABEL, l => l.startsWith("[Person ") || l === TEAM_MEMBER ? " \u0001 " : l.startsWith("[Role ") ? " \u0002 " : " "))
    .replace(/\s+/gu, " ").trim();
  if (religiousAsk(plain)) return refuse(REFUSALS.religious);
  if (CARE_ASK.test(plain)) return refuse(REFUSALS.care);
  if (SEND_OR_CHANGE.test(marked)) return refuse(REFUSALS.send);
  if (RANKING.test(plain) || CHARACTER.test(plain)) return refuse(REFUSALS.rank);
  // Nothing about a background check is ever prepared for a model, even as placeholders (review Q H2).
  // Read as typed too: cleaning deletes zero-width characters, which would join "DBS​done" into one word (review B2).
  if (mentionsBackgroundCheck(plain) || mentionsBackgroundCheck(typed)) return refuse(DRAFT_ASK.test(plain) ? REFUSALS.backgroundNote : REFUSALS.background);
  // What cleaning kept of a hidden character, as the native and ozzie.church checks would refuse it (review B3 L-1).
  if (hiddenInQuestion(sent)) return refuse(REFUSALS.hidden);
  // Fail closed: no roster name may remain as a whole word (header, point 5).
  if (containsNameWord(unprotected(sent), names, match)) return refuse(REFUSALS.name);
  if (sent.length > MAX_SENT_QUESTION_CHARS) return refuse(REFUSALS.long);
  const user = `${context.facts}${QUESTION_PREFIX}${sent}`;
  if (user.length > MAX_USER_CHARS) return refuse(REFUSALS.size);
  // The whole message, as the native route checks it.
  if (contactIn(user)) return refuse(REFUSALS.contact);
  const allowed = new Set([...people.keys(), ...roleLabels.keys(), TEAM_MEMBER]);
  if (labelProblem(user, allowed)) return refuse(REFUSALS.apart);
  if (containsNameWord(unprotected(user), names, match)) return refuse(REFUSALS.name);
  const roles = new Map(roleLabels);
  const result: AskedQuestion = Object.freeze({
    request: Object.freeze({ system: ASK_SYSTEM, user, max_tokens: ASK_MAX_TOKENS }),
    question, sent, people, roles, allowed: new Set([...labelsIn(user), "[Your name]"]), draft: DRAFT_ASK.test(plain), context,
  });
  asked.add(result);
  return { ok: true, asked: result };
}

// ---- The answer ------------------------------------------------------------------------------

/** A reply that passed every check. Only acceptAskReply makes one. */
export interface CheckedAnswer { readonly text: string; readonly asked: AskedQuestion }
const checked = new WeakSet<CheckedAnswer>();
export const ANSWER_PROBLEMS = {
  unusable: "The answer wasn't usable, so it isn't shown. Nothing was sent or changed.",
  label: "The answer mentioned someone Ozzie didn't ask about, so it isn't shown.",
  apart: "The answer didn't keep people's placeholders separate from other words, so Ozzie couldn't check it. It isn't shown. Try asking again.",
  religious: "The answer included religious content Ozzie doesn't write, so it isn't shown.",
  claim: "The answer said something was sent or changed. Ozzie can't do that, so the answer isn't shown.",
  rank: "The answer ranked or scored people, which Ozzie doesn't do, so it isn't shown.",
  describe: "The answer described a person in a way Ozzie doesn't, so it isn't shown.",
  name: "The answer included a name the AI was never given, so it isn't shown.",
} as const;
// Answer checks (coordinator decision 2026-11-13), on the folded text with labels as spaces.
// Religious content beyond the shared NOT_OURS list: prayer language, praise words, quoted lines and references.
export const RELIGIOUS_REPLY = new RegExp([
  "\\b(?:heavenly|spiritual(?:ly)?|holy\\s+spirit|holy\\s+ghost|father\\s+god|our\\s+father|hallelujah|alleluia|hosanna|savio(?:u)?r|salvation|divine|godly|almighty|in\\s+(?:his|jesus'?s?|christ'?s?)\\s+name)\\b",
  "\\blift(?:s|ed|ing)?\\s+(?:[\\p{L}'-]+\\s+){0,3}?up\\b",
  `\\b(?:${SCRIPTURE_QUOTES})\\b`,
  SCRIPTURE_REFERENCE,
  `\\b(?:${FULL_BOOKS})\\s+(?:chapter|ch\\.?)\\s?\\d`,
].join("|"), "u");
// First-person or Ozzie claims of sending or changing something, passives that say a message went, and drafts
// telling someone a change was made. Subjects are "I", "we" and "Ozzie", with contractions.
const DONE = "sent|e-?mailed|texted|messaged|notified|contacted|invited|scheduled|rescheduled|unscheduled|assigned|reassigned|booked|confirmed|declined|cancell?ed|posted|published|forwarded|replied\\s+to|told|asked|called|phoned|rang|let\\s+[^.?!\\n]{0,40}?\\bknow|followed\\s+up|reached\\s+out|signed\\s+[^.?!\\n]{0,20}?\\bup|took\\s+care\\s+of|taken\\s+care\\s+of|handled\\s+(?:it|that|this)|updated\\s+planning\\s+center|changed\\s+planning\\s+center";
const DO = "send|e-?mail|text|message|notify|contact|invite|schedule|reschedule|assign|reassign|book|confirm|decline|cancel|post|publish|update|change|reach\\s+out|call|phone|forward|take\\s+care\\s+of";
const DOING = "sending|e-?mailing|texting|messaging|notifying|contacting|inviting|scheduling|rescheduling|assigning|reassigning|booking|cancell?ing|posting|publishing|calling|phoning";
const CHANGED = "added|removed|moved|put|placed|slotted|add|remove|move|place|slot";
const DESTINATION = "(?:to|from|on|off|onto|into|in)\\s+(?:the\\s+|your\\s+|this\\s+|our\\s+)?(?:[\\p{L}\\p{N}'-]+\\s+){0,3}?(?:schedule|plan|team|roster|rota|list|lineup|planning\\s+center)\\b";
const MESSAGE = "(?:messages?|notes?|texts?|e-?mails?|reminders?|drafts?)";
export const CLAIMS = new RegExp([
  `\\b(?:i|we|ozzie)(?:'ve|'d|\\s+have|\\s+has|\\s+had)?(?:\\s+(?:just|already|now|also|actually|(?:went|gone)\\s+ahead\\s+and))*\\s+(?:${DONE})\\b`,
  `\\b(?:i'll|i\\s+will|ozzie\\s+will|ozzie'll|we'll|we\\s+will|let\\s+me|i'm\\s+going\\s+to|i\\s+am\\s+going\\s+to|we're\\s+going\\s+to)\\s+(?:go\\s+ahead\\s+and\\s+)?(?:${DO})\\b`,
  `\\b(?:i'm|i\\s+am|we're|we\\s+are|ozzie\\s+is|ozzie's)\\s+(?:now\\s+|just\\s+|currently\\s+)?(?:${DOING})\\b`,
  `\\b(?:i|we|ozzie)(?:'ve|'d|'ll)?(?:\\s+(?:have|has|had|will|just|already|now|also|(?:went|gone|go)\\s+ahead\\s+and))*\\s+(?:${CHANGED})\\b[^.?!\\n]{0,40}?\\b${DESTINATION}`,
  // Not "scheduled" or "confirmed": a check-in note may truthfully say so, from Planning Center.
  "\\byou(?:'ve|\\s+have|\\s+are|'re)\\s+(?:been\\s+|now\\s+)?(?:assigned|added|booked|signed\\s+up)\\b",
  `\\b(?:(?:has|have|had)\\s+been|was|were)\\s+(?:${DONE})\\s+by\\s+(?:me|ozzie|us)\\b`,
  // Not "the request was sent": Planning Center records that, and the facts carry it.
  `\\b${MESSAGE}\\s+(?:(?:has|have|had)\\s+been|was|were|is|are|got)\\s+(?:just\\s+|already\\s+|now\\s+|successfully\\s+)?(?:sent|delivered|e-?mailed|texted|forwarded|posted)\\b`,
  `\\b${MESSAGE}\\s+sent\\b`,
  "\\b(?:went|gone|goes|going)\\s+out\\s+to\\b",
  `\\b(?:${MESSAGE}|it)\\s+(?:has\\s+|have\\s+)?(?:went|gone)\\s+out\\b`,
  "\\bwas\\s+sent\\s+(?:a|an|the|your|my)\\s+(?:note|message|text|e-?mail|reminder)\\b",
  `(?:\\bis|\\bare|'s|'re)\\s+now\\s+(?:on|off|in)\\s+(?:the\\s+|your\\s+)?(?:[\\p{L}\\p{N}'-]+\\s+){0,3}?(?:schedule|plan|team|roster|rota|list|lineup)\\b`,
  "\\bnow\\s+(?:assigned|booked|added|removed|signed\\s+up)\\b",
  "^\\s*(?:all\\s+)?done\\b",
].join("|"), "u");
export const RANKED = /\b(?:rank(?:ed|ing|s)?|scor(?:e|es|ed|ing)|rating|(?:most|least)\s+(?:reliable|faithful|committed|dependable)|best\s+(?:person|choice|fit|option|pick|candidate|volunteer)|top\s+(?:picks?|choices?|candidates?)|first\s+choice|second\s+choice)\b|\d\s?%/u;
// Structural ranking: an ordinal or comparison within three words of a person label, or between two.
// Checked on the folded answer with each person label as \u0001.
const RANK_WORD = "\\d+(?:st|nd|rd|th)|#\\s?\\d+|number\\s+(?:one|two|three|[1-9])|first|second|third|fourth|fifth|then|strongest|weakest|best|better|worst|worse|top|ranked|ranking|ranks?|likeliest|(?:most|least|more|less)\\s+(?:likely|dependable|reliable|committed|faithful|consistent|available|suitable|qualified|experienced|willing|eager|responsive|capable|trustworthy)|stronger|weaker|preferred|ideal|go-to";
const WORD_RUN = "[\\p{L}\\p{N}'-]+", BETWEEN = "[^\\p{L}\\p{N}'\\u0001-]+";
export const NEAR_PERSON = new RegExp([
  `\\u0001(?:${BETWEEN}${WORD_RUN}){0,3}?${BETWEEN}(?:${RANK_WORD})(?![\\p{L}\\p{N}])`,
  `(?<![\\p{L}\\p{N}])(?:${RANK_WORD})(?:${BETWEEN}${WORD_RUN}){0,3}?${BETWEEN}\\u0001`,
  `\\u0001(?:${BETWEEN}${WORD_RUN}){0,2}?${BETWEEN}(?:over|before|ahead\\s+of|rather\\s+than|instead\\s+of|followed\\s+by|than|above|below|behind)${BETWEEN}(?:${WORD_RUN}${BETWEEN}){0,2}?\\u0001`,
  "\\u0001\\s*[>›»]\\s*\\u0001",
].join("|"), "u");
/** Markdown emphasis around a label ("**[Person 1]**") is dropped before checking, so a label is never refused for it. */
const unwrapLabels = (text: string) => text.replace(/([*_`]{1,3})(\[(?:Person [1-9]\d{0,3}|Role [1-9]\d{0,3}|Your name|a team member)\])\1/gu, "$2");

/** Check a model reply before anyone sees it. Throws a plain message; rejected replies are never shown or restored. */
export function acceptAskReply(reply: string, question: AskedQuestion): CheckedAnswer {
  if (!asked.has(question)) throw new Error("Unknown question.");
  const text = unwrapLabels(reply.normalize("NFKC").replace(/[\p{Cf}\p{Co}]/gu, "").replace(/\r\n?/g, "\n").trim());
  if (!text || text.length > MAX_ANSWER_CHARS) throw new Error(ANSWER_PROBLEMS.unusable);
  const problem = labelProblem(text, question.allowed);
  if (problem) throw new Error(problem === "unknown" ? ANSWER_PROBLEMS.label : ANSWER_PROBLEMS.apart);
  const plain = fold(withoutLabels(text, " ")).replace(/\s+/gu, " ");
  if (NOT_OURS.test(plain) || RELIGIOUS_REPLY.test(plain)) throw new Error(ANSWER_PROBLEMS.religious);
  if (CLAIMS.test(plain)) throw new Error(ANSWER_PROBLEMS.claim);
  const marked = fold(text.replace(LABEL, l => l.startsWith("[Person ") || l === TEAM_MEMBER ? " \u0001 " : " ")).replace(/\s+/gu, " ");
  if (RANKED.test(plain) || NEAR_PERSON.test(marked)) throw new Error(ANSWER_PROBLEMS.rank);
  if (CHARACTER.test(plain)) throw new Error(ANSWER_PROBLEMS.describe);
  // Display check, not the outbound boundary: the model was never given a name, so any roster name
  // written as a word was invented. Whole words (with case, accents, possessives and unspaced scripts),
  // so ordinary words like "same" are not mistaken for "Sam".
  const names = question.context.names as Names;
  if (containsNameWord(text, names)) throw new Error(ANSWER_PROBLEMS.name);
  const answer = Object.freeze({ text, asked: question });
  checked.add(answer);
  return answer;
}

export interface AskAnswer {
  /** Restored on this Mac. */
  readonly body: string;
  /** A drafted note, restored with first names. Shown as "Draft only. Nothing has been sent." with Copy only. */
  readonly draft: string | null;
  /** The model said the facts don't fully answer the question. */
  readonly notCovered: boolean;
  /** Labels the answer used, to link back to findings. */
  readonly labels: readonly string[];
  /** Links to the findings the answer refers to. */
  readonly links: readonly AskLink[];
}
const MARKER = /^[\s*_#>-]*draft note:[\s*_]*/iu;
/** A greeting to someone whose name isn't known here; restored as "Hi there". */
const GREETING = /\b(hi|hello|hey|dear)(\s+)(\[(?:Person [1-9]\d{0,3}|a team member)\])/giu;
/** Local only: put names, position names and the sender back. Someone this Mac has no name for, or a
 *  name part several people share, is "a team member" (in a greeting, "Hi there"), never "someone". */
export function restoreAnswer(answer: CheckedAnswer, sender: string): AskAnswer {
  if (!checked.has(answer)) throw new Error("Only a checked answer can be shown.");
  const { text, asked: q } = answer;
  const names = q.context.names as Names;
  const known = (label: string) => {
    const id = q.people.get(label);
    return (id !== undefined && names[id]?.trim()) || null;
  };
  const restore = (part: string, first: boolean) => part
    .replace(GREETING, (whole, hi: string, gap: string, label: string) => known(label) === null ? `${hi}${gap}there` : whole)
    .replace(LABEL, label => {
      if (label === "[Your name]") return sender.trim() || "[Your name]";
      const role = q.roles.get(label);
      if (role !== undefined) return role;
      const name = known(label);
      if (name === null) return "a team member";
      return first ? name.split(/\s+/u)[0]! : name;
    }).replace(/\*\*/g, "");
  const lines = text.split("\n");
  const at = lines.findIndex(l => MARKER.test(l));
  let body = text, draft: string | null = null;
  if (at >= 0) {
    body = lines.slice(0, at).join("\n").trim();
    draft = [lines[at]!.replace(MARKER, ""), ...lines.slice(at + 1)].join("\n").trim() || null;
  } else if (q.draft) { body = ""; draft = text; }
  const labels = labelsIn(text);
  return Object.freeze({
    body: restore(body, false), draft: draft === null ? null : restore(draft, true),
    notCovered: fold(text).startsWith(fold(NOT_COVERED)), labels,
    links: q.context.links.filter(l => l.terms.some(t => labels.includes(t))),
  });
}

/** Up to four questions that fit what was read. Local text; asking one still goes through prepareAsk,
 *  which sends each position as its [Role N] label like the facts. The note it suggests is one Ozzie's drafting
 *  tool can prepare: to someone the check listed for a role that still needs people (structured answers show only
 *  that tool's draft, never one the AI writes). */
export function suggestedQuestions(brief: SundayBrief | null): string[] {
  if (!brief) return [];
  const thisOne = (brief.day ?? SUNDAY_WORDS).thisOne;
  const role = (f: Finding) => f.position?.name.replace(/\s+/gu, " ").trim() ?? "";
  // A church system that ties no team to its roles (Breeze) lists no one who could cover: neither question is offered.
  const open = brief.findings.find(f => f.kind === "needs-people" && role(f) && !(brief.source && !f.people));
  const flagged = brief.findings.find(f => role(f));
  // A church system that ties no team to its roles (Breeze): what works there, each answered on this Mac from who is on
  // each role (compose.ts rosterQuestion, round 5). The note names no one: it is to whoever hasn't answered for a role.
  // The same test as Ask's own answers (compose.ts rosterQuestion): what the system is, and who is on each role.
  const teamless = Object.values(SYSTEMS).find(s => s.name === brief.source)?.teamMembers === false;
  const roster = teamless && brief.roster && brief.roster.roles.length > 0 ? brief.roster : null;
  if (roster) {
    const waiting = roster.roles.filter(r => r.waiting.length > 0);
    const note = brief.findings.find(f => f.kind === "pending" && role(f) && waiting.some(r => r.name === f.position?.name && r.waiting.length === 1));
    return [
      `Who is scheduled ${thisOne}?`,
      ...(waiting.length ? ["Who hasn't answered yet?"] : []),
      ...(brief.findings.some(f => f.tone === "decision") ? [`What still needs a decision ${thisOne}?`] : []),
      ...(flagged ? [`Why is ${role(flagged)} flagged?`] : []),
      ...(note ? [`Draft a note to the person who hasn't answered for ${role(note)}`] : []),
    ].slice(0, 4);
  }
  const out = [
    ...(open ? [`Who could cover ${role(open)}?`] : []),
    ...(brief.findings.some(f => f.tone === "decision") ? [`What still needs a decision ${thisOne}?`] : []),
    ...(flagged ? [`Why is ${role(flagged)} flagged?`] : []),
    ...(open ? [`Draft a note to someone who could cover ${role(open)}`] : []),
    ...(brief.findings.length === 0 ? [`What did you check for ${thisOne}?`] : []),
  ];
  return out.slice(0, 4);
}
