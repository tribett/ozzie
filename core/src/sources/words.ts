// What the leader reads about the lists and notes the church added: why one couldn't be shown, what was left out,
// and the frames that keep the church's own words apart from what Ozzie read from Planning Center. A list's rows and
// a note's text are never presented as checked: they are the church's own, shown as written.
//
// Pure: no I/O. Runs in the page.
import { MAX_COLUMNS, type SheetProblem } from "./sheet.js";
import type { NotesProblem } from "./notes.js";
import { MAX_LINKS, type NoteFindingKind } from "./types.js";

/**
 * Problems only a private link to a published sheet gives (native code's codes for core/native-auth's guarded read and
 * the Keychain): not a web address, not https, a user name or password written into it, a place on this Mac or a
 * local network, the website unreachable, too slow, refusing, or sending Ozzie somewhere it doesn't read, a web page
 * instead of the sheet, more private links than Ozzie keeps, a link Ozzie no longer has, the links' own list on this
 * Mac unreadable, and the Keychain locked or refusing.
 */
export const LINK_ONLY_PROBLEMS = [
  "not-an-address", "not-https", "sign-in-in-address", "not-on-the-internet", "unreachable", "timeout", "refused", "moved-elsewhere", "web-page",
  "not-a-sheet", "too-many-links", "link-already-added", "link-missing", "links-unreadable", "keychain-locked", "keychain-denied",
  "links-left-in-keychain",
] as const;
/**
 * Problems native code reports for a source: a chosen file gone, not one macOS lets Ozzie read, an alias of a file
 * rather than the file, in a place Ozzie never reads from (the Library folder, a hidden folder, Ozzie's own), its list
 * on this Mac unreadable, a private link's own (LINK_ONLY_PROBLEMS), or anything else that stopped it (the panel
 * already open, the list not saved): native code's only other code.
 */
export const NATIVE_SOURCE_PROBLEMS = ["file-missing", "not-allowed", "not-the-file", "private-place", "list-unreadable", "pdf", "section-title", ...LINK_ONLY_PROBLEMS,
  "unavailable"] as const;
export type NativeSourceProblem = (typeof NATIVE_SOURCE_PROBLEMS)[number];
export type SourceProblem = SheetProblem | NotesProblem | NativeSourceProblem;

/** Why a list or notes couldn't be shown, in plain words. */
export const SOURCE_PROBLEMS: Readonly<Record<SourceProblem, string>> = Object.freeze({
  workbook: "This looks like a workbook, not a CSV file. In Numbers choose File › Export To › CSV. In Excel choose File › Save As and pick CSV UTF-8. Then choose that file.",
  "too-large": "That file is over 2 MB.",
  "not-text": "That file isn't saved as text, so Ozzie can't show it. Save it as CSV or plain text and choose it again.",
  empty: "That file is empty.",
  "no-header": "That file has no header row.",
  "too-many-columns": `That file has more than ${MAX_COLUMNS} columns. Ozzie shows lists with up to ${MAX_COLUMNS}.`,
  "notes-too-large": "That file is over 1 MB.",
  "file-missing": "Ozzie can't find that file any more (it may have been moved). Choose it again.",
  "not-allowed": "Ozzie isn't allowed to read that file. Choose it again, or move it to a folder Ozzie may read.",
  "not-the-file": "That's an alias of a file, not the file itself. Choose the original file.",
  "private-place": "Ozzie doesn't read files from that folder: it holds this Mac's own settings, hidden files or Ozzie's own. Move the file to Documents or Desktop and choose it again.",
  "list-unreadable": "Ozzie couldn't read which lists and notes you added on this Mac (they may have been saved by a newer Ozzie). Nothing was removed.",
  pdf: "That's a PDF. Ozzie reads lists saved as CSV and notes saved as plain text or Markdown.",
  "section-title": "Ozzie can't show this section on Sunday because of how its title is written. Change the title in the file, then choose again.",
  "not-an-address": "That doesn't look like a web address. Copy the whole link, starting with https://.",
  "not-https": "Ozzie only reads links that start with https://.",
  "sign-in-in-address": "That link has a user name or password written into it. Use the sheet's published link instead.",
  "not-on-the-internet": "That link, or a site it sends Ozzie on to, is on this Mac or a local network, or uses a port other than the usual one, and Ozzie doesn't read those. Use the sheet's published link on the internet.",
  unreachable: "The sheet's website couldn't be reached. Check the internet connection and try again.",
  timeout: "The sheet's website took too long to answer. Try again in a little while.",
  refused: "The sheet's website didn't give Ozzie the sheet. It may no longer be published, or its link may have changed. Copy the link again.",
  "moved-elsewhere": "That link sent Ozzie somewhere it doesn't read (not https, not on the internet, or too many steps away).",
  "web-page": "That address gave back a web page (often a sign-in page) rather than the spreadsheet, or the sheet's first cell starts like a web page's tag. In Google Sheets choose File › Share › Publish to web › Comma-separated values, and copy that link.",
  "not-a-sheet": "That link gave back something other than a spreadsheet. In Google Sheets choose File › Share › Publish to web › Comma-separated values, and copy that link.",
  "too-many-links": `Ozzie reads up to ${MAX_LINKS} private links. Remove one to add another.`,
  "link-already-added": "Ozzie already reads that link for one of your lists on this page.",
  "link-missing": "Ozzie no longer has this list's link on this Mac. Remove this list and add the link again.",
  "links-unreadable": "Ozzie couldn't read its list of private links on this Mac (it may have been saved by a newer Ozzie). The links are still in this Mac's Keychain, and nothing was removed.",
  "keychain-locked": "This Mac's Keychain is locked. Unlock this Mac and try again.",
  "keychain-denied": "This Mac's Keychain didn't let Ozzie use it. Try again, and choose Allow if macOS asks.",
  "links-left-in-keychain": "Ozzie forgot your lists and notes, but this Mac's Keychain didn't answer, so the private links' addresses are still in it. Ozzie removes them the next time you open Lists & notes and the Keychain answers.",
  unavailable: "Ozzie couldn't do that on this Mac just now. Try again.",
});
/** The problems a file and a private link share, said of a link's sheet (it is never a file on this Mac). */
export const LINK_PROBLEMS: Readonly<Partial<Record<SourceProblem, string>>> = Object.freeze({
  workbook: "That link gave back a workbook, not comma-separated values. In Google Sheets choose File › Share › Publish to web › Comma-separated values, and copy that link.",
  "too-large": "That sheet is over 2 MB.",
  "not-text": "That link didn't give back text, so Ozzie can't show it. In Google Sheets choose File › Share › Publish to web › Comma-separated values, and copy that link.",
  empty: "That sheet is empty.",
  "no-header": "That sheet has no header row.",
  "too-many-columns": `That sheet has more than ${MAX_COLUMNS} columns. Ozzie shows lists with up to ${MAX_COLUMNS}.`,
});
/** The problems notes share with a list's file, said of notes: plain text or Markdown, up to 1 MB. */
export const NOTES_WORDS: Readonly<Partial<Record<SourceProblem, string>>> = Object.freeze({
  pdf: "That's a PDF. Ozzie reads notes saved as plain text or Markdown: save or export it as plain text (.txt) from the app that made it, then choose that file.",
  workbook: "That looks like a Word or Pages document, not plain text. Save it as plain text (.txt) from the app that made it, then choose that file.",
  "not-text": "That file isn't saved as text, so Ozzie can't show it. Save it as plain text (.txt) or Markdown and choose it again.",
  "too-large": "That file is over 1 MB.",
});
export const UNKNOWN_PROBLEM = "Ozzie couldn't read that just now. Try again.";
/**
 * A problem in plain words, for a file's list, a link's or notes (`kind`), looked up without prototypes: an unexpected
 * code is never a built-in property.
 */
export const sourceProblem = (code: unknown, kind: "file" | "link" | "notes" = "file"): string =>
  typeof code !== "string" ? UNKNOWN_PROBLEM
    : kind === "link" && Object.hasOwn(LINK_PROBLEMS, code) ? LINK_PROBLEMS[code as SourceProblem]!
      : kind === "notes" && Object.hasOwn(NOTES_WORDS, code) ? NOTES_WORDS[code as SourceProblem]!
        : Object.hasOwn(SOURCE_PROBLEMS, code) ? SOURCE_PROBLEMS[code as SourceProblem] : UNKNOWN_PROBLEM;
/** Each kind of finding a section of notes can be attached to, as the attach choice names the cards it means. */
export const NOTE_KIND_WORDS: Readonly<Record<NoteFindingKind, string>> = Object.freeze({
  "needs-people": "Roles that still need someone",
  pending: "Requests not yet accepted",
  streak: "Serving streaks",
  "lead-missing": "A missing Sunday lead",
  "lead-unverified": "An unconfirmed Sunday lead",
  "too-few-confirmed": "Kids teams below the number your kids rule asks for",
  "background-check": "Missing or expiring background checks",
});

/** What was left out of a list or notes shown, and a note when the letters were a guess (sheet.ts and notes.ts flags). */
export const ROWS_CUT = "Ozzie showed the first 2,000 rows.";
export const CELLS_CUT = "Ozzie shortened some long cells. They end in “…”.";
export const GUESSED_LETTERS = "Some letters may look wrong. Save it as 'CSV UTF-8' for the best result.";
export const GUESSED_LETTERS_NOTES = "Some letters may look wrong. Save the file again as plain text from the app that made it.";
export const LINES_CUT = "Ozzie showed the first 20,000 lines.";
export const LONG_LINES_CUT = "Ozzie shortened some long lines. They end in “…”.";

/** Above a list's rows on a Sunday card. `label` is the leader's name for the list. */
export const listFrame = (label: string) => `From your church's list '${label}' (not checked by Ozzie)`;
/** Above the church's notes, wherever they are shown. */
export const NOTES_FRAME = "Your church's own notes. Ozzie doesn't check or follow these.";
/** On a Sunday card, beside an attached section's title (an "Open" button follows it): the church's own, not checked. */
export const notesBeside = (title: string) => `From your church's own notes (not checked by Ozzie): ${title}`;
/** When a source was last read: `clock` as the page shows times ("9:06 AM"). */
export const readFrom = (shown: string, clock: string) => `Read from ${shown} at ${clock}`;
/** Beside a suggestion in the match table, and the button that makes it the leader's match. */
export const SAME_NAME: Readonly<Record<"team" | "position", string>> = Object.freeze({
  team: "Same name as the Planning Center team",
  position: "Same name as the Planning Center position",
});
export const USE_MATCH = "Use this match";
