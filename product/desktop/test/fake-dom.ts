// A small stand-in for the browser's document, so a test can mount a page with React, run its effects, change its props
// and press a button, where no DOM library is installed (review P, L1). Tests only. Elements are plain objects; what a
// person would see is read back with `seen` (text, and what fields hold). Install it before react-dom/client is
// imported: React decides whether it has a DOM when that module loads.
type Listener = (event: unknown) => void;
const HTML = "http://www.w3.org/1999/xhtml";

class FakeNode {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeValue: string | null = null;
  readonly #listeners = new Map<string, Set<Listener>>();
  constructor(readonly nodeType: number, readonly nodeName: string, public ownerDocument: FakeDocument | null) {}
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): FakeNode | null { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  appendChild<T extends FakeNode>(child: T): T { return this.insertBefore(child, null); }
  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(child); else this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at >= 0) this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  contains(node: FakeNode | null): boolean {
    for (let at = node; at; at = at.parentNode) if (at === this) return true;
    return false;
  }
  get textContent(): string { return this.nodeType === 3 ? this.nodeValue ?? "" : this.childNodes.map(c => c.textContent).join(""); }
  set textContent(text: string) {
    if (this.nodeType === 3) { this.nodeValue = text; return; }
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(this.ownerDocument!.createTextNode(text));
  }
  addEventListener(type: string, listener: Listener) {
    const set = this.#listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.#listeners.set(type, set);
  }
  removeEventListener(type: string, listener: Listener) { this.#listeners.get(type)?.delete(listener); }
}

class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, unknown> = { setProperty() {}, removeProperty() {} };
  constructor(readonly tagName: string, readonly namespaceURI: string, doc: FakeDocument) { super(1, tagName, doc); }
  get localName() { return this.tagName.toLowerCase(); }
  /** A select's options, in order, as React reads them to mark the chosen one (Keeping watch's "Every" choice). */
  get options(): FakeNode[] | undefined {
    if (this.tagName !== "SELECT") return undefined;
    const all = (n: FakeNode): FakeNode[] => n.childNodes.flatMap(c => [c, ...all(c)]);
    return all(this).filter(n => (n as FakeElement).tagName === "OPTION");
  }
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  setAttributeNS(_ns: string | null, name: string, value: unknown) { this.setAttribute(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  removeAttributeNS(_ns: string | null, name: string) { this.removeAttribute(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
  /** Moves the document's focus here only when the test asked for focus to be kept (installFakeDom's `focus`). */
  focus() { const doc = this.ownerDocument; if (doc?.keepsFocus) doc.activeElement = this; }
  blur() {}
  scrollIntoView() {}
  scrollBy() {}
  /** Nothing is laid out: every box is empty at the top left (a test that needs a place gives one of its own). */
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }; }
}

class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement | null = null;
  keepsFocus = false;
  defaultView: unknown = null;
  constructor() {
    super(9, "#document", null);
    this.ownerDocument = null;
    this.documentElement = this.createElement("html");
    this.body = this.createElement("body");
    this.appendChild(this.documentElement).appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) { return new FakeElement(tag.toUpperCase(), HTML, this); }
  createElementNS(namespace: string, tag: string) { return new FakeElement(tag, namespace, this); }
  createTextNode(text: string) { const node = new FakeNode(3, "#text", this); node.nodeValue = text; return node; }
  createComment(text: string) { const node = new FakeNode(8, "#comment", this); node.nodeValue = text; return node; }
}

export type FakeDom = {
  /** The element a test renders into, inside the fake body. */
  root: FakeElement;
  /** Everything a person would see under `node`: its text, and what each field holds. */
  seen(node?: FakeNode): string;
  /** Every picture under `node` (an img, or any element whose src or href is an object URL), by its source. */
  pictures(node?: FakeNode): string[];
  /** The first button whose text is exactly `label`, or null. */
  button(label: string): FakeElement | null;
  /** Presses a button the way React hears a click: its own onClick. */
  press(button: FakeElement): void;
  /** Where the keyboard focus is (kept only when installed with `focus`). */
  focused(): FakeElement | null;
};

/**
 * Puts a fake `window` and `document` on globalThis for this test file. With `focus`, an element's focus() becomes the
 * document's activeElement, so a test can see where the keyboard focus went.
 */
export function installFakeDom({ focus = false }: { focus?: boolean } = {}): FakeDom {
  const document = new FakeDocument();
  document.keepsFocus = focus;
  const window: Record<string, unknown> = {
    document, event: undefined, HTMLIFrameElement: class {}, navigator: globalThis.navigator,
    addEventListener() {}, removeEventListener() {}, getSelection: () => null,
  };
  window.window = window;
  document.defaultView = window;
  Object.assign(globalThis, { window, document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = document.body.appendChild(document.createElement("div"));
  const all = (node: FakeNode): FakeNode[] => [node, ...node.childNodes.flatMap(all)];
  return {
    root,
    seen(node: FakeNode = root) {
      // React gives an input its value, and a text area its defaultValue (a browser shows that as the area's text).
      const fields = all(node).flatMap(n => (["value", "defaultValue"] as const)
        .flatMap(k => { const v = (n as Partial<Record<typeof k, unknown>>)[k]; return typeof v === "string" ? [v] : []; }));
      return [node.textContent, ...fields].join("\n");
    },
    pictures(node: FakeNode = root) {
      return all(node).flatMap(n => {
        if (!(n instanceof FakeElement)) return [];
        const sources = ["src", "href", "srcset", "poster"].map(a => n.getAttribute(a)).filter((v): v is string => v !== null);
        return n.tagName === "IMG" || sources.some(v => v.startsWith("blob:")) ? [sources.join(" ") || n.tagName] : [];
      });
    },
    button(label: string) {
      return (all(root).find(n => n instanceof FakeElement && n.tagName === "BUTTON" && n.textContent === label) as FakeElement | undefined) ?? null;
    },
    press(button: FakeElement) {
      const key = Object.keys(button).find(k => k.startsWith("__reactProps$"));
      const props = key ? (button as unknown as Record<string, { onClick?: (e: unknown) => void }>)[key] : undefined;
      if (!props?.onClick) throw new Error("that button has no onClick");
      props.onClick({ preventDefault() {}, stopPropagation() {}, currentTarget: button, target: button });
    },
    focused() {
      return document.activeElement;
    },
  };
}
