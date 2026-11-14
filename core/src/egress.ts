const CONTACT = /\b[\w.+-]+@[\w-]+\.\w+\b|\(?\d{3}\)?[-. ]\d{3,4}[-. ]?\d{0,4}\b/;
const CARE_CONTENT = /\b(pray|prayer|hospital|diagnos|surgery|illness)\b/i;
/** Field allowlist: anything undeclared fails closed. There is no pass-through branch. */
const ALLOWED_KEYS = new Set(["note", "summary", "position", "draft"]);

/** Whole inert transcript, including tool details, partial events and errors.
 * Callers supply a closed vocabulary assembled from policy and anonymous facts,
 * never source strings. Unknown keys/strings fail before capture or transport.
 */
export function guardTranscript(value: unknown, keys: ReadonlySet<string>, strings: ReadonlySet<string>): string {
  let nodes = 0;
  const seen = new Set<object>();
  const visit = (v: unknown, depth: number): void => {
    if (++nodes > 10_000 || depth > 24) throw new Error("egress");
    if (typeof v === "string") { if (!strings.has(v)) throw new Error("egress"); return; }
    if (v === undefined || v === null || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (typeof v !== "object" || seen.has(v)) throw new Error("egress");
    const array = Array.isArray(v), proto = Object.getPrototypeOf(v);
    if ((array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(v).length) throw new Error("egress");
    seen.add(v);
    for (const [key, d] of Object.entries(Object.getOwnPropertyDescriptors(v))) {
      if (array && key === "length") continue;
      if (!("value" in d) || !d.enumerable || (!array && !keys.has(key)) ||
        (array && !/^(0|[1-9]\d*)$/.test(key))) throw new Error("egress");
      visit(d.value, depth + 1);
    }
    seen.delete(v);
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (typeof text !== "string" || Buffer.byteLength(text) > 65_536) throw new Error("egress");
  return text;
}

/**
 * Legacy text helper: exact known names become placeholders stable only within
 * this workspace-scoped instance. Not an unknown-name detector or model route.
 * Restoration is local and instance-bound; undeclared fields fail closed.
 */
export class EgressBoundary {
  private readonly tokenByName = new Map<string, string>();
  private readonly nameByToken = new Map<string, string>();
  constructor(
    workspace_id: string,
    knownNames: string[],
  ) {
    if (typeof workspace_id !== "string" || !workspace_id.trim() || workspace_id.length > 128 ||
      /[\x00-\x1f\x7f]/.test(workspace_id) || !Array.isArray(knownNames) ||
      Object.getPrototypeOf(knownNames) !== Array.prototype || knownNames.length < 1 || knownNames.length > 256 ||
      Object.getOwnPropertySymbols(knownNames).length || Object.keys(knownNames).length !== knownNames.length) {
      throw new Error("fail-closed: invalid name boundary");
    }
    const names: string[] = [];
    for (let index = 0; index < knownNames.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(knownNames, String(index));
      const name: unknown = descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (!descriptor?.enumerable || typeof name !== "string" || !name.trim() || name.length > 256 ||
        /[\x00-\x1f\x7f]/.test(name) || names.includes(name)) throw new Error("fail-closed: invalid name boundary");
      names.push(name);
    }
    const namespace = globalThis.crypto.randomUUID();
    names.forEach((name, i) => {
      let ordinal = i + 1, label = "";
      while (ordinal > 0) {
        ordinal--;
        label = String.fromCharCode(65 + ordinal % 26) + label;
        ordinal = Math.floor(ordinal / 26);
      }
      const token = `<Person-${label}@${namespace}>`;
      this.tokenByName.set(name, token);
      this.nameByToken.set(token, name);
    });
  }
  private checkText(text: unknown, limit: number): asserts text is string {
    if (typeof text !== "string" || text.length > limit) throw new Error("fail-closed: invalid text");
  }
  toModel(text: string): string {
    this.checkText(text, 65_536);
    if (CONTACT.test(text) || CARE_CONTENT.test(text)) {
      throw new Error("fail-closed: contact/care content in model payload");
    }
    const names = [...this.tokenByName.keys()].sort((a, b) => b.length - a.length)
      .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const out = text.replace(new RegExp([...names, "&", "<"].join("|"), "gu"), value =>
      this.tokenByName.get(value) ?? (value === "&" ? "&amp;" : "&lt;"));
    this.checkText(out, 262_144);
    return out;
  }
  restoreLocal(text: string): string {
    this.checkText(text, 262_144);
    const out = text.replace(/<Person-[^<>]*(?:>|(?=<)|$)|&(?:amp|lt);/gu, token => {
      if (token === "&amp;") return "&";
      if (token === "&lt;") return "<";
      const name = this.nameByToken.get(token);
      if (name === undefined) throw new Error("fail-closed: unrecognized placeholder");
      return name;
    });
    this.checkText(out, 65_536);
    return out;
  }
  toModelPayload(payload: Record<string, string>): Record<string, string> {
    try {
      if (payload === null || typeof payload !== "object" || Array.isArray(payload) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(payload)) ||
        Object.getOwnPropertySymbols(payload).length) throw new Error();
      const descriptors = Object.getOwnPropertyDescriptors(payload);
      if (Object.keys(descriptors).length > ALLOWED_KEYS.size) throw new Error();
      const out: Record<string, string> = {};
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (!ALLOWED_KEYS.has(key) || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
        out[key] = this.toModel(descriptor.value);
      }
      return out;
    } catch {
      throw new Error("fail-closed: invalid model payload");
    }
  }
}
