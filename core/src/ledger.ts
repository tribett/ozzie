export type RunState = "proposed" | "admitted" | "running" | "verified" | "failed" | "cancelled";

const NEXT: Record<RunState, RunState[]> = {
  proposed: ["admitted", "cancelled"],
  admitted: ["running", "cancelled"],
  running: ["verified", "failed", "cancelled"],
  verified: [],
  failed: [],
  cancelled: [],
};

/** Accepted-task state outside any conversation. Cancelled is terminal: late results cannot revive a run. */
export class TaskLedger {
  private readonly states = new Map<string, RunState>();
  private readonly staged = new Map<string, RunState>();
  transition(task: string, to: RunState): void {
    const from = this.staged.get(task) ?? this.states.get(task) ?? "proposed";
    if (!NEXT[from].includes(to)) throw new Error(`invalid transition ${from} -> ${to} (was ${from})`);
    if (this.staged.has(task)) this.staged.set(task, to);
    else this.states.set(task, to);
  }
  state(task: string): RunState {
    return this.staged.get(task) ?? this.states.get(task) ?? "proposed";
  }
  /** Stage hooks and final checks synchronously; only then commit a non-success terminal state. */
  settle(task: string, target: "failed" | "cancelled", beforeCommit: () => "failed" | "cancelled"): "failed" | "cancelled" {
    if (this.staged.has(task) || this.states.get(task) !== "running" || !["failed", "cancelled"].includes(target)) {
      throw new Error("invalid guarded terminal transition");
    }
    this.staged.set(task, "running");
    try {
      this.transition(task, target);
      if (this.staged.get(task) !== target) throw new Error("invalid guarded terminal transition");
      const selected = beforeCommit();
      if ((selected !== "failed" && selected !== "cancelled") || (target === "cancelled" && selected !== "cancelled")) {
        throw new Error("invalid guarded terminal transition");
      }
      this.states.set(task, selected);
      return selected;
    } finally {
      this.staged.delete(task);
    }
  }
}
