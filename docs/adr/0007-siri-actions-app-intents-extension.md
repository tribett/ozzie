# Siri actions as an App Intents extension bundled with Ozzie

Status: proposed by the Siri actions lane, 2026-11-16, for the owner's decision "Real Siri actions (App Intents):
install Xcode and build them now" (owner decisions, "2026-11-15 (end of Session B)"). It replaces ADR 0006's Run
Shell Script shortcut as the first way to ask, once shown working in a notarized build. Built and tested here, and the
placement was shown to be discovered by this Mac with a throwaway probe. Not yet shown with Ozzie itself (see the end).

A leader should be able to ask "Is Sunday covered?" from Siri, Spotlight or the Shortcuts app, and open Ozzie's Today
or Sunday page the same way, with nothing to set up and without Shortcuts' "Allow Running Scripts".

## Where the actions live

The system finds an app's actions (App Intents) through a `Metadata.appintents` folder that Xcode writes into the
bundle that holds them. Two places can hold them in a Developer ID app:

- **Ozzie's own program**: Swift intents linked into the Rust/Tauri executable, the metadata in `Contents/Resources`.
  Two Developer ID apps on this Mac are found this way. But the system answers an action there by
  starting Ozzie itself, with its window, its scheduled checks and its microphone and calendar entitlements, to say
  "Is Sunday covered", and the Swift would have to be forced into the Rust link. Not tried further.
- **An App Intents extension** (ExtensionKit, `Contents/Extensions/*.appex`, extension point
  `com.apple.appintents-extension`): a small process of its own that the system starts for the action and that never
  opens Ozzie's window. Every extension is sandboxed, so reaching the copy needs a file exception or an app group.

A Swift package or framework still needs one of these two to host it, so it doesn't change the choice.

## What was shown on this Mac (2026-11-16, macOS 27.2.1, Xcode 27.2)

A throwaway probe with its own identifier (`church.ozzie.intentsprobe`): a plain AppKit program built with swiftc,
standing in for Ozzie's Rust program, with an extension built by xcodebuild from a one-target project. Both were signed
with the Developer ID and the hardened runtime, not notarized. Removed from LaunchServices and disk afterwards.

- **Registered but never opened, in a folder on an external disk**: linkd audited the app and found nothing, and LaunchServices
  had no record of the extension ("No appex record").
- **Copied to ~/Applications, registered, opened once in the background** (`open -g -j`): LaunchServices registered the
  extension (`pluginkit -m -i …intents` lists it). linkd logged that it was "Checking …/ProbeIntents.appex/Contents/
  Resources/Metadata.appintents/extract.actionsdata", indexed 2 intents, "Generated 2 AppShortcuts with 3 total
  phrases" and donated them to Siri. Shortcuts' own action index (`~/Library/Shortcuts/ToolKit`) listed both actions
  under the probe's identifier, with their titles and descriptions.
- **The sandbox**, using a program signed with the extension's entitlements (App Sandbox, and a read-only exception for
  two files relative to the home folder):
  - It read the copy and found the marker.
  - Another file in the same folder, and the folder's listing, were refused (EPERM).
  - HOME was the program's own container; the user database gave the real home folder.
  - JavaScriptCore ran without JIT.
  - It opened a link in a given app (`NSWorkspace.open(_:withApplicationAt:)`), and that app received the link.
- **Not shown from the command line**: running an action. `shortcuts run` runs only shortcuts in the library, and the
  system's own way to run an action is private.

## Decision

**An App Intents extension, `Ozzie.app/Contents/Extensions/OzzieIntents.appex`** (`church.ozzie.desktop.intents`,
helpers/siri-actions.swift), with three actions:

- "Is Sunday covered" says the answer and hands it to the next step of a shortcut. Ozzie's window doesn't open.
- "Open Ozzie's Sunday page" and "Open Ozzie's Today page".
- An App Shortcuts provider with seven phrases, each naming the app ("Is Sunday covered in Ozzie", "Open Sunday in
  Ozzie", …), so Siri and Spotlight offer them with no setup.

**One way in, not a second boundary.** helpers/shortcuts-answer.swift is the helper's answering, moved out of it
unchanged and built into both: the marker checked before and after; the copy opened read-only without following a
link, at most MAX_SHARED_BYTES; `core/mcp/shortcuts.ts` run in JavaScriptCore from the script linked into each binary.

- "Is Sunday covered" asks it "sunday", the helper's own question.
- The pages open only while the switch is on; otherwise the action says the helper's "turned off" sentence.
- No new read, no new data in the copy, nothing new said.
- A test compiles the actions' own code with a small check program and compares each answer with the helper's and with
  shortcuts.ts on fixed data: on, off, a missing copy, and a copy that is a link, a pipe, a folder or too large.

**The sandbox reaches exactly two files** (Entitlements-intents.plist): App Sandbox, and a read-only exception for
`Library/Application Support/church.ozzie.desktop/shortcuts-check.json` and `.shortcuts-check.on` in the home
folder. The App Store refuses such exceptions; Developer ID apps may use them. An app group would move the copy and
change native code, and isn't needed. The extension reads the account's home from the user database, because HOME is
its container.

**Pages open with the existing links**, `ozzie://today` and `ozzie://sunday` (shortcuts.rs checks them), sent to the
Ozzie the extension came with rather than to whichever app claims `ozzie://`.

**Built with Xcode, and fails closed without it.** The Command Line Tools have no `appintentsmetadataprocessor`.

- build.rs runs xcodebuild on `intents/OzzieIntents.xcodeproj`: one target, the three Swift files, and the answers
  script linked in with `-sectcreate`.
- Xcode is found from DEVELOPER_DIR when that is set; otherwise from xcode-select; otherwise /Applications/Xcode.app.
- Xcode supplies the list of protocols the compiler extracts constants for and writes `Metadata.appintents`. Calling
  swiftc and the metadata tool by hand would mean copying an internal list that changes with Xcode.
- Without Xcode, build.rs removes any older copy and prints a warning. `cargo build`, `cargo test` and `tauri dev`
  still work. `tauri build` stops at the missing extension (tauri.conf.json `bundle.macOS.files`), so no app is bundled
  without its actions or with older ones.

**Signing.**

- build.rs signs the extension ad hoc with its entitlements, so a local bundle is whole. tauri copies it into the
  bundle without signing it.
- tools/release-mac.sh requires Xcode, then signs the extension with the Developer ID, hardened runtime, a timestamp
  and only its own entitlements, before sealing the app again.
- The script then checks the extension's signature and entitlements, that it carries this run's answers (the same
  script as ozzie-shortcuts), and that its metadata lists the three actions.

**What stays for now.** The helper, the Run Shell Script steps and the `ozzie://` links stay until the actions are
shown working in a notarized build (owner decision). In Settings, Ozzie's actions now come first and the steps by
hand are folded under "Make the shortcuts yourself instead". A build without the extension (development) shows the
steps by hand, as before.

## Not yet shown

- **Ozzie itself (`church.ozzie.desktop`) found and its actions run.** That needs a notarized build in /Applications,
  opened once. Then in Shortcuts, check that the three actions appear under Ozzie. Run "Is Sunday covered" with the
  switch on and off, and open both pages. Also try a Siri phrase, and Spotlight.
- **An app opened from an external disk.** Spotlight treats that disk as removable, and the probe was shown only from
  ~/Applications. Whether an app opened from there registers its extension is unknown; keep Ozzie in /Applications.
- **Whether opening a page brings Ozzie to the front.** The extension asks it to; macOS decides.
- **macOS 14 and 15.** The extension is built for 14.0 and shown only on 27.2.

## What the notarized app showed (2026-11-16, macOS 27.2)

- **Found and run.** Installed in Applications and opened once, the system registered the extension, generated the
  three App Shortcuts with their seven phrases, and listed the three actions in Shortcuts' index. From Spotlight, typed
  by their names, "Is Sunday covered" answered with the helper's own sentence (and the off sentence while the switch
  was off), and the two open actions brought Ozzie forward on the right page.
- **Not run by Siri.** The newest Siri heard "Is Sunday covered in Ozzie?" correctly (after "Aussie" and "Ozzy" were
  added as other names for the app) and answered it as a general question; typed, it said it could not run the
  command or open a page inside Ozzie. A control with another Developer ID app's App Shortcut phrase got "Sorry, I
  don't understand." So on this macOS the new Siri runs no plain App Shortcuts from apps like these. Apple's Siri
  preview documentation describes a different route (intents marked as Siri tools, or schema intents) that it says is
  not available to published builds yet; whether a Developer ID build can use it is not documented. Not built.
- **So Settings promises Spotlight and Shortcuts, not Siri**, and says what the newest Siri does. Typing the full Siri
  phrase into Spotlight hands the question to Siri; the actions' names are what Spotlight runs.

