import type { Evidence, IssueCode, OperationsInput, RequiredScope, ScopeKind, Target } from "./types.js";
export type Report = (code: IssueCode, scope_id: string | null, subject_id: string | null) => void;
export const targetKey = (t: Target): string => JSON.stringify(t.kind === "room" ? ["room", t.resource_id] : ["step", t.workflow_id, t.step_id]);
const sameWindow = (a: OperationsInput["window"], b: OperationsInput["window"]) => Date.parse(a.starts_at) === Date.parse(b.starts_at) && Date.parse(a.ends_at) === Date.parse(b.ends_at);
const roomKinds: ScopeKind[] = ["bookings", "room-rule", "room-resolutions"];
const stepKinds: ScopeKind[] = ["cards", "card-state", "assignments", "due", "snooze"];

export function checkScopes(input: OperationsInput, report: Report) {
  const usable = new Map<string, RequiredScope>();
  const evidence: Evidence[] = [], unchecked = new Set<string>();
  const declarations = input.required_scopes;
  const fail = (code: IssueCode, id: string | null, subject: string | null = null) => {
    report(code, id, subject); if (id !== null) unchecked.add(id);
  };
  if (!declarations.length) fail("missing-scope", null);
  const targets = new Map<string, Target>();
  for (const r of declarations) targets.set(targetKey(r.target), r.target);
  for (const b of [...input.bookings, ...input.room_rules, ...input.resolutions]) {
    const t: Target = { kind: "room", resource_id: b.resource_id }; targets.set(targetKey(t), t);
  }
  for (const c of input.cards) {
    const t: Target = { kind: "step", workflow_id: c.workflow_id, step_id: c.step_id }; targets.set(targetKey(t), t);
  }
  const ambiguous = new Set<string>();
  for (const [key, t] of targets) for (const kind of t.kind === "room" ? roomKinds : stepKinds) {
    const matches = declarations.filter(r => targetKey(r.target) === key && r.kind === kind);
    if (!matches.length) fail("missing-scope", null, key);
    if (matches.length > 1) for (const r of matches) { fail("duplicate-scope", r.scope_id, key); ambiguous.add(r.scope_id); }
  }
  for (const s of input.scopes) if (!declarations.some(r => r.scope_id === s.scope_id)) fail("undeclared-scope", s.scope_id);
  for (const r of declarations) {
    const actual = input.scopes.filter(s => s.scope_id === r.scope_id);
    if (declarations.filter(d => d.scope_id === r.scope_id).length !== 1 || ambiguous.has(r.scope_id)) { fail("duplicate-scope", r.scope_id); continue; }
    if (actual.length !== 1) { fail(actual.length ? "duplicate-scope" : "missing-scope", r.scope_id); continue; }
    if (!(r.target.kind === "room" ? roomKinds : stepKinds).includes(r.kind)) { fail("undeclared-scope", r.scope_id); continue; }
    const s = actual[0]!;
    let valid = true;
    const invalid = (code: IssueCode) => { fail(code, r.scope_id); valid = false; };
    if (s.binding.workspace_id !== input.binding.workspace_id || s.binding.organization_id !== input.binding.organization_id || s.binding.access_epoch !== input.binding.access_epoch) invalid("binding-mismatch");
    if (!sameWindow(s.window, input.window)) invalid("window-mismatch");
    if (s.completeness !== "complete" || s.errors.length) invalid("incomplete-scope");
    if (!s.enumeration_complete) invalid("enumeration-gap");
    const check = Date.parse(s.check_time), until = Date.parse(s.valid_until), now = Date.parse(input.evaluated_at);
    if (!(check <= now && now < until && until - check <= 86400000)) invalid("invalid-clock");
    const label = r.kind === "room-rule" ? "church-rule" : r.target.kind === "room" ? "normalized-calendar" : "normalized-workflow";
    if (s.source !== label) invalid("undeclared-scope");
    if (valid) { usable.set(r.scope_id, r); evidence.push({ ...r, source: s.source, check_time: s.check_time, valid_until: s.valid_until }); }
  }
  const matches = (id: string, kind: ScopeKind, target: Target) => {
    const r = usable.get(id);
    return !!r && r.kind === kind && targetKey(r.target) === targetKey(target);
  };
  return { usable, evidence, unchecked, fail, matches };
}
