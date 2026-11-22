# Fixed texts a model can receive

The single copy of every fixed string the agent harness sends to a model, read by both sides of the
boundary: the webview (`core/src/harness/fixed.ts`, through Vite's `?raw`) and the native `agent_step`
check (`include_str!` from `core/native-auth`). Reviews of 2026-11-14, items A1, A2 and B-S3: because these
texts are fixed and identical on both sides, they are pinned rather than name-scanned, so a church member
named Church, Sunday, Worth or Don can no longer make Ozzie's own wording fail. Only what varies (the
leader's question and the model's own output) is name-checked; tool results must fit the closed grammar below.

| File | What it is |
|---|---|
| `policy.txt` | Ozzie's policy. The policy text is the file with its final line break removed. |
| `policy-local.txt` | The policy an Ask step to a model on this Mac carries instead (below). Never sent by the webview, never to ozzie.church or an AI company. |
| `tool-specs.json` | The 13 tool specs (`ToolSpec` in `contract.ts`), in `NATIVE_TOOL_ALLOWLIST` order, exactly as offered. A task is offered a subset, in its skill's `tools:` order. |
| `vocabulary.json` | The closed grammar of a tool result, the system message format and the procedure prompt. |
| `common-words.txt` | Lower-case common English words, one per line, for the "capitalized only" name rule. |
| `pins.json` | sha-256 of each bundled skill file and of the exact system message for it; under `local_policy`, of `policy-local.txt` and of the Ask system message it makes. |
| `background-wording.json` | Never sent: the background-check wording no request (and no copy shared with other AI apps) may carry (owner decision 2026-11-14). The page (`core/src/harness/background-wording.ts`), native (`core/native-auth/src/background.rs`) and ozzie.church (a byte-for-byte copy, and a verbatim copy of the matching code) each refuse any text that varies holding it, before a request is made. On the oracle corpus it refuses everything the page's earlier regex refused apart from Ozzie's one own sentence (`core/test/harness/background-wording-oracle.test.ts`), and the three sides give the same verdict there and the same words for every character in the differential (`core/test/harness/background-wording-differential.test.ts`); shared vectors in `core/test/harness/background-wording-vectors.json`. Its `ozzies_own` is Ozzie's stale-check line, which a tool result carries as a whole string: only that whole string is set aside. The refresh tool's spec and the sunday-ready procedure also say "the last check is out of date"; they are pinned, never scanned, and the test names them. Nothing else above holds the wording (`core/test/harness/background-wording.test.ts`). |

## The system message

`policy + "\n\nProcedure: " + title + "\n" + body`, where `title` is the skill file's `title:` frontmatter value
(trimmed) and `body` is everything after the closing `---` fence line, trimmed (`core/src/harness/skills.ts`
`parseSkill`). An ask task uses the `answer-from-what-was-read` procedure. `pins.json` holds the sha-256 of the
resulting text for every bundled procedure, so native can pin it without parsing the skill files.

### AI on this Mac (2026-11-18)

On the wire to a model on this Mac (the local route) only, native `agent_step` sends an Ask's system message with
`policy-local.txt` in place of the policy, the procedure after it unchanged (`agent.rs` `step_body`, `fixed.rs`
`local_ask_system`). Every check runs first on the message exactly as the webview sent it, pinned as above; only the Ask
procedure's exact text is ever replaced, and only by these pinned words. A procedure task, and every other route, sends
the system message as checked. The local policy keeps every line of the policy that says what Ozzie is and never does,
word for word (tests on both sides), shows the answer forms with no example id (`FACT`, `DRAFT`, which the grammar never
accepts as ids: the medium model copied the policy's "f4" and "f3" before any lookup), says which lookup fits which
question, and what to choose when more than 24 facts would answer (measured 2026-11-18). `pins.json` still pins what
the webview sends, which is unchanged, and under `local_policy` the sha-256 of `policy-local.txt` and of the Ask system
message it makes, so a change to it fails a test on each side.

## The user message

A procedure task: exactly `Run this procedure now. Answer only with the JSON object.` (`vocabulary.json` `procedure_prompt`). An ask task: the
leader's question in placeholder form, under Ask's rules (the only free text besides the model's output).

## Tool messages

Either `{"error":"<code>"}` with a code from `tool_errors`, or a tool envelope serialized with `JSON.stringify`:
an object with exactly the keys `tool`, `source`, `check_time`, `completeness`, `payload`, where

- `tool` is in `tools`, `source` in `sources`, `completeness` in `completeness`;
- `check_time` is an ISO 8601 instant (`YYYY-MM-DDTHH:MM`, optional `:SS` and `.sss`, then `Z` or `±HH:MM`);
- `payload` is an object. Inside it every object key is in `payload_keys`; every number is a non-negative safe
  integer; booleans are allowed; `null` never is; under a key of `ids.keys` (`fact`, `draft_id`) the value is an id
  and nothing else (that key's prefix, then 1–9999 with no leading zero: `f3`, `d1`); and every other string is one of:
  - a value in `values`, exactly;
  - a placeholder label `[<family> <n>]` (`labels.families`, n 1–9999, no leading zero);
  - an ISO 8601 date-time (as `check_time`) or date (`YYYY-MM-DD`) that is a real date;
  - only under a key in `sentence_keys` (strings in a list under such a key count too): a sentence. Set aside
    every label (and `[Your name]`, only under a key in `labels.your_name_keys`) and every ISO time; what is
    left must hold no `[` or `]`, only the characters in `sentence_characters`, and every word (a run of
    ASCII letters with inner apostrophes, such as `it's` or `didn't`, compared in lower case) must be in
    `sentence_words`. Digit runs are counts.

`core/src/harness/fixed.ts` `envelopeProblems` is the reference implementation; the harness seals every tool
result with it (and with this session's own labels), so anything outside the grammar is never sent.

With more than one service watched (owner request 2026-11-21), a question that names a watched service carries that
service's `[Service <n>]` label instead of its name (`core/src/ask.ts` `prepareAsk`, `core/src/service-names.ts`), and the
task's own service labels keep the overview, open roles, who could help, pending requests, check-ins, what wasn't
checked and drafts to those services (`host.ts`, `tools.ts` `scope`), with those services' own reads and completeness,
and rooms, follow-ups and group meetings only for the first service (its page shows them); each such result says so
first, under `service`: one label, or a list of them.
No tool takes a service as an argument, so the tool specs, the policies and every system message are unchanged; only
this grammar gained the `Service` family and the `service` key. Without a service named, every result is as before.

Every result states facts with ids (structured answers, review 2026-11-14 section C): the payload itself under
`fact` (the tool's own summary), each row of the lists `tools.ts` `FACT_LISTS` names under `fact`, and a prepared
draft under `draft_id` instead. Ids are numbered in order within one task.

## The final answer

The model's final reply (a reply with no tool calls) is only a JSON object in the closed grammar of `vocabulary.json`
`answer` (`fixed.ts` `parseAnswer`, native `fixed::final_answer`, shared vectors in `core/test/answer-parity.json`):

```
{"answer":"facts","facts":["f3","f7"]}
{"answer":"not-covered"}                      (facts optional)
{"answer":"nothing-needs-a-decision"}         (facts optional)
{"answer":"draft","draft":"d1","facts":["f2"]} (facts optional)
```

Whitespace around it and one code fence (a first line of ```` ``` ```` or ```` ```json ````, a last line of
```` ``` ````) are allowed; nothing else: no prose, no other key, no repeated key, no escape (every string is
`[a-z0-9_-]`), at most `max_facts` distinct fact ids. Every id must be one a tool result in this task holds (native
checks the request's tool messages, the webview the task's evidence), and both refuse `nothing-needs-a-decision`
unless the task read the overview and it counts none (shared cases in `core/test/answer-parity.json` `evidence`).
Ozzie writes the answer's sentences on the Mac
from fixed templates per fact (`core/src/harness/compose.ts`), with people in label order and a draft only ever the
drafting tool's own text.

## Names: "capitalized only" (owner decision 2026-11-14)

A full name (a name term of two or more words) always counts. A single name part that is also a word in
`common-words.txt` counts only where its first letter is written as a capital, a capital at the start of a
sentence included: "Who will cover" is not Will; "Will can't" is. Spelled-out names, unspaced scripts and
contact details stay strict. Shared vectors: `core/test/ask-parity.json` `capitalizedCommonWords`.

## Changing a file

Every file here is pinned by `core/test/harness/fixed.test.ts`: the specs `tools.ts` offers equal
`tool-specs.json`, every result of every tool over every fixture fits `vocabulary.json`, and `instructions(task)`
equals the documented format with the hashes in `pins.json`. A change here (or to a bundled skill) changes
what native accepts, so it ships with the matching native build.
