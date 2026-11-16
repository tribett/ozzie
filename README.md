# Ozzie

[![Checks](https://github.com/tribett/ozzie/actions/workflows/ci.yml/badge.svg)](https://github.com/tribett/ozzie/actions/workflows/ci.yml)

Ozzie by FlockConnect is a desktop app for church staff and ministry leaders.
It reads your church's Planning Center account, checks the coming Sunday
against rules you set, and lays out what needs a decision: a serving role
nobody has said yes to, a room booked twice, a follow-up with no one assigned.
It can draft a note for you to send yourself. People decide, and people go.

**Status:** early build from the AI for Church Hackathon 2026. It runs on
macOS on Apple Silicon. Builds you make from this repository are not signed or
notarized. Expect rough edges.

These screens show the app's built-in fictional example (invented church,
invented people). No church data is shown.

![Sunday: what needs a decision, with who could help and why](docs/images/sunday-fictional.png)

![Ask Ozzie answering from what it read; the AI saw placeholders, not names](docs/images/ask-fictional.png)

![Today: a labeled fictional email and calendar import, with an instruction inside an email ignored on purpose](docs/images/today-fictional.png)

## What Ozzie does

- **Reads Planning Center, and only reads.** Ozzie makes a fixed list of GET
  requests (Services plans, positions and schedules, and the upcoming plans
  setup lists to choose from; with your consent, Calendar room bookings,
  People workflow cards, cleared People background checks for people
  scheduled on kids teams, and Groups events). It never
  writes, edits or deletes anything in Planning Center. The list of reads is
  in [docs/build/sunday-capture-contract.md](docs/build/sunday-capture-contract.md).
  Signing in, renewing access and disconnecting use Planning Center's standard
  OAuth sign-in endpoints.
- **Shows facts with their source and check time.** Each finding says which of
  your church rules it relates to and what it checked. Anything Ozzie is unsure
  about is labelled "Worth a look".
- **Kids safety rules.** Mark which teams serve with kids in Church rules.
  Ozzie flags a kids team with fewer confirmed people at a service time than
  your rule asks for (it counts confirmed people; Services has no ages, so it
  never says "adults"), and anyone scheduled on a kids team without a current
  background check on file, or with one that expires before Sunday. A read
  that failed or was refused is listed as not checked, never as "no check".
- **Drafts, never sends.** Notes are drafts you copy into your own email or
  phone.
- **Learns your corrections as Church rules you can see.** Every finding card
  offers "This isn't right", "Stop flagging this", "Always do this" and, per
  kind of finding, "Always tell me right away" or "Put this in the briefing".
  Each choice is confirmed with Undo and listed on the Church rules page,
  where you can delete it. Nothing is learned silently.
- **Sorts Today.** Needs your attention, Ready to review and In progress,
  with counts of items (never people), how long each has waited, and "Set
  aside until tomorrow" for things that can wait.
- **Keeps a record of what happened**, including checks that could not finish:
  each task, the fixed tools it used and how it ended, never a question,
  answer or name.
- **Keeps an eye on things when you ask it to.** From Ask Ozzie you can hand
  it an ongoing job ("Keep an eye on Sunday", room bookings, follow-ups
  without an owner, group night clashes, a morning briefing). Ozzie shows the
  plan (schedule, limits, how long) and starts only after you confirm it. It
  lives in the menu bar and keeps running with the window closed, can open
  when you log in (off unless you turn it on), checks on schedule, notices
  when what it reads in Planning Center has changed since the last check (it
  re-reads and compares; Planning Center doesn't notify it), and comes to you with a discreet notification
  whose text never holds a name or detail, outside quiet hours (9 PM to 7 AM
  unless you change them). A morning briefing comes at 7:00 AM on weekdays;
  Thursday's includes the full Sunday Ready brief, and anything that came up
  overnight is labelled Overnight and waits for it. Missed and failed checks
  are reported, not hidden. It works only while your
  Mac is awake and Ozzie is running, and it still only reads and drafts.
- **Ask by typing or speaking.** The microphone in Ask uses Apple's
  on-device speech recognition only (US English). Your words fill the box;
  nothing is asked until you press Ask, and no audio is kept or sent.
- **Reads visitor cards on your Mac.** Photos of printed or typed cards are
  read by Apple's Vision text recognition in a small signed helper (nothing
  to install), without rewording what was written. Words read with low
  confidence are flagged; a person checks every card, and the cards are gone
  when the page closes. Nothing from a card goes to an AI model or into
  Planning Center.
- **Shares its last check with other AI apps, if you turn it on.** Off by
  default. Another AI app on the same Mac (for example Claude Desktop) can
  read Ozzie's last saved check through a small read-only server, with
  placeholders instead of names and no background-check facts. See
  [core/docs/mcp.md](core/docs/mcp.md).
- **Sends a notice to your phone too, if you turn it on.** Off by default.
  Each time Ozzie sends a notice, the same fixed line can also reach your own
  phone through ntfy.sh, a free service Ozzie doesn't run. See
  [A notice on your phone](#a-notice-on-your-phone) for exactly what leaves
  the Mac and who can see it.
- **Works without a connection.** "See the fictional example" shows the app
  with an invented church.

## What Ozzie never does

The full list is in [docs/handoff/NEVER-LIST.md](docs/handoff/NEVER-LIST.md)
(written when the project was called TableWork). In short, Ozzie never:

- sends a message to a church member;
- writes a sermon, devotional or pastoral teaching;
- pretends to give pastoral care, counselling or prayer;
- scores, ranks or labels a person's spiritual health, faithfulness or risk;
- makes a pastoral decision or acts without a named person approving it;
- writes to Planning Center;
- sends the names it read from Planning Center to an AI model;
- presents uncertainty as fact, or hides what it read and when.

These are not settings. No user, church or plan can switch them off.

## How names stay off AI models

AI is optional. Without it, every check and draft still works. With it, Ozzie
can reword a draft note, answer a question about the Sunday it checked, and
summarise what a job it keeps an eye on found.

- **Placeholders, not names.** A draft goes to the model in placeholder form,
  for example "Hi [Volunteer A], could you serve as [Role]?". The model only
  rewords text Ozzie wrote itself, never text you typed about a person, and
  real names are put back on your Mac after the reply comes back
  (`core/src/draft-request.ts`).
- **Questions run as a small, fixed procedure.** Your question goes to the
  model with the names Ozzie read from Planning Center replaced by labels such
  as `[Person 1]` and `[Role 1]` (`core/src/ask.ts`, `core/src/harness/`). The
  model can only call a fixed list of read-only tools over the check Ozzie
  already made; each returns labels, counts, times and fixed words, never a
  name, a note someone typed or other text from Planning Center, and each fact
  in it has an id. There is no tool that sends, writes, browses or runs
  anything. The procedures are plain-language files in `core/skills/`, shown
  word for word under "See how this works".
- **The model chooses facts; Ozzie writes the answer.** The model's answer is
  only a short JSON object naming the facts that answer the question (for
  example `{"answer":"facts","facts":["f3","f7"]}`). Ozzie checks that every
  id is one its own tools returned, then writes each sentence on your Mac from
  a fixed template, lists people in its own order, and puts the names back. So
  the AI can't rank people, call someone willing or free, claim something was
  sent, or describe anyone, and a draft is always Ozzie's own wording
  (`core/src/harness/verify.ts`, `core/src/harness/compose.ts`).
- **Ozzie can only recognise names it has read.** It can't catch a nickname or
  a family member's name that Planning Center doesn't hold; such a word in a
  question is sent as typed. Don't type other people's details into a
  question. Email addresses and phone numbers, even written out, are refused
  and nothing is sent.
- **A second check in native code.** Before any request leaves the app, the
  Rust layer checks it again (`core/native-auth/src/agent.rs`,
  `name_guard.rs`): Ozzie's own texts and tool descriptions must be exactly the
  pinned ones, tool results must fit a closed grammar, earlier replies must be
  exactly what the model returned, and no name the app has shown in this
  session, contact detail or hidden character may appear anywhere else. The
  model's final reply is held to the same answer form. Each task has a small,
  fixed number of model calls and tool calls, and each AI route a daily
  allowance. The TypeScript and Rust checks run the same test vectors
  (`core/test/ask-parity.json`, `core/test/answer-parity.json`).
- **Background checks never go to an AI.** Background-check facts are shown
  in the app, the spoken briefing and notices on your Mac, and are never sent
  to any AI route or included in the copy shared with other AI apps, not even
  as placeholders (`core/src/kids-rules.ts`, `forModels`).
- **Names stay on your Mac.** The names Ozzie read from Planning Center are
  used for display. A saved check (shown, with its original time, when
  Planning Center can't be reached) keeps the names it showed, in a file only
  your user account can read.

## A notice on your phone

Off unless you turn it on in Settings. You install the free ntfy app on your
phone and subscribe to the channel Ozzie shows (no account). From then on,
each time Ozzie sends a notice, native code
(`core/native-auth/src/phone_notice.rs`) also sends exactly this, and nothing
else, even if your Mac's own notifications are turned off for Ozzie:

- **Where:** one HTTPS POST to `https://ntfy.sh/<channel>`, through rustls,
  with no proxy, no redirect followed, one attempt and a 10-second limit. The
  answer's body is never read.
- **What:** the title `Ozzie` and one of six fixed sentences as the body: the
  Mac notice's own words for that kind of notice (for example "Sunday coverage
  needs attention. Open Ozzie to see details.") or the test line. No sentence
  holds a name, a number, a link or anything Ozzie read or you typed. The page
  can't supply text, a channel or an address; it can only name a kind of
  notice, and say that one stays on this Mac (which can only keep a line off
  the phone, never add one). Besides the title, Ozzie sets only
  `content-type: text/plain`; the HTTP library adds only the host, accept and
  content-length headers.
- **When:** at the same moments as the notices on your Mac, so quiet hours,
  Pause everything and your Church rules on notices apply unchanged: uncertain
  findings (Worth a look) don't send a notice unless you chose "Always tell me
  right away" for that kind. A notice that is only about a background check
  stays on your Mac: nothing goes to your phone for it. Plus "Send a test
  notice" when you press it. At most 12 an hour while Ozzie is running, by your
  Mac's clock. The Mac's own notice is sent whatever happens to the phone's.
  Settings shows when the last phone notice went and whether it was sent.
- **The channel:** `ozzie-` and 160 random bits from the operating system,
  kept in your Mac's Keychain, never in a file, the record of what happened,
  the recordings Ozzie saves of its checks, or a log. It is shown in Settings
  and put on the clipboard when you copy it. Anyone who learned it could read
  those sentences and could also send your phone a notice that looks like
  Ozzie's; Ozzie's own notices are only these fixed lines and never hold a
  link. So "Make a new channel" replaces it at any time (do that if it was
  ever on a shared screen or screenshot). Turning the notice off stops sending
  and forgets the channel; a notice not yet sent checks again just before it
  goes and then sends nothing to the old channel, though one already on its
  way to ntfy.sh at that moment may still arrive.

ntfy.sh, and the phone makers' services it uses to reach your phone (Google's,
and Apple's for an iPhone), can see which line was sent and when; ntfy.sh also
sees your Mac's internet address and keeps each line for a while (about half a
day by its usual setting).

## Lists and notes you add

Off until you add one, on the Lists & notes page. A church often keeps its own
lists outside Planning Center, such as who holds which keys. Ozzie can show
one beside the Sunday cards it belongs with (`core/src/sources/`,
`product/desktop/src-tauri/src/church_sources.rs`). Lists and notes you add
stay on your Mac: they aren't sent to AI help, shared with other AI apps or
Siri, or put in any notice.

- **What is read:** a spreadsheet saved as CSV or tab-separated text, up to
  2 MB, that you choose in Ozzie's own open panel. Ozzie reads it again from
  where it is when you open Sunday or Lists & notes (the first time after Ozzie
  starts, then at most once an hour) and when you press "Read again", never
  with the window closed or hidden, and never changes it. It doesn't read a
  file in your Library folder, except in iCloud Drive, in an app's Documents
  folder in iCloud (where Numbers and TextEdit save) and in the cloud drives
  macOS keeps there (apps' private iCloud folders, such as Mail's, stay
  refused), nor a hidden file or folder, Ozzie's own folders, or an alias of a
  file.
- **Or a private link:** the https link a site gives for a sheet published on
  the web as comma-separated values (in Google Sheets, File › Share › Publish
  to web). Anyone with that link can read the sheet, so it is kept only in your
  Mac's Keychain (`church.ozzie.source-links.v1`), never in a file or a log;
  the page holds it only while you paste it, and afterwards shows only its
  host. It reads the link when you add it, when you open Sunday or Lists &
  notes (the first time after Ozzie starts, then at most once an hour while
  Ozzie stays open), and when you ask; it never reads it with the window
  closed or hidden. Each read is one HTTPS GET for the sheet
  (`core/native-auth/src/sheet_link.rs`): https on port 443 to a name that
  resolves only to public addresses, connected only to those, at most three
  redirects each checked the same way, no proxy, no cookies or Referer, 20
  seconds in all, at most 2 MB, and refused if any Content-Type the site sends
  says it is a web page (often a sign-in page), or if its text, after any white
  space and invisible characters, starts like a web page's tag (`<` then a
  letter, `!`, `?` or `/`: so a first cell such as `<b>Name</b>` is refused
  too, and one such as `<5` or `<=10` is not), or if it is a workbook, JSON
  or not text. It sends nothing about your church. The site in the link, and
  any site that link sends Ozzie on to, sees when it is read, your Mac's
  internet address, and that the request comes from Ozzie. At most 8 links.
- **Notes:** a file saved as plain text or Markdown, up to 1 MB, that you
  choose in Ozzie's own open panel, read from where it is like a list's file
  (the same places refused). The panel offers plain text, Markdown and PDF
  files: a PDF is refused with a sentence saying how to save it as plain text,
  and a Word or Pages file can't be chosen there (Lists & notes says how to
  save one as plain text, and one renamed to .txt is refused with a sentence
  saying so). Ozzie splits notes into sections at each `#` heading, or at
  blank lines in a file with no headings. It shows them on Lists & notes with a
  find box. Notes are shown as written, except that hidden format characters
  are removed, tabs and other control characters become spaces, and a line
  over 2,000 characters or a file over 20,000 lines is cut, which the notes
  then say. To be exact, the Unicode line separators start a new line, as a line break
  does, and spaces at the end of a line are dropped (`core/src/sources/text.ts`,
  `noteLine`). No Markdown is drawn: a link or an image is its text. Every
  line is shown, a heading longer than a title included (the title is cut; the
  heading is shown whole above the section). You can point to a section from
  the Sunday cards for one team (by its Planning Center id) or about one kind
  of finding, with a way to open it here from those cards. Beside a Sunday
  card it shows only the title of a section you pointed there (numbered when
  titles repeat), as your church's own notes, not checked by Ozzie. Ozzie never follows notes
  and never compares their words with Planning Center or with anyone's name;
  the find box searches them on this Mac.
- **Matches are yours:** you pick the column that names a team or role and
  match its values to Planning Center teams and positions. Ozzie may suggest a
  team or position with the same name; a suggestion counts only after you
  choose "Use this match". Ozzie never compares the names in a list with
  people in Planning Center, and nothing in a list changes a finding.
- **Shown as your church's own words:** on Lists & notes in the file's own
  order, and beside a matched Sunday card under "From your church's list '…'
  (not checked by Ozzie)", only the columns you tick. No row has a button:
  nothing is copied, exported or drafted from it.
- **Nowhere else:** not in the briefing read aloud or a draft either. Ozzie's
  own tests check on every change that the lists-and-notes code calls only its
  own commands, that nothing which sends anything imports it, and that it names
  none of the browser's ways off the page that the test lists
  (`core/test/sources/stays-on-this-mac.test.ts`). That is a check on Ozzie's
  own code, not a sandbox. What was read is kept in memory only, while Ozzie
  is open.
- **What Ozzie keeps:** `church-sources.json` in Ozzie's data folder, which
  only your user account can read: each list's and notes' name, the file's
  name and place (or a link's host), your column choices and matches, the
  sections you pointed to, and when each was last read; beside it,
  `source-links.json` holds each link's id and host. A link's address is only
  in the Keychain. "Remove this list" or "Remove these notes" forgets one (a
  link's address too), and "Forget all lists and notes" forgets them all and
  deletes every link's address from the Keychain. If the Keychain doesn't
  answer then, the addresses are removed the next time Lists & notes or Sunday
  is opened and it does, and they never count toward the 8 links. The files
  and sheets themselves don't change.

## Download

A signed copy of Ozzie for Mac (Developer ID: FlockConnect LLC, notarized by
Apple; Apple Silicon, macOS 14 or later) is at https://ozzie.church/download.
It is an early build. It checks for a new version about once a day and
installs one only when you choose to (Settings › Updates; the check can be
turned off there).

## Build and run

Requirements:

- macOS 14 or later on Apple Silicon, with the Xcode Command Line Tools
- Node.js 22.19 or later (`.node-version` names the version we test with)
- pnpm 10
- Rust 1.99.1 through rustup (`rustup toolchain install 1.99.1`); the crates
  pin it in `rust-toolchain.toml`

```sh
pnpm install --frozen-lockfile
pnpm typecheck                # TypeScript type check
pnpm test                     # TypeScript tests (core and app)
pnpm test:native              # Rust tests for core/native-auth
pnpm build:desktop            # unsigned app bundle
pnpm dev                      # browser walkthrough with invented data
```

`pnpm build:desktop` writes
`product/desktop/src-tauri/target/release/bundle/macos/Ozzie.app`. The app is
not signed or notarized. A copy you build yourself opens normally; a copy
downloaded from elsewhere is blocked by macOS until you allow it under System
Settings, Privacy & Security.

### Connect Planning Center

In Ozzie for Mac (the signed download from https://ozzie.church/download),
connecting is one click: **Settings** →
**Connect Planning Center**, sign in in your browser and choose **Allow**.
Ozzie finds your organization from the sign-in itself, and the token is
stored in your Mac's Keychain.

A copy you build yourself has no Planning Center registration built in, so
you use your own:

1. In Planning Center's developer settings, register a public OAuth
   application (Ozzie signs in with PKCE and holds no client secret) with the
   redirect URI `http://127.0.0.1:42819/oauth/callback`.
2. Either build with `OZZIE_PCO_APP_CLIENT_ID=<your application ID>` set, which
   gives your build the same one-click connect, or open **Settings** →
   **Advanced: use your own Planning Center registration**, enter the
   application ID and your organization ID, and choose **Connect with these
   IDs**.
3. Choose the Sunday to check from the upcoming plans setup lists (or enter
   the service type and plan IDs, or paste the plan's address).

Room bookings, follow-ups, group events and background checks are a
separate opt-in. They ask Planning Center for Calendar, People and Groups
access, which Ozzie still uses for reading only.

## Use your own AI key or a local model

Under **Settings**, choose one of:

- **A model on this Mac.** Ozzie talks to `http://127.0.0.1:11434/v1`, the
  default address of [Ollama](https://ollama.com), with the model `llama3.2`
  (run `ollama pull llama3.2` first). Requests stay on this Mac.
- **Your own AI provider.** Any OpenAI-compatible service over HTTPS. Enter its
  address and model name, then add your key to the Keychain yourself, under an
  account named for the provider's host (with `:port` when the address names
  one). Settings shows the exact command for your address, for example:

  ```sh
  security add-generic-password -U -s church.ozzie.model.v1 -a "own-provider:api.example.com" -w
  ```

  The `-w` flag with no value makes `security` ask for the key at a hidden
  prompt, so it is never on a command line or in your shell history. The key
  never reaches the app's web view, and a key saved for one address is never
  sent to another. A key saved under the older plain account `own-provider`
  is tied to no address and is not used; save it again under the new name.
  When the address is Vercel AI Gateway (`ai-gateway.vercel.sh`), every
  request requires zero data retention and a reply that doesn't confirm it is
  refused (`core/native-auth/src/model.rs`, `retention_confirmed`).

Whichever you choose, the same placeholder rules and native name check apply.

## Managed service

A separate, paid managed service for Ozzie (ozzie.church, invite-only for
now) provides a hosted AI route that requires zero data retention on every
request, along with accounts, setup and support. The **Ozzie managed** choice
in Settings connects this Mac to an account in your browser; the app keeps the
connection's token in the Keychain. The app refuses any reply on that route
that lacks the AI provider's zero data retention confirmation. Everything in
this repository works without the service, and every safety check lives here,
in the open code.

## Repository layout

- `core/` — shared logic with no user interface: Sunday coverage findings,
  operations findings (rooms, follow-ups, group events), the placeholder
  boundary, church time zones, and safety primitives (authorization broker,
  egress boundary, ledger). Tested with fixed, invented data.
- `core/src/harness/`, `core/skills/` — the question and procedure harness:
  the fixed read-only tools, the closed grammars and pinned texts the native
  check also compiles in, answer verification and the answer composer, two
  interchangeable loops (one built on the pinned Pi library, one in plain TypeScript), the
  procedures in plain language, and the ongoing jobs Ozzie can keep an eye on.
- `core/mcp/` — the small read-only server that lets another AI app read
  Ozzie's last saved check (placeholders only, no network, no writes).
- `core/native-auth/` — Rust crate: Planning Center OAuth, Keychain storage,
  the allowlisted read path, model routes, the native checks on every model
  step, the local task record and the store for ongoing jobs.
- `product/desktop/` — the Tauri desktop app (React web view plus Rust
  shell), with two small Swift helpers for card reading (Apple Vision) and
  on-device speech recognition.
- `product/web/` — a browser walkthrough of the Sunday review with invented
  data.
- `product/src/`, `product/test/` — review logic shared by the apps, and its
  tests.
- `docs/` — the never-list, the Planning Center read contract, and decision
  records.

Planning Center data in tests and examples is invented. Some numeric IDs refer
to a Planning Center test organization that holds no real people.

## About this repository

This repository is published from a private development repository. Its
history starts at the first public release.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
