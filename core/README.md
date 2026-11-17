# Ozzie core

Open, Apache-2.0. The part of Ozzie with no user interface: the checks that
turn what Ozzie read from Planning Center into findings, and the harness that
lets an AI model help with them without ever seeing a name or being able to
change anything. The desktop app in `product/desktop/` is built on it.

## The harness in four pieces

Ozzie's specs define the harness as four pieces. Each one is here, and each is
checked again in native code before anything leaves the Mac.

1. **The tool broker.** A model can only call fixed, typed, read-only tools,
   and a task is offered only the tools its procedure lists, that the Planning
   Center connection was granted, and that are on the allow-list. There are 13
   tools: eleven read Ozzie's last check, one runs that read-only check again,
   and one returns Ozzie's own draft of a note. None writes, sends, browses or
   runs anything.
2. **The placeholder boundary.** Names never go to a model. A question goes
   with the people and roles Ozzie read replaced by labels such as
   `[Person 1]` and `[Role 1]`; every tool result holds only labels, counts,
   times and fixed words, in a closed grammar; and names are put back only on
   the Mac, after the answer has passed its checks.
3. **The deterministic findings.** Every fact comes from fixed, tested code,
   never from a model: open roles, pending requests, kids rules, rooms,
   follow-ups, group nights, forms, Check-Ins, Registrations, calendars and the
   rest. The model's whole answer is a choice of fact ids from the tools'
   results, and Ozzie writes every sentence itself from fixed templates.
4. **The task ledger.** Every task is recorded outside any conversation: its
   kind, procedure and version, its states, the tools it used and how it
   ended. It never holds a question, an answer or a name.

On top of these sit two replaceable parts:

- **The loop.** It drives the turns: ask the model, run the tools it asks
  for, ask again, up to 6 model steps and 10 tool calls per task. It owns none
  of the safety pieces. The app runs a loop built on the pinned Pi library
  (`@earendil-works/pi-agent-core`); a plain TypeScript loop passes the same
  tests and can be chosen in debug builds.
- **The procedures.** Plain-language files in `core/skills/`, shown word for
  word in the app under "See how this works". A procedure names the tools it
  may use; it can't grant itself any others.

```
Planning Center
   │  GET-only reads of allow-listed addresses (native: core/native-auth/src/source.rs)
   ▼
last check, names kept on the Mac
   │
   ▼
deterministic findings (core/src/*.ts) ──────────────► the app's pages, notices, briefing
   │
   ▼
13 read-only tools (core/src/harness/tools.ts)
   │  labels, counts, times, fixed words, each fact with an id
   │  admitted by the broker: procedure's tools ∩ granted ∩ allow-list (host.ts)
   ▼
loop (Pi, or plain TypeScript in debug builds) ◄── policy + procedure (core/skills/*.md)
   │
   │  every model step
   ▼
native step check (core/native-auth/src/agent.rs) ──► model route (model.rs)
   │
   ▼
answer = fact ids ──► verify.ts ──► compose.ts writes the sentences ──► names restored on the Mac

task ledger (native, core/native-auth/src/ledger.rs): states, tool and step events, never text
```

## Where each piece lives

| Piece | TypeScript (`core/src/`) | Native (`core/native-auth/src/`) |
|---|---|---|
| The frozen interfaces: tool spec, envelope, task, model step, loop, limits | `harness/contract.ts` | |
| Tool broker | `broker.ts` (`AuthorizationBroker`), `harness/host.ts` | `agent.rs` (`NATIVE_TOOL_ALLOWLIST`, `tools_ok`) |
| The tools and their specs | `harness/tools.ts`, `harness/fixed/tool-specs.json` | `fixed.rs` reads the same `tool-specs.json` |
| Closed grammar of tool results and answers | `harness/fixed.ts`, `harness/fixed/vocabulary.json` | `fixed.rs` (`tool_message`, `final_answer`) |
| Placeholder labels and name matching | `ask.ts`, `harness/session.ts`, `harness/names.ts`, `harness/index.ts` (`prepareAgentQuestion`) | `name_guard.rs`, `agent.rs` (`check_step`) |
| Background checks never reach a model | `kids-rules.ts` (`forModels`), `harness/background-wording.ts` | `background.rs` |
| Answer check and the answer's sentences | `harness/verify.ts`, `harness/compose.ts` | `fixed.rs` (`final_answer`) |
| Procedures and their pins | `core/skills/*.md`, `harness/skills.ts`, `harness/bundled-skills.ts`, `harness/instructions.ts`, `harness/fixed/pins.json` | `fixed.rs` (`SKILL_FILES`) |
| The loops | `harness/pi-loop.ts`, `harness/ts-loop.ts` | |
| Task ledger | `ledger.ts` (the state graph), `harness/ledger-events.ts` | `ledger.rs` |
| Jobs Ozzie keeps an eye on | `harness/responsibilities.ts` | `responsibilities.rs` |
| Model routes and the rewording request | `draft-request.ts` | `model.rs` |
| Planning Center reads | | `source.rs`, `oauth.rs`; `contact.rs` for the one person a note is opened for, only to fill in To |
| Findings | `coverage.ts`, `sunday-brief.ts`, `operations-capture.ts`, `operations-findings/`, `kids-rules.ts`, `sunday-changes.ts`, `church-reads/`, `calendar/`, `sources/` | |

`harness/index.ts` wires the pieces together (`Harness.ask`, `Harness.runSkill`).
`core/mcp/` is the separate read-only server that lets another AI app read
Ozzie's last saved check ([core/docs/mcp.md](./docs/mcp.md)).

Earlier versions of the boundary and findings checks (`egress.ts`,
`oracles.ts`) and an earlier TypeScript runtime were removed on 2026-11-16;
the app never used them.

## What is enforced where

Each rule about what may reach a model is enforced twice: in TypeScript, so
the app refuses early and explains why, and again in the Rust crate
`core/native-auth`, which is the only code in the app that holds a key,
reaches a model or reads Planning Center. The web view could be changed; the
native check would still refuse. The daily allowance and the read-only
Planning Center path exist only in native code, where the requests are made.

| Rule | TypeScript | Native |
|---|---|---|
| Only allow-listed tools, only the procedure's tools | `host.ts` `admitted` | `agent.rs` `tools_ok` |
| Each tool spec exactly as written in `tool-specs.json` | `tools.ts` `TOOL_SPECS` | `agent.rs`, against `fixed.rs` |
| The system message is the pinned policy and procedure, byte for byte | `instructions.ts` | `agent.rs`, against `fixed.rs`; the ledger admits a task only under the bundled file's hash |
| Tool results fit the closed grammar and hold only this session's labels | `tools.ts` (sealed with `fixed.ts` `envelopeProblems`) | `fixed.rs` `tool_message` |
| No name Ozzie has shown, no contact detail, no hidden character | `harness/index.ts` `check`, `names.ts`, `ask.ts` | `name_guard.rs`, `agent.rs` `check_step` |
| No background-check wording in anything that varies | `background-wording.ts` | `background.rs` |
| The final answer is only fact ids this task's tools returned | `verify.ts` | `fixed.rs` `final_answer` |
| At most 6 model steps and 10 tool calls a task | `contract.ts` `HARNESS_LIMITS`, in both loops | `agent.rs` `MAX_STEPS`, `MAX_TOOL_CALLS`, counted from the ledger |
| A daily allowance per AI route, zero data retention where required | | `model.rs` |
| Planning Center is only read | (no TypeScript path reaches it in the app) | `source.rs`: a GET of an allow-listed address is the only request shape |

The TypeScript and Rust checks run the same test vectors
(`core/test/ask-parity.json`, `core/test/answer-parity.json`), and both sides
recompute `harness/fixed/pins.json` from the files in their tests, so a changed
procedure or fixed text fails a test on each side until both are updated.

## What the AI does, and what it doesn't

In the shipped app the loop runs for three things: a question in Ask Ozzie,
the write-up of each run of a job Ozzie keeps an eye on, and a look at who
could help with one open role, asked for from its Sunday card. Everything else
(the findings, the list of who could help, notes, notices, schedules, the
briefing) is fixed logic and works with no AI route. The public README says why, in "What the AI
does, and what fixed logic does".

## Running it and testing it

The TypeScript harness runs under Node with any `ModelStep` (`contract.ts`):
the tests use scripted models over fixed, invented data, for example
`core/test/harness/compose.test.ts`. In the app the only model step is the
native `agent_step` command. There is no command-line entry yet.

From the repository root, on Node 22.23.4 (`.node-version`):

```sh
pnpm install --frozen-lockfile
npx vitest run core          # the core's TypeScript tests
npx vitest run core/test/harness   # the harness alone
pnpm test:native             # the Rust crate core/native-auth
```

`core/test/harness/runtime-conformance.ts` is the suite both loops must pass;
`core/test/harness/eval.test.ts` sweeps every fixture for injected
instructions, leaked names and canaries; `core/test/harness/fixed.test.ts` holds
the specs, the grammar and the pins to the files.

## Extending it

[core/docs/extending.md](./docs/extending.md) names every place a new read-only tool,
a new procedure or a new model route touches, with a worked example of each,
and what is deliberately not extensible in this version.
