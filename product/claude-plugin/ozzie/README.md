# Ozzie

Ozzie is a Mac app for church staff and ministry leaders. It reads your church's Planning Center, B1 Church or Breeze, keeps watch over the coming Sunday and tells you what needs a decision. This plugin lets Claude read Ozzie's last check, so you can ask about Sunday in your own words and get an answer that says where each fact came from and when it was checked.

The names Ozzie read stay on your Mac. Claude sees labels like [Person 1] instead, and it can't change or send anything through Ozzie.

## What Claude can read

- **Sunday readiness**: roles that still need people, requests without an answer, check-ins your Church rules suggest, and what the check couldn't cover.
- **Rooms, follow-ups and group meetings**: room bookings that overlap, overdue follow-ups without an owner, and group meetings at the same time as someone's serving, when your church's Planning Center connection includes Calendar, People and Groups.
- **Church rules**: the rules Ozzie checks against, in words, and the procedures Ozzie follows.
- **What happened**: what Ozzie did recently on your Mac and how it ended, never what you asked Ozzie or what it answered.

A check of Planning Center, B1 Church or Breeze is shared. Genesis shares no volunteer schedules, so with Genesis there is no check to share.

## What Claude can't do

- See a name through Ozzie. People, roles, rooms and follow-ups appear as labels like [Person 1], [Role 1] and [Room 1]. The names stay in Ozzie, on your Mac.
- Check your church's system again, change anything or send anything. Ozzie prepares, and people decide.
- See anything about background checks, or anything you asked Ozzie.
- Read anything from your church's check while sharing is off. Sharing is off until you turn it on, and turning it off removes the shared copy.

Claude Code and Cowork can also open files and folders on your Mac when you allow it. Ozzie keeps the names in its own folder in your Library, so don't give Claude that folder. This plugin's guidance asks Claude not to look there.

## Before you start

1. Install Ozzie for Mac from https://ozzie.church and keep it in your Applications folder.
2. In Ozzie, open Settings and, under Other AI apps, Spotlight and Shortcuts, turn on "Use Ozzie's last check in other AI apps".
3. Check your church's system in Ozzie. To try it with invented data first, choose See an example church first on Ozzie's first screen, or See a fictional example on its Services page before your first check.

## Where it works

- **Cowork on your Mac, and Claude Code on your Mac**: this plugin starts the part of Ozzie that reads its last check.
- **Claude chat in the Claude app for Mac**: chat doesn't start programs from a plugin, so add Ozzie from Ozzie itself. With sharing on, choose Add Ozzie to Claude in the same part of Ozzie's Settings. This plugin's guidance for Claude still applies there.
- **Claude on the web and on phones**: Claude can't read Ozzie there, because Ozzie's check stays on your Mac.

## Try it

With the fictional example open in Ozzie and sharing on, ask Claude:

- "What still needs a decision for Sunday in Ozzie's last check?"
- "Are any rooms double-booked this Sunday, or follow-ups nobody owns?"
- "What are our Church rules in Ozzie, and when did Ozzie last check Sunday?"

## What this plugin runs, reads and sends

This plugin holds no program of its own. In Cowork and Claude Code it runs one thing: the read-only helper that comes inside Ozzie for Mac, `/Applications/Ozzie.app/Contents/MacOS/ozzie-share`, with nothing added to it. That helper reads only the copy Ozzie saved at its last check, in Ozzie's own folder on your Mac, and only while sharing is on. It opens no network connection, starts no other program and writes no file. The plugin itself fetches nothing and sends nothing anywhere.

What Claude reads from Ozzie becomes part of your conversation with Claude, and your Claude account's terms apply to it. That's why the names stay in Ozzie, and why sharing is off until you turn it on.

The helper's source code is public in Ozzie's repository, https://github.com/tribett/ozzie, in `product/desktop/src-tauri/helpers/share.swift` and the code it runs.

## Privacy and help

- Privacy policy: https://ozzie.church/privacy
- How Ozzie keeps names on your Mac: https://ozzie.church/privacy-and-safety
- Help: https://github.com/tribett/ozzie/issues, or write to the support address listed at https://ozzie.church/privacy

Ozzie is made by FlockConnect LLC. It isn't made by, or affiliated with, Planning Center or Anthropic.
