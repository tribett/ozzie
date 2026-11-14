// The harness must build with the desktop app's own Vite config: the skill files arrive through `?raw`,
// nothing imports a Node built-in or reaches the network, and the built code works on its own. The built
// module is then loaded and runs one fictional Ask end to end with a scripted model.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build, type Plugin, type Rollup } from "vite";
import { expect, it } from "vitest";
import type { AgentStepReply, ModelStep } from "../../src/harness/contract.js";
import type * as Entry from "./bundle/entry.js";
import { harnessData } from "./fixtures.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ENTRY = fileURLToPath(new URL("./bundle/entry.ts", import.meta.url));
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

it("builds with the desktop Vite config, skills included as text, and the built code runs a task", async () => {
  const imported: string[] = [];
  const guard: Plugin = { name: "no-node-builtins", enforce: "pre",
    resolveId(id) { if (BUILTINS.has(id) || id.startsWith("node:")) imported.push(id); return null; } };
  const result = await build({
    configFile: `${ROOT}product/desktop/vite.config.ts`, root: `${ROOT}product/desktop`, logLevel: "silent", plugins: [guard],
    build: { write: false, minify: true, emptyOutDir: false, lib: { entry: ENTRY, formats: ["es"], fileName: "harness" } },
  });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  const chunks = outputs.flatMap(o => o.output).filter((item): item is Rollup.OutputChunk => item.type === "chunk");
  expect(imported).toEqual([]);
  expect(chunks).toHaveLength(1);
  const code = chunks[0]!.code;
  for (const token of [/\bfetch\(/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /\bimport\(/, /\brequire\(/]) expect(code).not.toMatch(token);
  expect(code).toContain("Ozzie answers from the last check of Planning Center and nothing else.");

  const built = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`) as typeof Entry;
  const skills = await built.bundledSkills();
  expect([...skills.keys()].sort()).toEqual(["answer-from-what-was-read", "follow-up-owners", "group-night", "room-check", "sunday-ready", "who-could-help"]);
  for (const file of built.SKILL_FILES) {
    const bytes = readFileSync(new URL(`../../skills/${file.path}`, import.meta.url));
    expect(skills.get(file.path.replace(/\.md$/, ""))!.hash).toBe(createHash("sha256").update(bytes).digest("hex"));
  }

  const replies: AgentStepReply[] = [
    { content: "", tool_calls: [{ id: "c1", name: "sunday.open_needs", arguments: "{}" }], finish: "tool_calls" },
    { content: "{\"answer\":\"facts\",\"facts\":[\"f1\"]}", tool_calls: [], finish: "stop" },
  ];
  let step = 0;
  const model: ModelStep = async () => replies[step++]!;
  const harness = new built.Harness({ workspace_id: "fictional", data: harnessData(), skills, runtime: new built.TsLoop(), model, now: () => "2026-11-20T15:05:00Z" });
  const asked = await harness.ask("What still needs people this Sunday?");
  expect(asked.ok && asked.outcome).toMatchObject({ status: "verified", answer: "{\"answer\":\"facts\",\"facts\":[\"f1\"]}" });
}, 60_000);
