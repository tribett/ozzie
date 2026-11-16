# Ozzie's last check in other AI apps

Ozzie can let another AI app on the same Mac (Claude Desktop, or any app that speaks the Model
Context Protocol over stdio) read **Ozzie's last saved Sunday check**. The leader turns this on
in Ozzie under **Settings → Other AI apps → "Use Ozzie's last check in other AI apps"**. It is off
until they do, and turning it off removes the shared copy.

Only the church's current check is shared. When Ozzie has nothing current to share (no check yet
since it opened, a check of another church, the church changed in Settings, Planning Center
disconnected, saved recordings deleted, or a check it refused to share), it removes the copy rather
than leave an older one. Every result says when its facts were checked, not when the copy was saved.

## What it can do

Four tools, none of which takes an argument:

| Tool | What it returns |
|---|---|
| `sunday_readiness` | Where the coming Sunday stands: roles that still need people, requests without an answer, check-ins the Church rules suggest, and what the check couldn't cover. Each part says where it came from (Planning Center Services …) and when it was checked. |
| `rooms_follow_ups_groups` | Room bookings that overlap, overdue follow-ups without an owner, group meetings at someone's serving time, when the church's connection includes Calendar, People and Groups. |
| `church_rules` | The church's rules Ozzie checks against, in words, and the titles and purposes of the procedures Ozzie follows. |
| `what_happened` | What Ozzie did recently: checks, questions and procedures, when they ran and how they ended. |

The words are Ozzie's own sentences, the same templates Ask Ozzie's answers use
(`core/src/harness/compose.ts`). Uncertain items are labelled "Worth a look"; a saved recording or an
out-of-date check says so.

## What it can't do

- **See a name.** People, roles, rooms and follow-up steps appear only as labels such as `[Person 1]`,
  `[Role 2]`, `[Room 1]`. The names Ozzie read from Planning Center stay in Ozzie on the leader's Mac,
  and nothing the server holds could restore them. A label means the same thing only within one
  shared copy. Each copy carries a random copy id (never derived from the data) and every result
  names it; the same label in a copy with another id may refer to a different person, role or room.
- **Read Planning Center.** The server has no Planning Center access, no network code and no
  credentials. It only reads the copy Ozzie wrote at its last check.
- **Change or send anything.** There is no write, send or draft tool. All four tools are marked
  read-only, idempotent and closed-world.
- **See what was asked or answered.** `what_happened` comes from Ozzie's task record, which keeps only
  the kind of task, the procedure, the outcome, times and the names of Ozzie's own read-only tools.
- **Show who could help or prepare a draft.** Those stay inside Ozzie.

What the other AI app keeps or does with what it reads is up to that app and its privacy terms, not
Ozzie. That is why sharing is off by default (harness plan H5: owner decision before it is enabled
for a real organization).

## How the copy is made

```
Ozzie (desktop)                                   another AI app
  last check ─► agent tools (placeholder envelopes) ─► share_last_check (native)
      same tools Ask Ozzie uses                         │  agent_step's tool-message check:
      core/mcp/snapshot.ts                              │  closed grammar, no contact detail,
                                                        │  no name this session has shown
                                                        ▼
                         ~/Library/Application Support/church.ozzie.desktop/shared-check.json (0600)
                                                        │
                                       core/mcp server ─┘ reads it on every call, checks it again
                                       (closed grammar, ledger grammar; any mismatch → nothing shown)
```

1. While sharing is on, the desktop app runs the shared read-only tools (`SHARED_TOOLS` in
   `core/mcp/snapshot.ts`) over the check on screen, after each check, rules change, change of church
   or connection, finished task and once a minute. When the check on screen isn't current for the
   church in Settings (see above), it asks native to remove the copy instead (`clear_shared_check`).
2. The native `share_last_check` command (`core/native-auth/src/shared_check.rs`) checks every result
   exactly as `agent_step` checks a tool result before it may reach a model, adds the newest 20 task
   record rows (without task ids), and writes `shared-check.json` aside-then-rename, mode 0600, with
   `checked_at` (the earliest check time among the results), `shared_at` (when it was saved) and the
   copy id.
3. The server (`core/mcp/`) reads the copy only while native's marker beside it (`.shared-check.on`)
   is a regular file, checked before and after the read. It opens that one file read-only and without
   waiting (a named pipe in its place reads as no file), refuses it whole if anything is outside the
   format (including a `checked_at` that isn't the results' own, or a time with a leap second or a day
   its month doesn't have, checked part by part so every JavaScript engine agrees), and composes the
   answer. Sharing off, no copy, and a file that isn't one Ozzie wrote all get the same reply, word for
   word, so the other app learns nothing about which, or about any other file.

## The helper bundled with Ozzie

Ozzie for Mac carries the server as its own signed helper, `ozzie-share`
(`product/desktop/src-tauri/helpers/share.swift`), beside Ozzie's program in
`Ozzie.app/Contents/MacOS/`. It needs no Node: it runs the same server code in the Mac's own
JavaScriptCore.

- `core/mcp/embedded.ts` is the server with no Node in it: one function from a line of input to the
  line to write back (`McpServer.line`, so batches, parse errors and every answer are the same code),
  with the shared file's text handed in by the host. `pnpm build:share` bundles it into one classic
  script, `core/mcp/dist-share/ozzie-share.js` (git-ignored), with nothing but JavaScript in it.
- `build.rs` links that script into the helper binary as the section `__TEXT,__ozzie_server`, so the
  helper is one file covered by its code signature. A build without the script stops and says to run
  `pnpm build:share`; `pnpm build:desktop` and Tauri's `beforeBuildCommand` build it first, and the
  helper is rebuilt whenever the script changes.
- The Swift host does only what `file.ts` and `serveStream` do in Node: reads the shared file (the same
  path, `OZZIE_SHARED_CHECK` override trimmed as JavaScript trims, only while the marker beside it is a
  regular file, read-only, no link, no waiting, no terminal, at most `MAX_SHARED_BYTES`, read again on
  every call) and newline-delimited stdin (a line over `MAX_LINE` answered once as invalid and never
  parsed; one still unfinished past 3 × `MAX_LINE` bytes is no longer held and is skipped through its
  newline), and writes answers to stdout, waiting rather than stopping when stdin or stdout doesn't
  block. The limits and both file names come from the script. It opens no network connection, starts
  no process and writes no file. The read is handed to the script as its one argument; the script's
  global object has only JavaScriptCore's built-ins (`console` and `WebAssembly` among them, which it
  never uses), and nothing evaluates what arrives on stdin.
- JavaScriptCore runs the script without JIT, so the helper needs no hardened-runtime exception. Tauri
  signs every bundled helper with the app's entitlements (the microphone); `tools/release-mac.sh` signs
  `ozzie-share` and the card reader again with none and seals the app again. It refuses a release if
  either carries any entitlement, if the listener carries anything but the microphone, if
  `ozzie-share`'s embedded script isn't byte for byte the one built in that run, or if the signed copy
  doesn't answer the handshake and a tool call.

Whether sharing is on is kept natively, as a marker file beside the copy, not only in the page:
native writes nothing while it is off, turning it off removes the marker and then the copy and any
half-written one, and every start of Ozzie removes a copy left while sharing is off. If the copy
can't be removed, Settings says "Ozzie couldn't remove the shared copy. Try turning it off again."
and the next start tries again.

## Set it up in Claude Desktop

1. In Ozzie, open **Settings → Other AI apps** and turn on **Use Ozzie's last check in other AI apps**.
   Ozzie then shows the setup text for this Mac, with a **Copy setup text** button. It names the helper
   inside this copy of Ozzie, with no arguments:

   ```json
   {
     "mcpServers": {
       "ozzie": {
         "command": "/Applications/Ozzie.app/Contents/MacOS/ozzie-share"
       }
     }
   }
   ```

2. In Claude Desktop, open Settings → Developer → Edit Config
   (`~/Library/Application Support/Claude/claude_desktop_config.json`), paste it (beside any servers
   already listed) and save.

3. Restart Claude Desktop. In Ozzie, check Sunday (or open the fictional example). Then ask Claude, for
   example, "What still needs attention for Sunday in Ozzie?"

Run Ozzie from the Applications folder: a downloaded app that macOS runs from a temporary copy has a
path that changes, and one opened straight from its disk image goes away when the disk is ejected, so
Settings asks to move it first. If Ozzie moves, its setup text changes with it.

Until Ozzie shares a check, and whenever sharing is off, every tool says only that nothing from Ozzie
is shared right now; it doesn't urge anyone to turn sharing on.

### Or with Node, from a checkout

The same server runs under Node.js 22 or later for development, or on a Mac without the app:

```sh
pnpm install
pnpm build:mcp        # writes core/mcp/dist/ozzie-mcp.mjs
```

and in Claude Desktop's config, with absolute paths (`which node` for `command`):

```json
{
  "mcpServers": {
    "ozzie": {
      "command": "/usr/local/bin/node",
      "args": ["/path/to/ozzie/core/mcp/dist/ozzie-mcp.mjs"]
    }
  }
}
```

The server reads newline-delimited JSON-RPC: a line over 1 MiB is answered once as invalid and
never parsed, a batch of more than 32 requests is refused whole, and a tool
that fails answers a JSON-RPC error instead of stopping the server.

### Other locations

`OZZIE_SHARED_CHECK=/path/to/shared-check.json` points the server at another file (tests, or Ozzie's
data folder on another system). The file is still checked in full, and read only while a
`.shared-check.on` marker that is a regular file sits beside it.

## Try it by hand

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sunday_readiness"}}' \
  | /Applications/Ozzie.app/Contents/MacOS/ozzie-share
```

From a checkout, pipe the same lines to `node core/mcp/dist/ozzie-mcp.mjs`, or to
`product/desktop/src-tauri/binaries/ozzie-share-<target>` after `pnpm build:share` and a `cargo build`.

## Siri and Shortcuts

"Let Siri and Shortcuts ask Ozzie" in Ozzie's Settings (off by default; ADR 0006) keeps a second, smaller
copy beside this one: `shortcuts-check.json`, with its own `.shortcuts-check.on` marker, holding only the
`sunday.overview` result and no task rows. Native writes it with the same checks as the shared copy
(`core/native-auth/src/shortcuts_check.rs` on top of `shared_check.rs`), and the two switches never
touch each other's copy. The helper `ozzie-shortcuts` (`product/desktop/src-tauri/helpers/shortcuts.swift`,
no entitlements) runs `shortcuts.ts` in JavaScriptCore: given one question, `sunday`, it reads the copy
only while its marker is a regular file, checks it with `parseSharedCheck`, and prints an answer made of
counts, dates and fixed words, never a label:

```sh
'/Applications/Ozzie.app/Contents/MacOS/ozzie-shortcuts' sunday
# Sunday, November 22 has 2 open spots across 2 roles. 1 person is pending, and Planning Center shows the request hasn't been sent yet. Checked in Planning Center today at 10:00 AM.
```

A shortcut runs that command with Run Shell Script and Siri runs the shortcut by its name. Run Shell
Script needs Shortcuts > Settings > Advanced > Allow Running Scripts, a setting for all of Shortcuts on
the Mac: any shortcut can then run commands as the leader, and Ozzie's Settings says so. When it can't
answer at all, the helper writes one plain sentence for Shortcuts to show and exits 70. `ozzie://today` and `ozzie://sunday` open those pages
in Ozzie while the switch is on; nothing else from a link is used. It reads no environment but `HOME`,
and has no override for the copy's path.

## Tests

- `core/test/mcp/server.test.ts`: handshake and JSON-RPC errors, over-long lines, batch size, a failing
  tool, output backpressure; every harness fixture (live, recording, fictional, Services only, failed
  reads, canary names) through every tool with no name under the "capitalized only" and strict rules,
  no source text, canary or contact detail; the check time and copy id shown, labels per copy; tampered
  files refused whole and answered exactly as no copy (a later check time, a bad copy id, no results,
  a leap second, February 30); the copy read only while native's marker is a regular file; a named
  pipe read as no file; nothing written; no write, network or process call in the server's source.
- `core/test/mcp/embedded.test.ts`: the embedded entry answers every line exactly as the Node server does
  over every fixture and over copies with odd times; times checked part by part (equal to
  `Date.parse` whenever that is valid); the built script runs with no Node globals; no background-check
  wording or fact (not even in the counts) in the shared copy or any tool's words.
- `product/desktop/test/share-helper.test.ts`: the built `ozzie-share` driven over stdio, every reply byte
  for byte the Node server's (every fixture, every tool, batches, a CRLF line, bytes that aren't UTF-8,
  over-long lines, odd times through JavaScriptCore, sharing off and every kind of unusable file
  answered identically, a named pipe, the default path under HOME, the override trimmed as Node does,
  stdin and stdout that don't block, a re-read of the file and the marker on every call, nothing
  written); its Swift source holds no network, process or write call. Skipped, saying why, when the helper isn't built or is older than `core/mcp`.
- `product/desktop/test/other-ai-apps-setup.test.ts`: the setup text names only the helper, the steps
  are plain words and say what the other app will and won't see; a temporary copy or a disk image asks
  to move Ozzie first.
- `core/native-auth/src/shared_check_tests.rs`: one checked result per shared tool, names and contact
  details refused, a refused share leaves the last file, 0600, no task ids, the facts' own check time,
  the copy id's shape, nothing written while off, turning it off and clearing remove the copy and any
  half-written one, start-up clean-up, a copy that can't be removed reported; `SHARED_TOOLS` and the
  copy id pinned to the TypeScript.
- `core/test/mcp/shortcuts.test.ts`, `core/native-auth/src/shortcuts_check_tests.rs`,
  `product/desktop/test/siri-shortcuts.test.ts` and `product/desktop/test/shortcuts-helper.test.ts`: the
  answers to Siri and Shortcuts in every state a check can be in (exact text), only Ozzie's own words,
  numbers and dates in any of them over every fixture, the copy holding only the overview, the two
  switches independent, the built helper agreeing with `shortcuts.ts` and reading nothing that isn't a
  plain file, and the `ozzie://` pages limited to Today and Sunday.
- `product/desktop/test/share-check.test.ts`: off unless native says on, a failed removal said plainly
  and left on to try again, only placeholder results handed to native, the copy removed whenever
  nothing current is shared (no check, another church, disconnected, deleted recordings, a refused
  share), plain Settings copy.
