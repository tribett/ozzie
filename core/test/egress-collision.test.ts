import { expect, test } from "vitest";
import { EgressBoundary } from "../src/egress.js";

test("original names cannot rewrite an already generated placeholder", () => {
  const boundary = new EgressBoundary("fictional-workspace", ["Alex Example", "Person"]);
  const text = "Alex Example can help.";
  expect(boundary.restoreLocal(boundary.toModel(text))).toBe(text);
});

test("a longer unknown plain placeholder is never partially restored", () => {
  const boundary = new EgressBoundary("fictional-workspace", ["Alex Example"]);
  expect(boundary.restoreLocal("Person-AA can help.")).toBe("Person-AA can help.");
});

test.each(["fictional-workspace", "other-workspace"])("another instance in %s cannot restore these identities", workspace => {
  const first = new EgressBoundary("fictional-workspace", ["Alex Example"]);
  const other = new EgressBoundary(workspace, ["Blair Sample"]);
  expect(() => other.restoreLocal(first.toModel("Alex Example"))).toThrow("fail-closed");
});

test.each([
  "<Person-A@literal> &lt;Person-A&gt; &amp;",
  "Person\u200B-A",
  "Person\u200B\u200B-A",
  "\"<Person-AA>\"\nAlex Example & <literal>",
])("source framing and escape-like text round trips exactly: %s", text => {
  const boundary = new EgressBoundary("fictional-workspace", ["Alex Example"]);
  expect(boundary.restoreLocal(boundary.toModel(text))).toBe(text);
});

test("restored names containing escape-like text are never decoded again", () => {
  const name = "Person\u200B-A &lt;Literal>";
  const boundary = new EgressBoundary("fictional-workspace", [name]);
  expect(boundary.restoreLocal(boundary.toModel(name))).toBe(name);
});

test("overlapping roster names match the longest original name", () => {
  const boundary = new EgressBoundary("fictional-workspace", ["Alex", "Alex Example"]);
  const fullName = boundary.toModel("Alex Example");
  expect(fullName).not.toContain("Example");
  expect(fullName).not.toBe(boundary.toModel("Alex"));
  expect(boundary.restoreLocal(fullName)).toBe("Alex Example");
});

test("more than 26 people have distinct unambiguous placeholders", () => {
  const names = Array.from({ length: 27 }, (_, index) => `Fictional Name ${index}`);
  const boundary = new EgressBoundary("fictional-workspace", names);
  expect(boundary.toModel(names[26]!)).toContain("Person-AA@");
  const text = `${names[0]} and ${names[26]}`;
  expect(boundary.restoreLocal(boundary.toModel(text))).toBe(text);
});

test.each([
  [], [""], ["  "], ["Alex Example", "Alex Example"], ["x".repeat(257)],
  Array.from({ length: 257 }, (_, index) => `Fictional Name ${index}`),
  ["Alex\nExample"], [42], [undefined], Array(1),
].map((names, label) => ({ names, label })))("invalid name roster $label is rejected", ({ names }) => {
  expect(() => new EgressBoundary("fictional-workspace", names as string[])).toThrow("fail-closed");
});

test("invalid text and private configuration are not echoed in errors", () => {
  const boundary = new EgressBoundary("WORKSPACE_CANARY", ["Alex Example"]);
  for (const operation of [
    () => boundary.toModel({ private: "SOURCE_CANARY" } as never),
    () => boundary.restoreLocal(null as never),
    () => boundary.toModel("z".repeat(65_537)),
    () => boundary.toModel("Please pray"),
    () => boundary.toModelPayload({ PRIVATE_FIELD_CANARY: "content" }),
  ]) {
    let message = "";
    try { operation(); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("fail-closed");
    expect(message).not.toMatch(/WORKSPACE_CANARY|SOURCE_CANARY|PRIVATE_FIELD_CANARY/);
  }
});

test("payload accessors never execute or expose their diagnostics", () => {
  const boundary = new EgressBoundary("fictional-workspace", ["Alex Example"]);
  let reads = 0;
  const payload = Object.defineProperty({}, "note", { enumerable: true, get() {
    reads++;
    throw new Error("PRIVATE_GETTER_CANARY");
  } });
  expect(() => boundary.toModelPayload(payload)).toThrow("fail-closed");
  expect(reads).toBe(0);
});

test.each(["<Person-AA>", "<Person-A@unknown>", "<Person-A@unknown", "<Person-A<nested>"])("unsupported framed placeholders fail closed: %s", text => {
  const boundary = new EgressBoundary("fictional-workspace", ["Alex Example"]);
  expect(() => boundary.restoreLocal(text)).toThrow("fail-closed");
});

test("repeated calls and mutable original roster cannot change local mappings", () => {
  const names = ["Alex Example", "Zoë 示例"];
  const boundary = new EgressBoundary("fictional-workspace", names);
  const first = boundary.toModel("Alex Example & Zoë 示例");
  names[0] = "Blair Sample";
  expect(boundary.toModel("Alex Example & Zoë 示例")).toBe(first);
  expect(first).not.toMatch(/Alex Example|Zoë 示例|fictional-workspace/);
  expect(boundary.restoreLocal(first)).toBe("Alex Example & Zoë 示例");
});

test("roster names containing regex syntax, entity text and token syntax restore once", () => {
  const names = ["Alex [Example]", "<Person-A@literal>", "&lt;Fictional>"];
  const boundary = new EgressBoundary("fictional-workspace", names);
  const text = names.join(" + ");
  const encoded = boundary.toModel(text);
  names.forEach(name => expect(encoded).not.toContain(name));
  expect(boundary.restoreLocal(encoded)).toBe(text);
});
