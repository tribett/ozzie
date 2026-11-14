// The broker-backed ToolHost (build contract §2.1, harness contract ToolHost). What a task may use is
// decided here, outside model control:
//   admitted(task) = skill.tools ∩ NATIVE_TOOL_ALLOWLIST ∩ what the connection was granted
// (Calendar/People/Groups tools only with that grant; a Planning Center refresh only when a
// connection is usable and the skill lists it), for this workspace only.
// run() denies anything not admitted, checks arguments against the fixed schema (labels must be ones
// this session issued), allows one Planning Center refresh per task, bounds each tool by
// HARNESS_LIMITS.toolMs and the task's signal, and maps every failure to the contract's ToolError
// codes. Each run goes through an AuthorizationBroker bound to the workspace and to the service types
// this host was set up for, so a task for another workspace, or data from another service type
// passed in later, is denied there too.
import { AuthorizationBroker, ToolFailure } from "../broker.js";
import { HARNESS_LIMITS, type AgentTask, type Skill, type ToolEnvelope, type ToolHost, type ToolResult, type ToolSpec } from "./contract.js";
import { checkArguments, isToolName, OPERATIONS_TOOLS, TOOL_SPECS, type HarnessTools } from "./tools.js";

export interface HostOptions {
  /** The workspace this host serves; tasks for any other are admitted nothing. */
  workspace_id: string;
  tools: HarnessTools;
  skills: ReadonlyMap<string, Skill>;
  /** The Planning Center service types this workspace reads. Defaults to the service type of the first check the host sees. */
  serviceTypes?: readonly string[];
  /** Defaults to HARNESS_LIMITS.toolMs. */
  toolMs?: number;
}

export class HarnessHost implements ToolHost {
  readonly #workspace: string;
  readonly #tools: HarnessTools;
  readonly #skills: ReadonlyMap<string, Skill>;
  #serviceTypes: readonly string[] | null;
  readonly #toolMs: number;
  /** Tasks that already checked Planning Center again (review B-S8: one refresh per task). */
  readonly #refreshed = new Set<string>();
  constructor(options: HostOptions) {
    this.#workspace = options.workspace_id;
    this.#tools = options.tools;
    this.#skills = options.skills;
    // Fixed once, never re-read from later data (review N7: binding to each check's own service type checked nothing).
    const own = options.tools.data.capture?.service_type_id;
    this.#serviceTypes = options.serviceTypes ? Object.freeze([...options.serviceTypes]) : own ? Object.freeze([own]) : null;
    this.#toolMs = options.toolMs ?? HARNESS_LIMITS.toolMs;
  }

  admitted(task: AgentTask): ToolSpec[] {
    if (task.workspace_id !== this.#workspace) return [];
    const skill = this.#skills.get(task.skill_id);
    if (!skill) return [];
    const data = this.#tools.data;
    const operations = data.granted.includes("operations");
    const refresh = data.connected && typeof data.refresh === "function";
    return [...new Set<string>(skill.tools)].flatMap(name => {
      if (!isToolName(name)) return [];
      if (OPERATIONS_TOOLS.has(name) && !operations) return [];
      if (name === "planning_center.refresh" && !refresh) return [];
      return [TOOL_SPECS[name]];
    });
  }

  async run(task: AgentTask, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) return { ok: false, error: "unverified" };
    if (!isToolName(name) || !this.admitted(task).some(s => s.name === name)) return { ok: false, error: "denied" };
    const checked = checkArguments(TOOL_SPECS[name], args, this.#tools.session);
    if (!checked) return { ok: false, error: "denied" };
    if (name === "planning_center.refresh") {
      if (this.#refreshed.has(task.id)) return { ok: false, error: "denied" };
      this.#refreshed.add(task.id);
    }

    // The service type of the data the tool will read, checked against the types this host was set up for.
    const serviceType = this.#tools.data.capture?.service_type_id ?? "none";
    if (this.#serviceTypes === null && this.#tools.data.capture?.service_type_id) this.#serviceTypes = Object.freeze([serviceType]);
    const broker = new AuthorizationBroker(this.#workspace, [...(this.#serviceTypes ?? [])]);
    const tools = this.#tools;
    broker.register({ name, read: (_args, context) => tools.run(name, checked, context?.signal ?? signal, task.id) });

    // One controller per tool: aborted by the task's signal or when the tool runs past toolMs.
    const controller = new AbortController();
    let cancelled = () => {};
    const onAbort = () => { controller.abort(); cancelled(); };
    signal.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<ToolResult>(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve({ ok: false, error: "provider-failure" }); }, this.#toolMs);
      cancelled = () => resolve({ ok: false, error: "unverified" });
    });
    try {
      const ran = broker.run({ workspace_id: task.workspace_id, tool: name, args: { ...checked, workspace_id: task.workspace_id, service_type_id: serviceType } },
        { signal: controller.signal }).then((r): ToolResult => r.ok ? { ok: true, envelope: r.envelope as ToolEnvelope } : { ok: false, error: r.error });
      return await Promise.race([ran, stopped]);
    } catch (e) {
      return { ok: false, error: e instanceof ToolFailure ? e.code : "provider-failure" };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
