// The placeholder boundary (never-list: real people's names never go to a model).
//
// Design: a blocklist can't catch nicknames or names that aren't on the roster, so the model is
// never given free text that a person typed. It only rewords a placeholder-form draft that this
// module produced itself (its own template, or a model reply it has checked), using one of a
// fixed set of choices. The only source text sent is the position name, and if any roster name
// part appears in it (or it could read as contact details, or is too long for a note), the whole
// position name is replaced with [Role]. Names are put back on this Mac only.
import type { Finding } from "./sunday-brief.js";

export const REWORDINGS = { warmer: "Make it warmer.", shorter: "Make it shorter.", casual: "Make it more casual.", formal: "Make it a little more formal." } as const;
export type Rewording = keyof typeof REWORDINGS;
export interface DraftContext { finding: Finding; person_id: string }
export interface DraftModelRequest { system: string; user: string; max_tokens: number }
/** Text in placeholder form that this module produced. Leader-typed text cannot become one. */
export interface PlaceholderDraft { readonly text: string; readonly role: { readonly sent: string; readonly original: string } }

const SYSTEM = [
  "You help a church volunteer coordinator word a short, kind, plain note asking one volunteer whether they can serve.",
  "Reply with only the revised note. Keep each of [Volunteer A], [Role] and [Your name] that appears in the note exactly as written; add no names and no other bracketed text.",
  "Make it easy to say no. No guilt, pressure, flattery, scripture, prayers, blessings, sermons or devotional content. Under 90 words.",
].join(" ");
const LABELS = ["[Volunteer A]", "[Role]", "[Your name]"];
const issued = new WeakSet<PlaceholderDraft>();
const mint = (text: string, role: PlaceholderDraft["role"]): PlaceholderDraft => {
  const draft = Object.freeze({ text, role: Object.freeze({ ...role }) });
  issued.add(draft);
  return draft;
};

/** Letters that keep their stroke or ligature through NFD, spelled the way people type them without it.
 *  Greek final sigma is unified with sigma. Mirrored natively (name_guard.rs `fold`). */
const PLAIN_LETTERS: Readonly<Record<string, string>> = {
  "ø": "o", "ł": "l", "đ": "d", "ħ": "h", "ı": "i", "ß": "ss", "æ": "ae", "œ": "oe", "þ": "th", "ð": "d", "ς": "σ",
};
/** Comparison form: compatibility-normalized, accents and invisible/private/tag characters removed, apostrophes and
 *  dashes unified, lowercased, then stroked letters and ligatures spelled plainly (ø → o, ß → ss). */
export const fold = (s: string) => s.normalize("NFKC").replace(/[\p{Cf}\p{Co}͏︀-️\u{E0000}-\u{E007F}]/gu, "")
  .normalize("NFD").replace(/\p{M}/gu, "").replace(/[‘’ʼʹ`´]/g, "'").replace(/[‐-―−]/g, "-").toLowerCase()
  .replace(/[øłđħıßæœþðς]/g, c => PLAIN_LETTERS[c]!);
export const UNSPACED = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
/** Name parts worth matching: the full name, each piece split on spaces/hyphens/apostrophes/dots, and joined forms. */
export function nameTerms(names: Record<string, string>): string[] {
  const terms = new Set<string>();
  for (const full of Object.values(names)) {
    const f = fold(full).trim();
    if (!f) continue;
    const pieces = f.split(/[^\p{L}\p{N}]+/u);
    const joined = f.split(/\s+/u).map(seg => seg.replace(/[^\p{L}\p{N}]+/gu, ""));
    for (const t of [f, ...pieces, ...joined]) if (t.length >= 2 || (t.length >= 1 && UNSPACED.test(t))) terms.add(t);
  }
  return [...terms];
}
/** Deliberately broad: substring match for unspaced scripts and 3+ letter parts; letter-only boundaries for 2-letter parts. */
export function containsName(text: string, names: Record<string, string>): boolean {
  const t = fold(text);
  // Letters and numbers only, so "R.i.l.e.y" or "Ri ley" still match (4+ letter and unspaced-script terms).
  const compact = t.replace(/[^\p{L}\p{N}]+/gu, "");
  return nameTerms(names).some(term => (UNSPACED.test(term) || term.length >= 4) && compact.includes(term) ||
    (UNSPACED.test(term) || term.length >= 3 ? t.includes(term)
      : new RegExp(`(?<!\\p{L})${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\p{L})`, "u").test(t)));
}

/**
 * A role name the note can't carry as it is: one that could read as contact details under the shared contact rule
 * (any run of three or more digits, seven or more digits in all, or an @, raw or NFKC: "Rooms 101, 102 & 103"), which
 * Ozzie managed's reword check refuses, or one too long for a note (ozzie.church takes notes of at most 1,200
 * characters). The template's own words around the role hold no digits or @, so the role alone decides.
 */
const roleUnfit = (name: string) =>
  name.length > 300 ||
  [name, name.normalize("NFKC")].some(text => /\p{Nd}{3}/u.test(text) || (text.match(/\p{Nd}/gu) ?? []).length >= 7 || text.includes("@"));

/** Ozzie's own first wording, already in placeholder form. */
export function templateDraft(ctx: DraftContext, names: Record<string, string>): PlaceholderDraft {
  const original = ctx.finding.position?.name ?? "a Sunday role";
  // [Role] is restored to the exact role name on this Mac.
  const role = containsName(original, names) || roleUnfit(original) ? "[Role]" : original;
  const interval = ctx.finding.position?.interval;
  const when = interval ? new Date(interval.starts_at).toLocaleString("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" }) : "this Sunday";
  return mint([
    "Hi [Volunteer A],",
    `We still need one more person for ${role} on ${when}. Would you be able to help this week?`,
    "It's completely fine to say no. Just let me know either way so we can plan.",
    "Thank you,\n[Your name]",
  ].join("\n\n"), { sent: role, original });
}

export function buildRewordRequest(draft: PlaceholderDraft, choice: Rewording, names: Record<string, string>): DraftModelRequest {
  if (!issued.has(draft)) throw new Error("Only Ozzie's own placeholder wording can be sent for rewording.");
  if (!Object.hasOwn(REWORDINGS, choice)) throw new Error("Choose one of the offered rewording options.");
  // The draft was produced here, but never send it if a roster name is somehow present.
  if (containsName(draft.text.split(/\[(?:Volunteer A|Role|Your name)\]/).join(" "), names)) throw new Error("A name was present in the draft request, so nothing was sent.");
  return { system: SYSTEM, user: `${REWORDINGS[choice]}\n\nNote:\n${draft.text}`, max_tokens: 400 };
}

export const BOOKS = "gen|exod?|lev|num|deut|josh|judg|ruth|sam|kgs|kings|chr|chron|ezra|neh|esth|job|ps|prov|eccl?|song|isa|jer|lam|ezek|dan|hos|joel|amos|obad|jonah|mic|nah|hab|zeph|hag|zech|mal|matt?|mark|luke|john|acts|rom|cor|gal|eph|phil|col|thess|tim|titus|philem|heb|james|jas|pet|jude|rev";
// Religious content, or a scripture reference ("John 3:16", "1 Cor 13:4") — a book name is required, so "at 9:30" is fine.
export const NOT_OURS = new RegExp(`\\b(pray\\w*|sermon\\w*|devotion\\w*|scripture\\w*|bless\\w*|psalm\\w*|amen|homil\\w*|gospel\\w*|bible\\w*|verse\\w*|god|lord|jesus|christ)\\b|\\b(?:[1-3]\\s?)?(?:${BOOKS})[a-z]*\\.?\\s\\d{1,3}:\\d{1,3}\\b`, "i");
/** Labels may only touch whitespace/edges, an opening quote or bracket before, or closing punctuation then whitespace after. */
const STANDALONE = /(?<=^|[\s("'\u201C\u2018])\[(?:Volunteer A|Role|Your name)\](?=[,.!?:;)"'\u201D\u2019]*(?:\s|$))/gu;
const labelsStandalone = (text: string) => (text.match(/\[(?:Volunteer A|Role|Your name)\]/g) ?? []).length === (text.match(STANDALONE) ?? []).length;
/** Check a model reply before anyone sees it. Rejected replies are never shown or restored. */
export function acceptModelReply(reply: string, previous: PlaceholderDraft, names: Record<string, string>): PlaceholderDraft {
  if (!issued.has(previous)) throw new Error("Unknown draft.");
  const text = reply.normalize("NFKC").replace(/[\p{Cf}\p{Co}]/gu, "").trim();
  const brackets = text.match(/\[[^\]]*\]/g) ?? [];
  if (!text || text.length > 1200) throw new Error("The reworded draft wasn't usable. Your current draft is unchanged.");
  // An added or dropped [Role] is harmless: it restores to the original role name on this Mac.
  if (!text.includes("[Volunteer A]") || brackets.some(b => !LABELS.includes(b)) || !labelsStandalone(text))
    throw new Error("The reworded draft changed who it's addressed to. Your current draft is unchanged.");
  if (NOT_OURS.test(fold(text))) throw new Error("The reworded draft added religious content Ozzie doesn't write. Your current draft is unchanged.");
  if (containsName(text.split(/\[(?:Volunteer A|Role|Your name)\]/).join(" "), names)) throw new Error("The reworded draft mentioned a name. Your current draft is unchanged.");
  return mint(text, previous.role);
}

/** Local only: put the real first name, the exact role and the sender back. */
export function restoreDraft(draft: PlaceholderDraft, ctx: DraftContext, names: Record<string, string>, sender: string): string {
  const first = (names[ctx.person_id] ?? "").trim().split(/\s+/)[0] || "there";
  return draft.text.split("[Volunteer A]").join(first).split("[Role]").join(draft.role.original).split("[Your name]").join(sender.trim() || "[Your name]");
}
