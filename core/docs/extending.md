# Extending Ozzie

This page is for someone who wants to change what Ozzie's harness can do: give
the model a new read-only tool, add a procedure, or point Ozzie at another AI
model. It names every file each change touches, says why there are that many,
and ends with what is deliberately closed in this version.

Read [core/README.md](../README.md) first for how the pieces fit. Every path
below is from the repository root. Run the checks at the end of each section
before you open a pull request; a change that touches a tool, a procedure or
what is sent to a model needs a second, independent review (CONTRIBUTING.md).

## A new read-only tool

A tool is a typed, read-only view of Ozzie's last check that the model may
call. Its result holds only placeholder labels (`[Person 1]`, `[Role 1]`),
counts, times and fixed words, and states each fact with an id.

### The five places, and why there are five

| # | Place | What you add |
|---|---|---|
| 1 | `core/src/harness/contract.ts`, `NATIVE_TOOL_ALLOWLIST` | the tool's name |
| 2 | `core/src/harness/fixed/tool-specs.json` | the spec the model is offered: name, description, parameters |
| 3 | `core/src/harness/tools.ts` | the implementation, and its fact lists |
| 4 | `core/native-auth/src/agent.rs`, `NATIVE_TOOL_ALLOWLIST` | the same name, in the native allow-list |
| 5 | a procedure's `tools:` line, and `core/src/harness/fixed/pins.json` | the procedure that may use it, and that procedure's new hashes |

Each is a separate guard, on purpose:

- The web view and the native code each keep their own allow-list. The web
  view could be changed by anyone who builds the app; the native check in
  `agent.rs` is what refuses a step that offers or calls a tool outside its
  list, so a name added only on the TypeScript side is never sent.
- `tool-specs.json` is one file that both sides read (`tools.ts` through
  `core/src/harness/fixed.ts`, native through `include_str!` in
  `core/native-auth/src/fixed.rs`). The model is offered exactly these words;
  native refuses a spec that differs by a byte.
- A tool no procedure lists is never offered: the broker admits only the
  procedure's tools that are also on the allow-list and that the Planning
  Center connection was granted (`core/src/harness/host.ts`; native
  `tools_ok`). Adding it to a procedure changes that procedure's file, so its
  pins change too.

The tests hold the five together: `core/test/harness/fixed.test.ts` checks
that `tool-specs.json` equals what `tools.ts` offers, in allow-list order, and
that `vocabulary.json` lists the same tools; the tests in
`core/native-auth/src/fixed.rs` check the native allow-list against both files
and recompute `pins.json`. If one place is missed, a test fails.

Two more files come with a tool's results rather than its name:

- `core/src/harness/fixed/vocabulary.json`, the closed grammar every tool
  result must fit, on both sides: add the tool to `tools` (same order as the
  allow-list), any new key to `payload_keys`, and any new fixed word to
  `values` or, for sentences, `sentence_words`. A result outside the grammar
  is refused before it is sent.
- `core/src/harness/compose.ts`, which writes the answer's sentences: add a
  sentence for the tool's own summary and for each row of its fact lists. The
  model only picks fact ids; a fact Ozzie has no sentence for can't be shown.

TypeScript then points you at every table keyed by tool name, such as the
plain words for "What happened" in `core/mcp/render.ts` and
`product/desktop/src/harness-words.ts`.

### Worked example: `sunday.decisions`

Say the model should be able to read the decisions the leader marked on this
Sunday's findings (for example "covered outside Planning Center").
`HarnessData.decisions` already holds them.

1. **Allow-list (TypeScript).** In `core/src/harness/contract.ts`, append
   `"sunday.decisions"` to `NATIVE_TOOL_ALLOWLIST`.
2. **Spec.** In `core/src/harness/fixed/tool-specs.json`, add an entry at the
   same position:

   ```json
   {
     "name": "sunday.decisions",
     "description": "Decisions the leader marked on this Sunday's findings, each with the role label and time.",
     "parameters": { "type": "object", "properties": {}, "required": [], "additionalProperties": false }
   }
   ```

   Add `"sunday.decisions"` to `tools` in `vocabulary.json` at the same
   position, with any new payload keys and fixed words.
3. **Implementation.** In `core/src/harness/tools.ts`, add a case to the
   `#read` switch and a method that builds the payload from
   `this.#data.decisions`, using `this.#servicesResult(…)` for the source,
   check time and completeness. Use only session labels for roles and people,
   never a name, and never the reason a person typed. If its rows are facts,
   add the list's key to `FACT_LISTS`. If it needs Calendar, People or Groups
   access, add it to `OPERATIONS_TOOLS`. Then add its sentences to
   `compose.ts`.
4. **Allow-list (native).** In `core/native-auth/src/agent.rs`, add
   `"sunday.decisions"` to `NATIVE_TOOL_ALLOWLIST` at the same position and
   change the array's length from 13 to 14.
5. **A procedure that uses it, and its pins.** Add it to the `tools:` line of
   `core/skills/answer-from-what-was-read.md`. Then update that procedure's
   entry in `core/src/harness/fixed/pins.json`: `file_sha256` is
   `shasum -a 256 core/skills/answer-from-what-was-read.md`, and the failing
   test in `core/test/harness/fixed.test.ts` prints the new `system_sha256`.
   Read the procedure change again before you copy a hash: the pin is what
   says a person reviewed this exact text.

Then run:

```sh
npx vitest run core/test/harness
pnpm typecheck
pnpm test:native
```

`core/test/harness/eval.test.ts` sends every tool's result over every fixture
through a mirror of the native checks and fails if any request a model could
receive holds a name, a contact detail or text from the source data. Add the
new tool's own cases to `core/test/harness/tools.test.ts`, with fixed,
invented data.

## A new procedure

A procedure is a plain-language file the model follows, shown word for word
in the app under "See how this works". It names the tools it may use and the
Planning Center access it needs; it can't grant itself anything.

### The places

| Place | What you add |
|---|---|
| `core/skills/<id>.md` | the procedure |
| `core/src/harness/bundled-skills.ts` | an import of the file (`?raw`) and an entry in `SKILL_FILES` |
| `core/native-auth/src/fixed.rs`, `SKILL_FILES` | the same file through `include_str!`; the array's length goes up by one |
| `core/src/harness/fixed/pins.json` | the file's hash and the hash of the exact system message |
| a caller | something that runs it (below) |

**A caller.** Nothing chooses a procedure by itself: the caller names it. Ask
always runs `answer-from-what-was-read`. A job Ozzie keeps an eye on runs the
procedure its template names, in `TEMPLATES` in
`core/src/harness/responsibilities.ts` and again in
`core/native-auth/src/responsibilities.rs` (a test holds the two together).
Other code can call `harness.runSkill("<id>")` (`core/src/harness/index.ts`).
The Sunday card's "Ask Ozzie to look at who could help" is such a caller:
`lookAtWhoCouldHelp` in `product/desktop/src/harness-bridge.ts` runs
`who-could-help` over a copy of the check that its `oneRole` has narrowed, in
code, to that one finding (that role at that time) before the loop starts. Its
card takes the people from the finding itself, the same rows as the fixed list
(never from the tool's reply, which is cut to fit what the AI may read), and
never marks which ones the AI named; what the AI adds is Ozzie's own lines for
the facts it chose about the role, and a note it asks for is never prepared
there. Narrowing what the tools
read is the safe way to point a procedure at one thing: the procedure text,
its pins and its tools stay the same.
To show it on the Church rules page, add its id to `PROCEDURE_ORDER` in
`product/desktop/src/harness-bridge.ts`.

**Why procedures are pinned natively.** The procedure is the instruction the
model follows, so native code holds it to the exact bytes that were reviewed:
`agent.rs` requires the system message to be Ozzie's policy and the bundled
procedure, byte for byte, and the offered tools to be exactly that procedure's
tools. A changed web view therefore can't rewrite what the model is told or
widen what it is offered. Because the text is fixed, it is pinned rather than
scanned for names, so a church member named Grace or Will can't make Ozzie's
own words fail the name check. The task ledger admits a task only under the
bundled file's hash, so "What happened" can say exactly which version ran.

Ozzie managed (the hosted AI route at ozzie.church, not in this repository)
checks requests again with its own copy of these pins, so a new procedure
works on that route only once the service carries it. A model on your Mac or
your own provider needs nothing more.

### Worked example: `open-roles`

`core/skills/open-roles.md`:

```markdown
---
id: open-roles
title: Open roles
purpose: Lists the roles this Sunday that still need people, and what wasn't checked.
tools: sunday.open_needs, sunday.not_checked, rules.current
needs: services
runs: on-request
---
For the roles on this Sunday's plans in Planning Center Services.

1. Look at the roles that still need people, with each one's time and how many more it needs.
2. Say which Church rules applied.
3. If part of the check couldn't be read, say so. That is never the same as nothing open.

Ozzie doesn't schedule anyone. A person decides who to ask.

How the answer is written: the AI only picks which of these facts to show. Ozzie writes every sentence on this Mac, with people in its own order.
```

The file name must be the id. `core/src/harness/skills.ts` checks every
procedure when it loads and refuses, for example:

- a tool that isn't on the allow-list, or a Calendar, People or Groups tool
  without `needs: operations`;
- words people shouldn't see in the app ("skill", "agent", "log",
  "connector", "harness", "session") or a tool's technical name in the text;
- a sentence that tells someone to act ("Send a reminder to each volunteer.")
  or asks for what Ozzie never does: writing to Planning Center, ranking or
  scoring people, "at risk", prayers, sermons or scripture. Saying what is
  never done ("Ozzie doesn't schedule anyone.") is fine.

Then add it to `bundled-skills.ts` and `fixed.rs`, add its entry to
`pins.json` (as for a tool, above), give it a caller, and run
`npx vitest run core/test/harness` and `pnpm test:native`.

## A different AI model

This is the open extension point.

**Without code.** In the app, Settings › AI help offers three routes: a model
on this Mac (Ozzie talks to `http://127.0.0.1:11434/v1`, Ollama's default),
your own AI provider (any OpenAI-compatible service over HTTPS: an address and
a model name, with the key added to the Keychain yourself), or Ozzie managed.
Every route gets the same placeholder rules and native checks; only where the
request goes changes. The route's settings are `model.json` in the app's data
folder; its call ceiling and agent steps per day can be changed only by
editing that file, never from the app's page (`core/native-auth/src/model.rs`,
`RouteConfig`).

**In code.** The loop never talks to a model itself: it calls a `ModelStep`
(`core/src/harness/contract.ts`), one request and one reply. In the app the
only `ModelStep` is the native `agent_step` command
(`product/desktop/src/harness-bridge.ts`), which runs every check before the
request leaves. Anything with the same shape can drive the harness. This runs
as a test (put it in `core/test/harness/`):

```ts
import { expect, it } from "vitest";
import type { ModelStep } from "../../src/harness/contract.js";
import { bundledSkills } from "../../src/harness/bundled-skills.js";
import { composeAnswer } from "../../src/harness/compose.js";
import { Harness } from "../../src/harness/index.js";
import { PiLoop } from "../../src/harness/pi-loop.js";
import { FRESH, harnessData } from "./fixtures.js";

it("answers a question through the harness with a model of your own", async () => {
  // Your model. Here a script: first ask for the Sunday overview, then answer with the overview's own fact id.
  const model: ModelStep = async request => {
    const results = request.messages.filter(m => m.role === "tool");
    if (results.length === 0) {
      return { content: "", tool_calls: [{ id: "c1", name: "sunday.overview", arguments: "{}" }], finish: "tool_calls" };
    }
    const overview = JSON.parse(results[0]!.content) as { payload: { fact: string } };
    return { content: JSON.stringify({ answer: "facts", facts: [overview.payload.fact] }), tool_calls: [], finish: "stop" };
  };
  const harness = new Harness({
    workspace_id: "fictional", data: harnessData(), skills: await bundledSkills(),
    runtime: new PiLoop(), model, now: () => FRESH,
  });
  const result = await harness.ask("What still needs a decision this Sunday?");
  if (!result.ok) throw new Error(result.refusal);
  expect(result.outcome.status).toBe("verified");
  const { paragraphs } = composeAnswer(result.outcome.answer!, result.outcome.evidence);
  console.log(paragraphs.map(p => harness.restore(p)));
  // "For Sunday November 22, this check found 2 items that need a decision and 2 worth a look. This is fictional example data."
});
```

A `ModelStep` you write yourself is outside the native check: nothing there
refuses a name or a contact detail for you, so give it fixed, invented data
like the fixtures here, never a real church's. A new kind
of route inside the app is native work: the `Route` enum and the rules in
`RouteConfig::endpoint` in `core/native-auth/src/model.rs`, which say where a
request may go (managed: one fixed address; your own provider: https only;
on this Mac: loopback only; never Planning Center).

## What is deliberately not extensible in this version

- **No write tools.** Ozzie reads Planning Center and changes nothing there.
  There is no tool that writes, edits, schedules, accepts or deletes, and the
  only request shape the native read path makes is a GET of an allow-listed
  address (`core/native-auth/src/source.rs`). Writing back would need its own
  design with a person approving each action, and is not part of this
  version.
- **No send, shell, file, browser or network tools.** The contract says so in
  `NATIVE_TOOL_ALLOWLIST`, and none may be added without a recorded decision.
  A tool reads the last check Ozzie already made; the model never reaches
  church data, the Mac or the internet by itself. That is what makes it safe
  to treat text inside church data as information rather than instructions.
- **No tool over data that stays on the Mac.** Calendars, lists and notes,
  forms, Check-Ins, Registrations, visitor cards and background checks never
  reach a model. Tests check that nothing which builds a model request imports
  the code that reads calendars or lists and notes
  (`core/test/calendar/stays-on-this-mac.test.ts`,
  `core/test/sources/stays-on-this-mac.test.ts`), and that the forms,
  Check-Ins and Registrations facts stay out of what the tools read
  (`core/test/church-reads-boundary.test.ts`).
- **No procedures added while the app runs.** Procedures are compiled in and
  pinned (above). A church can read every one on the Church rules page but
  can't add one without a new build. Letting a church add its own, checked,
  shown in full and confirmed once, is on the roadmap in the README.
- **No free text from the model.** The model's final answer is only fact ids
  (or a draft id from the drafting tool); Ozzie writes every sentence. A tool
  can't change that: the answer grammar is pinned on both sides
  (`core/src/harness/fixed.ts` `parseAnswer`, native `fixed::final_answer`).
- **No new Planning Center read without native code.** A new source means a
  new allow-listed GET in `core/native-auth/src/source.rs` and a new shape in
  the saved check. There is no plug-in interface for sources.
