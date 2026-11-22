# Ozzie — never list (normative)

Written before features. If a feature cannot live inside this list, the
feature loses. These are NOT settings. No church, user, tier, or admin can
switch them off.

## The tool will never

1. Send a message to a church member. It drafts. A person sends, from their
   own email/phone/accounts. ("Send" to members does not exist in v1.)
2. Write, outline, or prepare a sermon, devotional, or pastoral teaching.
   No sermon surface exists. (Sharing material a pastor/leader chose is
   logistics; creating the material is not.)
3. Simulate pastoral care, counseling, prayer, or presence. It never speaks
   to a member as if it were a pastor, leader, or friend.
4. Score, rank, or label a person's spiritual health, faithfulness,
   belonging, or risk. No risk scores, no percentages on people, no
   "drifting / at risk" language. Ever.
5. Make a pastoral decision or act without a named human approving that
   specific action and seeing its exact effect first.
6. Change Planning Center (or any church system) in any way except the one
   change in core/native-auth/src/change.rs (adding one person to an open role
   as unconfirmed with the request waiting, and taking that same person off
   again while the request is unsent), and never even that unless the church
   turned changes on and a person confirmed that one exact change after seeing
   what it will do. Never on its own, never in a batch, never on a schedule.
   Any other write needs a recorded owner decision and an independent review.
7. Send people's real names (or leader care-share text) to a model.
   Placeholders go out; names are restored locally.
8. Present uncertainty as fact. Uncertain items are visibly weaker,
   labeled "Worth a look", with the reason for uncertainty on the card.
9. Hide what it read, when it read it, who approved what, or what it
   refused. Every finding carries its source and check time.
10. Continue silently after being ignored. No auto-escalation to members,
    no nagging loops. Ignoring the brief is always safe.
11. Let a button, link or other control that an AI described lead to a
    change. Any change in a church system is made only from Ozzie's own
    confirmation screen, written by Ozzie's code, after a person confirms
    that one change. This holds on every surface: the Mac app, a phone app,
    another AI app, and any screen format an agent can author (owner
    decision 2026-11-22).

## Handling sensitive things it encounters

- A person's own words that reveal a human need (e.g. in a reply the
  operator pastes/enters) are surfaced verbatim to the operator as a human
  item. No inference, enrichment, diagnosis, or forwarding is added.
- Leader → pastor sharing shows every person's name on the share screen
  before travel; names are removable; raw notes never travel.
- Crisis-adjacent content: surface promptly and unchanged to the human,
  clearly state the tool is not monitored emergency help; church-approved
  human route belongs to the church. (Implement conservatively; if unsure,
  show the words to the operator and do nothing else.)

## Language

Say: possible concern (of a schedule/task), may need an owner, worth a look,
insufficient information. Never say what a person is, believes, or needs
spiritually.
