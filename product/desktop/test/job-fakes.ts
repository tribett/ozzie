// Fakes for a job's runner (responsibility-runner.ts): the native store with the rules a test needs (status, one per
// template, Pause everything, runs, the gap and busy) and this Mac's key-value store. Nothing native runs.
import { MIN_GAP_MS, TEMPLATES, type Responsibility, type RunRow } from "../../../core/src/harness/responsibilities.js";
import type { ResponsibilityNative } from "../src/responsibility-runner.js";

export function fakeJobStore(clock: () => string) {
  const items: Responsibility[] = [];
  let pausedAll = false;
  let n = 0;
  const calls: string[] = [];
  /** `next`: refuse the next begin with this code; `always`: refuse every begin with it until cleared. */
  const refuse: { next: string | null; always: string | null } = { next: null, always: null };
  const id = (k: number) => `00000000-0000-4000-8000-${k.toString(16).padStart(12, "0")}`;
  const find = (rid: string) => { const r = items.find(x => x.id === rid); if (!r) throw "unknown"; return r; };
  const listing = () => {
    for (const r of items) if (r.lifetime.kind === "until" && clock() >= r.lifetime.ends_at) r.status = "ended";
    return { paused_all: pausedAll, items: structuredClone(items) };
  };
  const native: ResponsibilityNative = {
    list: async () => listing(),
    create: async plan => {
      if (items.some(x => x.template === plan.template && x.status !== "ended")) throw "exists";
      const t = TEMPLATES[plan.template];
      const r: Responsibility = { ...structuredClone(plan), id: id(++n), title: t.title, skill_id: t.skill_id, status: "active", created_at: clock(), confirmed_at: clock(), runs: [], open_run: null };
      items.push(r);
      calls.push(`create ${plan.template}`);
      return structuredClone(r);
    },
    edit: async (rid, plan) => { Object.assign(find(rid), structuredClone(plan)); return structuredClone(find(rid)); },
    pause: async rid => { find(rid).status = "paused"; calls.push("pause"); return structuredClone(find(rid)); },
    resume: async rid => { find(rid).status = "active"; calls.push("resume"); return structuredClone(find(rid)); },
    stop: async rid => { find(rid).status = "ended"; calls.push("stop"); return structuredClone(find(rid)); },
    pauseAll: async paused => { pausedAll = paused; calls.push(`pause-all ${paused}`); return listing(); },
    begin: async (rid, trigger) => {
      calls.push(`begin ${trigger}`);
      if (refuse.next) { const code = refuse.next; refuse.next = null; throw code; }
      if (refuse.always) throw refuse.always;
      if (pausedAll) throw "paused-all";
      const r = find(rid);
      if (r.status !== "active") throw r.status === "paused" ? "paused" : "ended";
      if (r.open_run) throw "busy";
      if (r.runs[0] && Date.parse(clock()) - Date.parse(r.runs[0].started_at) < MIN_GAP_MS) throw "too-soon";
      const run: RunRow = { run_id: id(1000 + ++n), trigger, started_at: clock(), ended_at: null, outcome: null, code: null, noticed: 0, drafts: 0, ai_steps: 0 };
      r.runs.unshift(run);
      r.open_run = run;
      return { run_id: run.run_id, ai_steps: 6, checks_left: 5 };
    },
    end: async (rid, runId, outcome, code, noticed, drafts) => {
      calls.push(`end ${outcome} ${code ?? "-"} ${noticed} ${drafts}`);
      const r = find(rid);
      const run = r.runs.find(x => x.run_id === runId && !x.ended_at);
      if (!run) throw "no-run";
      Object.assign(run, { ended_at: clock(), outcome, code, noticed, drafts });
      r.open_run = null;
      return structuredClone(r);
    },
  };
  return { native, calls, refuse, items, setPausedAll: (p: boolean) => { pausedAll = p; } };
}

export function memoryStore() {
  const data = new Map<string, string>();
  return { get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => { data.set(k, v); }, dump: () => [...data.entries()].sort(([a], [b]) => a < b ? -1 : 1) };
}
