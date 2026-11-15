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
3. The server (`core/mcp/`) opens that one file read-only and without waiting (a named pipe in its
   place reads as no file), refuses it whole if anything is outside the format (including a
   `checked_at` that isn't the results' own), and composes the answer.

Whether sharing is on is kept natively, as a marker file beside the copy, not only in the page:
native writes nothing while it is off, turning it off removes the marker and then the copy and any
half-written one, and every start of Ozzie removes a copy left while sharing is off. If the copy
can't be removed, Settings says "Ozzie couldn't remove the shared copy. Try turning it off again."
and the next start tries again.

## Set it up in Claude Desktop

Requires Node.js 22 or later.

1. Build the server once from a checkout of Ozzie:

   ```sh
   pnpm install
   pnpm build:mcp        # writes core/mcp/dist/ozzie-mcp.mjs
   ```

2. Add it to Claude Desktop's config, `~/Library/Application Support/Claude/claude_desktop_config.json`
   (Claude → Settings → Developer → Edit Config), using absolute paths:

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

   Use the output of `which node` for `command` if Node lives elsewhere (nvm, Homebrew).

3. Restart Claude Desktop. In Ozzie, turn on **Use Ozzie's last check in other AI apps** and check
   Sunday (or open the fictional example). Then ask Claude, for example, "What still needs attention
   for Sunday in Ozzie?"

Until Ozzie has shared a check, every tool says how to turn sharing on.

The server reads newline-delimited JSON-RPC: a line over 1 MiB is answered once as invalid and
skipped through its newline unread, a batch of more than 32 requests is refused whole, and a tool
that fails answers a JSON-RPC error instead of stopping the server.

### Other locations

`OZZIE_SHARED_CHECK=/path/to/shared-check.json` points the server at another file (tests, or Ozzie's
data folder on another system). The file is still checked in full.

## Try it by hand

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"sunday_readiness"}}' \
  | node core/mcp/dist/ozzie-mcp.mjs
```

## Tests

- `core/test/mcp/server.test.ts`: handshake and JSON-RPC errors, over-long lines, batch size, a failing
  tool, output backpressure; every harness fixture (live, recording, fictional, Services only, failed
  reads, canary names) through every tool with no name under the "capitalized only" and strict rules,
  no source text, canary or contact detail; the check time and copy id shown, labels per copy; tampered
  files refused whole (a later check time, a bad copy id, no results); a named pipe read as no file;
  nothing written; no write, network or process call in the server's source.
- `core/native-auth/src/shared_check_tests.rs`: one checked result per shared tool, names and contact
  details refused, a refused share leaves the last file, 0600, no task ids, the facts' own check time,
  the copy id's shape, nothing written while off, turning it off and clearing remove the copy and any
  half-written one, start-up clean-up, a copy that can't be removed reported; `SHARED_TOOLS` and the
  copy id pinned to the TypeScript.
- `product/desktop/test/share-check.test.ts`: off unless native says on, a failed removal said plainly
  and left on to try again, only placeholder results handed to native, the copy removed whenever
  nothing current is shared (no check, another church, disconnected, deleted recordings, a refused
  share), plain Settings copy.
