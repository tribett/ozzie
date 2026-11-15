// Suggested visitor-card fields from text recognized on this Mac, the lines it read for a person to
// place, possible matches with people in the current Sunday check, follow-ups the visitor explicitly
// asked for, and the plain list a person copies at the end of a review.
// Pure and conservative: nothing here repairs, guesses, summarizes or remembers card content.
// Every suggestion still needs a person to check it against the photo.
import type { FieldName, Reading } from "./card-review/lifecycle.js";

/** `more`: there is more writing after a request on the card, so it may go on; never a clean reading. */
export interface Suggestion { readonly text: string; readonly unclear: boolean; readonly more?: true }
export type Suggestions = Readonly<Record<FieldName, Suggestion>>;
/** The native reader returns at most this much text; anything larger is treated as unreadable. */
export const RECOGNIZED_TEXT_MAX = 16384;
const LIMIT: Record<FieldName, number> = { name: 256, phone: 256, email: 256, request: 2000 };

const none: Suggestion = { text: "", unclear: false };
const unclear: Suggestion = { text: "", unclear: true };
const blankAll = (s: Suggestion): Suggestions => ({ name: s, phone: s, email: s, request: s });

const LABELS: Record<FieldName, RegExp> = {
  name: /^\s*(?:your\s+|full\s+)?name\b\s*[:\-.]?\s*(.*)$/i,
  phone: /^\s*(?:phone|cell|mobile|tel(?:ephone)?)\b(?:\s+(?:number|no\.?|#))?\s*[:\-.]?\s*(.*)$/i,
  email: /^\s*e-?mail\b(?:\s+address)?\s*[:\-.]?\s*(.*)$/i,
  request: /^\s*(?:prayer\s+requests?|requests?|how\s+can\s+we\s+pray(?:\s+for\s+you)?\s*\??)(?![\p{L}])\s*[:\-.]?\s*(.*)$/iu,
};
/** Other labels (with a colon) that end a request; the request never swallows the next part of the card. */
const OTHER = /^\s*(?:address|street|city|state|zip|date|birthday|children|kids|age|first\s+time|how\s+did\s+you\s+hear|visiting|signature)\b[^:\n]{0,20}:/i;
const PHONE = /^(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-]?)\d{3}[\s.-]?\d{4}$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const NAME = /^\p{L}[\p{L}\p{M}'’.-]*(?: \p{L}[\p{L}\p{M}'’.-]*){0,5}$/u;
/** Characters a request can plainly contain. Anything else (|, ~, ©, …) means "compare every word". */
const REQUEST_SAFE = /^[\p{L}\p{M}\p{N}\s.,;:'"’‘“”!?()&/%–—-]*$/u;

const labelOf = (line: string): FieldName | null => {
  for (const field of ["name", "phone", "email", "request"] as const) if (LABELS[field].test(line)) return field;
  return null;
};
const valueOf = (field: FieldName, line: string) => (LABELS[field].exec(line)?.[1] ?? "").trim();
/** The label part of a labeled line (everything before its value) has a colon: "Phone: …", not "Phone calls from …". */
const colonLabel = (field: FieldName, line: string) => {
  const value = LABELS[field].exec(line)?.[1];
  return value !== undefined && line.slice(0, line.length - value.length).includes(":");
};
const fits = (field: FieldName, text: string) => [...text].length <= LIMIT[field];

/** A label with nothing readable after it is unclear: the value may sit on the next line or be faint. */
function shaped(field: "name" | "phone" | "email", value: string): Suggestion {
  if (!value) return unclear;
  const pattern = field === "name" ? NAME : field === "phone" ? PHONE : EMAIL;
  return pattern.test(value) && fits(field, value) ? { text: value, unclear: false } : unclear;
}

/** A suggestion and the recognized lines it was read from. */
interface Sourced { readonly suggestion: Suggestion; readonly from: readonly number[] }
const unsourced = (suggestion: Suggestion): Sourced => ({ suggestion, from: [] });

/**
 * Only a labeled line counts. An unlabeled number or address may be the church's own, printed on
 * the card, so it is never taken as the visitor's. Two labeled lines are unclear.
 */
function single(field: "name" | "phone" | "email", lines: readonly string[]): Sourced {
  const labeled = lines.flatMap((l, i) => labelOf(l) === field ? [i] : []);
  if (labeled.length > 1) return unsourced(unclear);
  if (!labeled.length) return unsourced(none);
  const value = valueOf(field, lines[labeled[0]!]!);
  return { suggestion: shaped(field, field === "name" ? value.replace(/\s+/g, " ") : value), from: labeled };
}

function request(lines: readonly string[]): Sourced {
  const start = lines.findIndex(l => labelOf(l) === "request");
  if (start < 0) return unsourced(none);
  if (lines.slice(start + 1).some(l => labelOf(l) === "request")) return unsourced(unclear);
  const body: string[] = [];
  const from = [start];
  const first = valueOf("request", lines[start]!);
  if (first) body.push(first);
  let end = lines.length;
  // Only a label with a colon cleanly ends the request. "Phone calls from the hospital scare me."
  // or "Email me if you need anything." may be the request going on, so it stops there unclear.
  let cut = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const field = labelOf(line);
    if (field !== null || OTHER.test(line)) { end = i; cut = field !== null && !colonLabel(field, line); break; }
    if (!line.trim()) { if (body.length) { end = i; break; } continue; }
    body.push(line.trim());
    from.push(i);
  }
  const text = body.join("\n");
  if (!text) return { suggestion: cut ? unclear : none, from };
  if (!fits("request", text)) return { suggestion: unclear, from };
  // Any unlabeled words after where the request stopped may still be part of it: never show a
  // possibly shortened request as a clean reading.
  const after = lines.slice(end).some(l => l.trim() && labelOf(l) === null && !OTHER.test(l));
  const more = cut || after;
  return { suggestion: { text, unclear: more || !REQUEST_SAFE.test(text), ...(more ? { more: true as const } : {}) }, from };
}

/**
 * Conservative field suggestions from recognized card text. Unclear readings are flagged, never repaired.
 * `unclearLines` are the lines of `recognized` (from 0) the reader couldn't read clearly: a field read
 * from any of them keeps its text only as a suggestion to check against the card, flagged unclear.
 */
export function suggestFields(recognized: string, unclearLines: readonly number[] = []): Suggestions {
  if (typeof recognized !== "string") return blankAll(none);
  if (recognized.length > RECOGNIZED_TEXT_MAX) return blankAll(unclear);
  const lines = recognized.split(/\r\n|\r|\n/);
  const hard = new Set(unclearLines);
  const flagged = ({ suggestion, from }: Sourced): Suggestion =>
    from.some(i => hard.has(i)) ? { ...suggestion, unclear: true } : suggestion;
  return {
    name: flagged(single("name", lines)),
    phone: flagged(single("phone", lines)),
    email: flagged(single("email", lines)),
    request: flagged(request(lines)),
  };
}

/** One line of what this Mac read on a card: `line` is its number in the recognized text (from 0). */
export interface ReadLine { readonly line: number; readonly text: string; readonly unclear: boolean }

/**
 * Every line this Mac read on a card, for the person to put into a field themselves. Nothing here
 * chooses a field: an unlabeled line may be the church's own details printed on the card.
 */
export function readLines(recognized: string, unclearLines: readonly number[]): ReadLine[] {
  if (typeof recognized !== "string" || recognized.length > RECOGNIZED_TEXT_MAX) return [];
  const hard = new Set(unclearLines);
  return recognized.split(/\r\n|\r|\n/).flatMap((raw, line) => {
    const text = raw.trim();
    return text ? [{ line, text, unclear: hard.has(line) }] : [];
  });
}

/** Lowercase letters only, accents and punctuation removed, so "Sám Whitcombe." and "sam whitcombe" compare equal. */
export function nameTokens(name: string): string[] {
  if (typeof name !== "string") return [];
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/['’]/g, "")
    .replace(/[^\p{L}]+/gu, " ").trim().split(" ").filter(Boolean);
}
const sameName = (a: string[], b: string[]) => a.length >= 2 && b.length >= 2 &&
  (a.join(" ") === b.join(" ") || (a[0] === b[0] && a.at(-1) === b.at(-1)));

/** People in the current Sunday check whose name matches a card's name. A suggestion for a person to check; never merged. */
export function possibleMatches(cardName: string, people: Readonly<Record<string, string>>): string[] {
  const card = nameTokens(cardName);
  return Object.entries(people).filter(([, name]) => sameName(card, nameTokens(name)))
    .sort(([a, x], [b, y]) => x.localeCompare(y) || a.localeCompare(b)).map(([id]) => id);
}

/** Groups of cards in this batch that carry the same name. */
export function sameNameCards(cards: readonly { id: number; name: string }[]): number[][] {
  const groups: number[][] = [];
  const used = new Set<number>();
  for (const card of cards) {
    if (used.has(card.id)) continue;
    const group = cards.filter(other => !used.has(other.id) && sameName(nameTokens(card.name), nameTokens(other.name))).map(c => c.id);
    if (group.length > 1) { group.forEach(id => used.add(id)); groups.push(group); }
  }
  return groups;
}

/** `by: "person"`: a person typed or changed this field by hand (not read by this Mac). */
export interface ReviewedField { readonly text: string; readonly state: Reading; readonly by?: "person" }
export interface ReviewedCard { readonly label: string; readonly fields: Readonly<Record<FieldName, ReviewedField>> }
const LABEL: Record<FieldName, string> = { name: "Name", phone: "Phone", email: "Email", request: "Request" };

function line(field: FieldName, value: ReviewedField): string {
  const label = LABEL[field];
  if (value.state === "blank") return `${label}: blank on the card`;
  if (value.state === "not-readable") return `${label}: couldn't be read`;
  if (value.state === "unclear" && !value.text) return `${label}: unclear on the card`;
  if (value.state === "unreviewed") return `${label}: not checked`;
  const typed = value.by === "person";
  if (field === "request") {
    return `Request (their exact words${typed ? ", typed by a person" : ""}${value.state === "unclear" ? ", partly unclear" : ""}):\n${value.text}`;
  }
  const notes = [typed ? "typed by a person" : "", value.state === "unclear" ? "unclear on the card, worth a look" : ""].filter(Boolean);
  return `${label}: ${value.text}${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

export type Ask = "call" | "text" | "email" | "contact";
/** Words that only ask for something when the visitor says "me" or "us": never "call my sister". */
const ASKS: readonly (readonly [Ask, RegExp])[] = [
  ["call", /\b(?:call|phone|ring)\s+(?:me|us)\b|\bgive\s+(?:me|us)\s+a\s+(?:call|ring)\b/],
  ["text", /\btext\s+(?:me|us)\b|\bsend\s+(?:me|us)\s+a\s+text\b/],
  ["email", /\be-?mail\s+(?:me|us)\b|\bsend\s+(?:me|us)\s+an?\s+e-?mail\b/],
  ["contact", /\b(?:contact|reach)\s+(?:me|us)\b|\breach\s+out\s+to\s+(?:me|us)\b|\bget\s+in\s+touch\b|\bfollow\s+up\s+with\s+(?:me|us)\b|\bplease\s+send\b|\bsend\s+(?:me|us)\b/],
];
/** How they'd like to be reached, counted only beside an ask in the same part of a sentence ("send it by email"). */
const BY: readonly (readonly [Ask, RegExp])[] = [
  ["call", /\b(?:by|via|over\s+the)\s+phone\b/], ["text", /\b(?:by|via)\s+text(?:\s+message)?\b/], ["email", /\b(?:by|via|through|over)\s+e-?mail\b/],
];
const REFUSAL = /\b(?:not|never|no|don'?t|do\s+not|please\s+don'?t)\b/;

/**
 * The visitor's own explicit ask to be contacted, from a fixed list of words: a suggestion for a
 * person to check, never an inference. A refusal ("please don't call me") cancels its own part.
 */
export function followUpAsks(request: string): Ask[] {
  if (typeof request !== "string") return [];
  const found = new Set<Ask>();
  const parts = request.toLowerCase().replace(/[’‘]/g, "'").split(/[.;!?,\n]+|\bbut\b/);
  for (const part of parts) {
    const asks = ASKS.flatMap(([ask, words]) => {
      const at = part.search(words);
      return at >= 0 && !REFUSAL.test(part.slice(0, at)) ? [ask] : [];
    });
    asks.forEach(ask => found.add(ask));
    if (asks.length) BY.forEach(([ask, words]) => { if (words.test(part)) found.add(ask); });
  }
  const specific = (["call", "text", "email"] as const).filter(ask => found.has(ask));
  return specific.length ? specific : found.has("contact") ? ["contact"] : [];
}

/** A prepared follow-up: their exact words and the contact detail they gave for how they asked to be reached. */
export interface FollowUp { readonly label: string; readonly asked: string; readonly words: string; readonly details: readonly string[] }
const ASKED: Record<Exclude<Ask, "contact">, string> = { call: "a call", text: "a text message", email: "an email" };

function detail(field: "phone" | "email", value: ReviewedField): string {
  const label = field === "phone" ? "Phone they gave" : "Email they gave";
  if (value.text) return `${label}: ${value.text}${value.state === "unclear" ? " (unclear on the card, worth a look)" : ""}`;
  return `${label}: ${value.state === "unclear" || value.state === "not-readable" ? "unclear on the card" : "none on the card"}`;
}

/** A card's prepared follow-up, when its checked request explicitly asks to be contacted. Nothing is sent. */
export function followUpFor(card: ReviewedCard): FollowUp | null {
  const words = card.fields.request.text;
  const asks = words ? followUpAsks(words) : [];
  if (!asks.length) return null;
  const channels = asks.includes("contact") ? (["phone", "email"] as const)
    : (["phone", "email"] as const).filter(f => asks.some(ask => (ask === "email") === (f === "email")));
  const asked = asks.includes("contact") ? "asked to be contacted"
    : `asked for ${asks.map(ask => ASKED[ask as Exclude<Ask, "contact">]).join(" or ")}`;
  return { label: card.label, asked, words, details: channels.map(f => detail(f, card.fields[f])) };
}

/** The plain list a person copies when they finish. The request keeps its exact words. */
export function reviewedList(cards: readonly ReviewedCard[]): string {
  const followUps = cards.flatMap(card => followUpFor(card) ?? []);
  return [
    `Visitor cards checked in Ozzie: ${cards.length}`,
    "Each card was checked against its photo before this list was copied. Nothing was added to Planning Center.",
    "",
    ...cards.flatMap(card => [card.label, ...(["name", "phone", "email", "request"] as const).map(f => line(f, card.fields[f])), ""]),
    ...(followUps.length ? [
      `Prepared follow-ups: ${followUps.length}`,
      "Suggested from the words on these cards. Ozzie didn't call, text or email anyone.",
      "",
      ...followUps.flatMap(f => [`${f.label} ${f.asked}`, `Their words: “${f.words}”`, ...f.details, "Choose who will follow up in your church tools.", ""]),
    ] : []),
  ].join("\n");
}
