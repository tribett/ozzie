# Siri and Shortcuts through Shortcuts' own actions, not App Intents (for now)

Status: proposed by the build lane, 2026-11-15, for the owner's "Siri and Shortcuts" (owner decisions,
"New connections", 2026-11-15). Its "Later" is now ADR 0007 (2026-11-16): Ozzie's Siri actions, an App Intents
extension answering with this helper's own code, come first; the Run Shell Script shortcut below is the fallback until
they are shown in a notarized build.

A leader should be able to ask "Is Sunday covered?" from Siri, Spotlight or the Shortcuts app without
opening Ozzie's window, and to open Ozzie's Sunday page the same way.

## Options

**App Intents** (Apple's way for an app's actions to appear in Shortcuts and Siri by themselves) are
found by the system only through a `Metadata.appintents` folder in the app or extension bundle. Xcode
writes it at build time: the Swift compiler extracts constant values and Xcode's
`appintentsmetadataprocessor` turns them into the metadata. That tool ships with Xcode only. The Mac that
builds and signs Ozzie has the Command Line Tools and no Xcode (checked 2026-11-15:
`xcrun --find appintentsmetadataprocessor` and `xcrun --find xcodebuild` both fail), and writing the
metadata by hand is undocumented. An App Intents extension would also have to be sandboxed (every macOS
app extension is) and reach the saved check through an app group or a read-only file exception. So App
Intents can't be built, let alone shown to work, in Ozzie's current build.

**Shortcuts' own actions** work today with documented features:

- Siri runs any shortcut by its name, and Spotlight finds shortcuts.
- A shortcut named "Is Sunday covered" runs Ozzie's bundled helper with a **Run Shell Script** action
  (`'…/Ozzie.app/Contents/MacOS/ozzie-shortcuts' sunday`) and shows or speaks what it prints. Run Shell
  Script needs Shortcuts' Settings > Advanced > Allow Running Scripts, once.
- A shortcut named "Open Ozzie's Sunday page" uses **Open URLs** with `ozzie://sunday`.

The costs: the leader makes the two shortcuts by following steps in Settings (a ready-made shortcut file
has to be signed through iCloud and would carry one install's path), and must turn on Allow Running
Scripts. That setting is for all of Shortcuts on the Mac, not only Ozzie's: once it's on, any shortcut
the leader has or adds later can run commands as them, with everything their account can read
(Ozzie's saved recordings, with volunteers' names, included). Settings says so before the steps, and
that it can be turned off again (review K M3).

## Decision

Shortcuts' own actions now. "Let Siri and Shortcuts ask Ozzie" in Settings, off by default, with the
steps and a copy button for the command and the link.

- **What answers.** The helper `ozzie-shortcuts` (Swift, no entitlements, built and signed like
  `ozzie-share`) runs `core/mcp/shortcuts.ts` in JavaScriptCore. It reads only a copy on this Mac; it
  never reads Planning Center, calls a model or reaches a network.
- **The copy is the copy for other AI apps made smaller, not a second boundary.** The webview hands in the
  Sunday overview from the same read-only agent tools. Native writes it with the same checks
  (`shared_check.rs`: the closed grammar, every name this session has shown, contact details,
  background-check wording) to `shortcuts-check.json`, beside its own marker `.shortcuts-check.on`, with no
  task rows. The helper reads it back with the same `parseSharedCheck`. The two switches and copies are
  independent.
- **What is said.** Only counts, dates and fixed words, never a label: "Sunday, November 22 has 2 open
  spots across 2 roles. 1 person is pending, and Planning Center shows the request hasn't been sent yet.
  Checked in Planning Center today at 10:00 AM." Who is pending is said once, in the Sunday page's
  words, with requests sent apart from those not sent yet. What Ozzie marks worth a
  look (a kids team it can't place someone in, a lead it couldn't confirm) is said as "Worth a look",
  never as fact. Reads that didn't complete say the answer may be incomplete, a recording too; a list
  cut for length says every count as "at least" and that the list was too long to say in full. A
  check more than 30 minutes old is said in the past tense with "things may have changed"; a check Ozzie
  itself marked out of date, or one whose time is later than the Mac's clock, gives no counts; a
  recording says so; the fictional example says it is one, with no check time, since nothing was
  read for it; and a Sunday that has passed says that. Off: "Asking Ozzie from Siri and Shortcuts is turned off in
  Ozzie's Settings." Role names are not said, because the reviewed copy carries roles only as labels.
  Saying them would need a new, reviewed decision.
- **Links.** `ozzie://` is declared in Info.plist and handled with Tauri's own `RunEvent::Opened`. The
  deep-link plugin does the same on macOS and would add a dependency. A link's text must be exactly
  `ozzie://today` or `ozzie://sunday` (one closing slash allowed), only while the switch is on, and
  nothing else from a link is used. A link that arrives while guided setup is showing is ignored.
  Limit: tao parses the link before Ozzie sees it, which drops an empty user part, an empty port, dot
  segments and surrounding white space, so those spellings arrive as the plain link. Telling them
  apart would need Ozzie's own Apple-event handler in place of tao's.

## Later

With Xcode on the release Mac, App Intents can replace the Run Shell Script step: an App Intents
extension (or intents in a small embedded Swift target) calling the same answer function over the same
copy. Then the actions appear in Shortcuts by themselves, and no script setting is needed. Whether the
system discovers intents in that placement has to be shown on a built, signed app before anything is
promised.
