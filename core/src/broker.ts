export type Completeness = "complete" | "partial" | "stale" | "denied";
export type ToolError = "denied" | "stale" | "partial" | "provider-failure" | "unverified";

export interface Envelope {
  source: string;
  check_time: string;
  completeness: Completeness;
  payload: unknown;
}

export type RunResult = { ok: true; envelope: Envelope } | { ok: false; error: ToolError };

export class ToolFailure extends Error {
  constructor(readonly code: ToolError) {
    super(code);
  }
}

export interface ReadTool {
  name: string;
  read(args: Record<string, unknown>, context?: { signal?: AbortSignal }): Envelope | Promise<Envelope>;
}

/** Admits only registered, fixed read tools for one workspace. No write tool can exist here. */
export class AuthorizationBroker {
  private readonly tools = new Map<string, ReadTool>();
  constructor(
    private readonly workspace_id: string,
    private readonly service_types: string[] = [],
  ) {}
  register(tool: ReadTool): void {
    this.tools.set(tool.name, tool);
  }
  toolNames(): string[] {
    return [...this.tools.keys()];
  }
  async run(req: { workspace_id: string; tool: string; args: Record<string, unknown> }, context?: { signal?: AbortSignal }): Promise<RunResult> {
    if (context?.signal?.aborted) return { ok: false, error: "unverified" };
    if (req.workspace_id !== this.workspace_id || req.args["workspace_id"] !== this.workspace_id) {
      return { ok: false, error: "denied" };
    }
    const tool = this.tools.get(req.tool);
    if (!tool) return { ok: false, error: "denied" };
    const serviceType = req.args["service_type_id"];
    if (typeof serviceType !== "string" || !this.service_types.includes(serviceType)) {
      return { ok: false, error: "denied" };
    }
    try {
      const envelope = await tool.read(req.args, context);
      if (context?.signal?.aborted) return { ok: false, error: "unverified" };
      return { ok: true, envelope };
    } catch (e) {
      if (e instanceof ToolFailure) return { ok: false, error: e.code };
      return { ok: false, error: "provider-failure" };
    }
  }
}
