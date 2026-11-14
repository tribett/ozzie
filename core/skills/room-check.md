---
id: room-check
title: Room check
purpose: Finds room bookings this Sunday that overlap under your room rules.
tools: rooms.conflicts, rules.current, sunday.not_checked
needs: services, operations
runs: on-request, automatic
---
For rooms booked in Planning Center Calendar on this Sunday.

1. Look at the room bookings that overlap, including any setup time your Church rules add.
2. For each, give the room, the overlapping time, each booking's time and approval, and whether Planning Center shows the overlap as worked out.
3. Say which room rules applied. A room with no rule set isn't treated as a problem.
4. If room bookings weren't fully read, or Calendar isn't part of this connection, say so. That is never the same as no overlap.

Ozzie doesn't move or cancel bookings. Someone with access to Calendar decides what happens next.

How the answer is written: the AI only picks which of these facts to show. Ozzie writes every sentence on this Mac, with people in its own order.
