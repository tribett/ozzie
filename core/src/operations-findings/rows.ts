import type { OperationsInput, ScopeKind, Target } from "./types.js";
import { targetKey, type Report, checkScopes } from "./scopes.js";

// Keys are sorted so ordinary JSON property ordering cannot create contradictory facts.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export function checkRows(input: OperationsInput, scopes: ReturnType<typeof checkScopes>, report: Report): OperationsInput {
  const dedupe = <T extends { scope_id: string }>(rows: T[], identity: (r: T) => string): T[] => {
    const groups = new Map<string, T[]>();
    for (const r of rows) { const key = identity(r); groups.set(key, [...(groups.get(key) ?? []), r]); }
    return [...groups.entries()].flatMap(([key, group]) => {
      if (group.length === 1) return group;
      const same = new Set(group.map(canonical)).size === 1;
      for (const r of group) report(same ? "duplicate-row" : "conflicting-row", r.scope_id, key);
      return same ? [group[0]!] : [];
    });
  };
  const clean: OperationsInput = { ...input,
    bookings: dedupe(input.bookings, b => JSON.stringify([b.resource_id, b.booking_id])),
    room_rules: dedupe(input.room_rules, r => r.resource_id),
    resolutions: dedupe(input.resolutions.map(r => ({ ...r, booking_ids: [...r.booking_ids].sort() as [string, string] })),
      r => JSON.stringify([r.resource_id, r.booking_ids, r.interval.starts_at, r.interval.ends_at])),
    // A current card cannot simultaneously occupy two steps of the same workflow.
    cards: dedupe(input.cards, c => JSON.stringify([c.workflow_id, c.card_id])),
  };
  const counts = new Map<string, number>();
  const reference = (id: string, kind: ScopeKind, target: Target) => {
    const declaration = input.required_scopes.find(r => r.scope_id === id);
    if (!declaration || declaration.kind !== kind || targetKey(declaration.target) !== targetKey(target)) {
      scopes.fail("undeclared-scope", id, targetKey(target)); scopes.usable.delete(id);
    } else counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  for (const b of clean.bookings) reference(b.scope_id, "bookings", { kind: "room", resource_id: b.resource_id });
  for (const r of clean.room_rules) reference(r.scope_id, "room-rule", { kind: "room", resource_id: r.resource_id });
  for (const r of clean.resolutions) reference(r.scope_id, "room-resolutions", { kind: "room", resource_id: r.resource_id });
  for (const c of clean.cards) {
    const target: Target = { kind: "step", workflow_id: c.workflow_id, step_id: c.step_id };
    reference(c.scope_id, "cards", target); reference(c.lifecycle.scope_id, "card-state", target);
    reference(c.assignment.scope_id, "assignments", target); reference(c.due.scope_id, "due", target); reference(c.snooze.scope_id, "snooze", target);
  }
  for (const s of input.scopes) if (s.expected_count !== (counts.get(s.scope_id) ?? 0)) {
    scopes.fail("count-mismatch", s.scope_id); scopes.usable.delete(s.scope_id);
  }
  clean.resolutions = clean.resolutions.filter(r => {
    const found = r.booking_ids.every(id => clean.bookings.some(b => b.resource_id === r.resource_id && b.booking_id === id));
    if (!found) report("unknown-resolution", r.scope_id, r.resource_id);
    return found;
  });
  return clean;
}
