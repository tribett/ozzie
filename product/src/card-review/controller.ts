import { CardReview, type Result, type ReviewView } from "../../../core/src/card-review/lifecycle.js";

export interface BrowserImages {
  foreground(): boolean;
  createURL(file: File): string;
  revokeURL(url: string): void;
  decode(url: string, signal: AbortSignal): Promise<boolean>;
}
type Status = "idle" | "choosing" | "loading" | "active" | "error" | "finished" | "closed";
interface ImageJob { file: File | null; url: string; abort: AbortController }

/** Browser handles stay here, apart from the core safety lifecycle. No history or content events. */
export class CardReviewController {
  #review: CardReview;
  #browser: BrowserImages;
  #ticket: number | null = null;
  #jobs = new Map<number, ImageJob>();
  #reset: (() => void) | null = null;
  #status: Status = "idle";
  #listeners = new Set<() => void>();
  #disposed = false;
  constructor(workspace: string | null, browser: BrowserImages) {
    this.#review = new CardReview(workspace);
    this.#browser = browser;
    this.#review.foreground(browser.foreground());
  }
  get status(): Status { return this.#status; }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  choose(reset: () => void): number | null {
    if (this.#disposed) return null;
    if (!this.#browser.foreground()) { this.interrupt("blur"); return null; }
    this.#review.foreground(true);
    const ticket = this.#review.choose();
    if (ticket === null) return null;
    this.#ticket = ticket;
    this.#reset = reset;
    reset();
    this.#status = "choosing";
    this.changed();
    return ticket;
  }
  select(ticket: number, files: readonly File[]): Promise<Result> {
    if (!this.valid(ticket) || this.#status !== "choosing") return Promise.resolve("closed");
    this.#reset?.();
    this.#review.foreground(this.#browser.foreground());
    if (!this.valid(ticket)) { this.close("closed"); return Promise.resolve("closed"); }
    try {
      // File handles are native browser inputs, not JSON events. Check the containing
      // array descriptors before observing elements; never invoke supplied accessors.
      if (!Array.isArray(files) || Object.getPrototypeOf(files) !== Array.prototype ||
        files.length < 1 || files.length > 8 || Object.getOwnPropertySymbols(files).length ||
        Object.entries(Object.getOwnPropertyDescriptors(files)).some(([key, descriptor]) =>
          key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || !descriptor.enumerable || !("value" in descriptor))) ||
        Object.keys(files).length !== files.length || files.some(file =>
          !(file instanceof File) || Object.getPrototypeOf(file) !== File.prototype ||
          Object.values(Object.getOwnPropertyDescriptors(file)).some(descriptor => !("value" in descriptor)))) {
        this.close("error"); return Promise.resolve("invalid");
      }
      const result = this.#review.attach(ticket, files.map(file => ({ size: file.size, type: file.type })));
      if (result !== "ok") { this.close("error"); return Promise.resolve(result); }
      files.forEach((file, index) => this.#jobs.set(index + 1, { file, url: "", abort: new AbortController() }));
    } catch { this.close("error"); return Promise.resolve("invalid"); }
    this.#status = "loading";
    this.changed();
    const pending = [...this.#jobs.values()].map(job => this.load(ticket, job));
    return Promise.all(pending).then(results => {
      if (!this.valid(ticket)) return "closed";
      if (!results.every(Boolean)) { this.close("error"); return "invalid"; }
      if (!this.#browser.foreground()) { this.interrupt("blur"); return "closed"; }
      const result = this.#review.ready(ticket);
      if (result === "ok") { this.#status = "active"; this.changed(); }
      return result;
    });
  }
  private async load(ticket: number, job: ImageJob): Promise<boolean> {
    try {
      // Only the signature slice is read into JS; never the complete image or a derivative.
      const type = job.file?.type;
      const bytes = new Uint8Array(await job.file!.slice(0, 12).arrayBuffer());
      if (!this.valid(ticket) || !job.file) return false;
      const png = [137, 80, 78, 71, 13, 10, 26, 10];
      const supported = type === "image/png" ? png.every((byte, i) => bytes[i] === byte) :
        type === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!supported) { this.close("error"); return false; }
      job.url = this.#browser.createURL(job.file);
      job.file = null;
      if (!job.url.startsWith("blob:")) { this.close("error"); return false; }
      const decoded = await this.#browser.decode(job.url, job.abort.signal);
      if (!this.valid(ticket)) return false;
      if (!decoded) { this.close("error"); return false; }
      return true;
    } catch {
      if (this.valid(ticket)) this.close("error");
      return false;
    }
  }
  source(ticket: number, id: number): string {
    return this.valid(ticket) && this.#status === "active" ? this.#jobs.get(id)?.url ?? "" : "";
  }
  render(consume: (view: ReviewView) => void): void { this.#review.render(consume); }
  edit(ticket: number, event: unknown): Result {
    const result = this.#review.edit(ticket, event); this.changed(); return result;
  }
  review(ticket: number, event: unknown): Result {
    const result = this.#review.review(ticket, event); this.changed(); return result;
  }
  remove(ticket: number, id: number): Result {
    const result = this.#review.remove(ticket, id);
    if (result === "ok") {
      const job = this.#jobs.get(id);
      if (job) this.release(job);
      this.#jobs.delete(id); this.#reset?.();
      if (!this.#jobs.size) this.close("closed"); else this.changed();
    }
    return result;
  }
  finish(ticket: number): Result {
    const result = this.#review.finish(ticket);
    if (result === "finished") this.close("finished");
    return result;
  }
  discard(ticket?: number): Result {
    const result = this.#review.discard(ticket);
    if (result === "discarded") this.close("closed");
    return result;
  }
  interrupt(cause: "blur" | "hidden" | "pagehide"): void {
    this.#review.foreground(false, cause);
    if (this.#ticket !== null && !this.#review.current(this.#ticket)) this.close("closed");
  }
  focus(): void {
    if (this.#browser.foreground()) this.#review.foreground(true); else this.interrupt("hidden");
  }
  context(workspace: string | null): void { this.#review.context(workspace); this.close("closed"); }
  dispose(): void { this.#disposed = true; this.close("closed"); this.#listeners.clear(); }
  private valid(ticket: number): boolean { return !this.#disposed && this.#ticket === ticket && this.#review.current(ticket); }
  private release(job: ImageJob): void {
    job.file = null;
    job.abort.abort();
    if (job.url) this.#browser.revokeURL(job.url);
    job.url = "";
  }
  private close(status: Status): void {
    this.#review.discard();
    this.#ticket = null;
    for (const job of this.#jobs.values()) this.release(job);
    this.#jobs.clear(); this.#reset?.(); this.#reset = null;
    this.#status = status;
    this.changed();
  }
  private changed(): void { for (const listener of this.#listeners) listener(); }
}
