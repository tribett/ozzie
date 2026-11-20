# Ozzie

Language for Ozzie's leader-centered ministry workspace.

## Language

**Leader workspace**:
A leader's place for their ministry work, with chosen work shared with other leaders or ministries. Its audience is distinct from the audience of the church as a whole.
_Avoid_: All-church workspace, shared inbox

**Ozzie**:
The standalone church and ministry administration product, including its app and open-source project. Publicly attributed as “Ozzie by FlockConnect.”

**Church rules**:
The church's own stated expectations for its gatherings — for example how many adults a room needs — written in plain language, visible and changeable by the leader.
_Avoid_: Settings, policies, skills

**Finding**:
A fact Ozzie checked, shown with its source and the time it was checked. A finding is never a judgement of a person.
_Avoid_: Alert (unless it interrupts), risk flag, score

**Why I flagged this**:
The short explanation on a finding naming the church rule, the limit in that rule, and the facts that matched it.
_Avoid_: View sources, reasoning, explanation trace

**Worth a look**:
The label for an uncertain item Ozzie is unsure about. It never interrupts and was not checked as solid.
_Avoid_: Low confidence, possible risk

**Coverage slot**:
A specific serving role at a specific gathering time that still needs a person, after people who said yes are counted.
_Avoid_: Gap, vacancy (in code names, `slot` is fine)

**Resolved by you**:
A finding the leader marked as handled themselves. It does not mean the source system shows the role filled.
_Avoid_: Confirmed, completed, covered

**Placeholder**:
A stand-in word shown to a model in place of a person's real name, swapped back to the real name on the leader's own device.
_Avoid_: Token, redaction (on user surfaces)

**Needs your attention / Ready to review / In progress**:
The three groups on the home view: things only the leader can act on; prepared work waiting for the leader's decision; accepted work underway. Counts count items, never people.
_Avoid_: Blocked, pending approval

**What happened**:
The plain-language record of work Ozzie did, saw, and was refused — including checks that could not be completed.
_Avoid_: Log, audit trail, session history

**Ongoing responsibility**:
An outcome a leader has asked Ozzie to keep working toward over time, within agreed limits. Ozzie may choose permitted steps toward that outcome; the leader retains decisions outside those limits.
_Avoid_: Blanket permission, fixed routine (unless the procedure itself is fixed)

**Kids team**:
A Services team the church marks in Church rules as serving with kids. Kids rules apply only to kids teams: at least N confirmed people at each service time, and a current background check on file for anyone scheduled. No team is a kids team until the church marks it.
_Avoid_: Adults (Ozzie counts confirmed people; it doesn't check ages), children's ministry check

**Feedback entry**:
A Church rules entry made from a finding card: a correction ("This isn't right"), a stop ("Stop flagging this"), an always ("Always do this"), or a notice choice for a kind of finding ("Always tell me right away", "Put this in the briefing"). Each is listed on Church rules and can be undone or deleted; nothing is learned silently.
_Avoid_: Learned preference (on user surfaces), training, memory

**Set aside**:
A Today item the leader has moved out of the way until a stated time ("until tomorrow", "until Monday"). It comes back on time and is never counted as handled.
_Avoid_: Dismiss, snooze-forever, done

**Overnight**:
The label on an item that came up during quiet hours. It waits for the morning briefing instead of interrupting.
_Avoid_: Missed, late

**Sunday Ready brief**:
The full summary of where the coming Sunday stands, shown in Thursday's morning briefing.
_Avoid_: Sunday report card, readiness score

**Ozzie managed**:
The paid hosted AI route at ozzie.church. The Mac connects in the browser; every request requires zero data retention and a reply without its confirmation is refused.
_Avoid_: Cloud Ozzie, Ozzie AI key

**Shared check**:
The placeholder-only copy of Ozzie's last saved check that another AI app on the same Mac can read when the leader turns on "Use Ozzie's last check in other AI apps". It holds no names and no background-check facts. In UI copy, use "Ozzie's last check in other AI apps".
_Avoid_: MCP, connector, export (on user surfaces)

**Copy for Siri and Shortcuts**:
The smaller shared check that Ozzie's Siri actions and its bundled helper answer Siri and Shortcuts from while "Let Siri and Shortcuts ask Ozzie" is on: the Sunday overview only, checked like the shared check. Answers from it are counts, dates and Ozzie's own words, never a label or name. In UI copy, use "the copy Siri and Shortcuts answer from".
_Avoid_: Siri integration, export

**Siri actions**:
Ozzie's own actions in Siri, Spotlight and the Shortcuts app with no setup: "Are my services covered", "Open Ozzie's Services page" and "Open Ozzie's Today page" (until 2026-11-19 "Is Sunday covered" and "Open Ozzie's Sunday page"; those phrases still work) (App Intents in a sandboxed extension bundled with Ozzie, ADR 0007). They answer with the helper's own code from the copy for Siri and Shortcuts, and only while the switch is on. In UI copy, use "Ozzie's actions".
_Avoid_: intents, App Intents, extension (on user surfaces)
