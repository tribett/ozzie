import { isJsonData } from "../read-result.js";

export const fields = ["name", "phone", "email", "request"] as const;
export type FieldName = typeof fields[number];
export type Reading = "unreviewed" | "typed" | "unclear" | "blank" | "not-readable";
export type Result = "ok" | "closed" | "invalid" | "review-required" | "finished" | "discarded";
export interface FieldView { readonly text: string; readonly state: Reading }
export interface CardView { readonly id: number; readonly label: string; readonly reviewed: boolean; readonly fields: Readonly<Record<FieldName, FieldView>> }
export interface ReviewView { readonly cards: readonly CardView[] }
interface Card { fields: Record<FieldName, { text: string; state: Reading }>; reviewed: boolean }

/** Reject accessors before detaching; subsequent checks never reread caller objects. */
function inertCopy(value: unknown): unknown {
  try { return isJsonData(value) ? structuredClone(value) : undefined; }
  catch { return undefined; }
}

/** Volatile manual-review lifecycle. Render leases read only the current generation.
 * No content snapshot, history, serialization or export interface is provided.
 */
export class CardReview {
  #generation = 0;
  #phase: "idle" | "choosing" | "loading" | "active" = "idle";
  #cards = new Map<number, Card>();
  #foreground = true;
  #workspace: string | null;
  constructor(workspace: string | null) { this.#workspace = workspace; }
  foreground(value: boolean, cause: "blur" | "hidden" | "pagehide" = "blur"): void {
    this.#foreground = value;
    if (!value && (this.#phase !== "choosing" || cause !== "blur")) this.close();
  }

  choose(): number | null {
    if (this.#phase !== "idle" || !this.#foreground || this.#workspace === null) return null;
    this.#phase = "choosing";
    return ++this.#generation;
  }
  current(ticket: number): boolean { return ticket === this.#generation && this.#phase !== "idle"; }
  attach(ticket: number, images: unknown): Result {
    if (!this.current(ticket) || this.#phase !== "choosing") return "closed";
    if (!this.#foreground) { this.close(); return "closed"; }
    const batch = inertCopy(images);
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > 8 ||
      batch.some(image => !image || typeof image !== "object" || Object.keys(image).sort().join(",") !== "size,type" ||
        !Number.isSafeInteger(image.size) || image.size < 1 || image.size > 8 * 1024 * 1024 ||
        !["image/png", "image/jpeg", "image/heic"].includes(image.type)) ||
      batch.reduce((total, image) => total + image.size, 0) > 24 * 1024 * 1024) {
      this.close();
      return "invalid";
    }
    batch.forEach((_, index) => this.#cards.set(index + 1, {
      fields: Object.fromEntries(fields.map(field => [field, { text: "", state: "unreviewed" }])) as Card["fields"], reviewed: false,
    }));
    this.#phase = "loading";
    return "ok";
  }
  ready(ticket: number): Result {
    if (!this.current(ticket) || this.#phase !== "loading") return "closed";
    this.#phase = "active";
    return "ok";
  }
  edit(ticket: number, event: unknown): Result {
    if (!this.current(ticket) || this.#phase !== "active") return "closed";
    const input = inertCopy(event);
    if (!input || typeof input !== "object") return "invalid";
    const e = input as Record<string, unknown>;
    const card = this.#cards.get(e.card as number);
    if (Object.keys(e).sort().join(",") !== "card,field,state,text" || !card || !fields.includes(e.field as FieldName) || typeof e.text !== "string" ||
      !["typed", "unclear", "blank", "not-readable"].includes(e.state as string)) return "invalid";
    if ([...e.text].length > (e.field === "request" ? 2000 : 256) ||
      ((e.state === "blank" || e.state === "not-readable") && e.text !== "") ||
      (e.state === "typed" && e.text === "")) return "invalid";
    card.fields[e.field as FieldName] = { text: e.text, state: e.state as Reading };
    card.reviewed = false;
    return "ok";
  }
  review(ticket: number, event: unknown): Result {
    if (!this.current(ticket) || this.#phase !== "active") return "closed";
    const input = inertCopy(event);
    if (!input || typeof input !== "object") return "invalid";
    const e = input as Record<string, unknown>;
    const card = this.#cards.get(e.card as number);
    if (Object.keys(e).sort().join(",") !== "acknowledge,card" || !card || typeof e.acknowledge !== "boolean") return "invalid";
    const values = Object.values(card.fields);
    if (values.some(f => f.state === "unreviewed") ||
      (values.some(f => f.state === "unclear" || f.state === "not-readable") && !e.acknowledge)) return "review-required";
    card.reviewed = true;
    return "ok";
  }
  remove(ticket: number, id: number): Result {
    if (!this.current(ticket) || this.#phase !== "active" || !this.#cards.delete(id)) return "closed";
    if (!this.#cards.size) this.close();
    return "ok";
  }
  finish(ticket: number): Result {
    if (!this.current(ticket) || this.#phase !== "active") return "closed";
    if (![...this.#cards.values()].every(card => card.reviewed)) return "review-required";
    this.close();
    return "finished";
  }
  discard(ticket?: number): Result {
    if (ticket !== undefined && !this.current(ticket)) return "closed";
    this.close(); return "discarded";
  }
  context(workspace: string | null): void { this.close(); this.#workspace = workspace; }
  private close(): void { this.#cards.clear(); this.#phase = "idle"; this.#generation++; }

  render(consume: (view: ReviewView) => void): void {
    const generation = this.#generation;
    const active = () => generation === this.#generation && this.#phase === "active";
    const ids = () => active() ? [...this.#cards.keys()] : [];
    const lookup = (id: number) => active() ? this.#cards.get(id) : undefined;
    consume(new class implements ReviewView {
      get cards(): readonly CardView[] {
        return ids().map(id => new class implements CardView {
          get id() { return lookup(id) ? id : 0; }
          get label() { return lookup(id) ? `Card ${id}` : ""; }
          get reviewed() { return lookup(id)?.reviewed ?? false; }
          get fields() {
            return Object.fromEntries(fields.map(field => [field, new class implements FieldView {
              get text() { return lookup(id)?.fields[field].text ?? ""; }
              get state(): Reading { return lookup(id)?.fields[field].state ?? "unreviewed"; }
            }])) as Record<FieldName, FieldView>;
          }
        });
      }
    });
  }
}
