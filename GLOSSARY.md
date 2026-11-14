# Ozzie

Language for Ozzie's leader-centered ministry workspace.

## Language

**Leader workspace**:
A leader's place for their ministry work, with chosen work shared with other leaders or ministries. Its audience is distinct from the audience of the church as a whole.
_Avoid_: All-church workspace, shared inbox

**Ozzie**:
The standalone church and ministry administration product, including its app and open-source project. Publicly attributed as “Ozzie by FlockConnect.”
_Avoid_: TableWork (former name)

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
