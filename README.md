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

In the Ozzie for Mac download, connecting is one click: **Settings** →
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
