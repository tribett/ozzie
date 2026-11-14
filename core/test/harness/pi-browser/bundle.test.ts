// PiLoop must fit the desktop webview: a browser build of pi-loop.ts (with the pinned Pi packages) imports no
// Node built-in and contains no network or dynamic-loading code. The headless Chrome run is check.mjs.
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build, type Plugin, type Rollup } from "vite";
import { expect, it } from "vitest";

const ENTRY = fileURLToPath(new URL("../../../src/harness/pi-loop.ts", import.meta.url));
const BUILTINS = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);

it("bundles for the browser with no Node built-ins and no network code", async () => {
  const imported: string[] = [];
  const guard: Plugin = { name: "no-node-builtins", enforce: "pre",
    resolveId(id) { if (BUILTINS.has(id) || id.startsWith("node:")) imported.push(id); return null; } };
  const result = await build({ configFile: false, logLevel: "silent", plugins: [guard],
    build: { write: false, minify: true, lib: { entry: ENTRY, formats: ["es"], fileName: "pi-loop" } } });
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  const chunks = outputs.flatMap(output => output.output).filter((item): item is Rollup.OutputChunk => item.type === "chunk");
  expect(imported).toEqual([]);
  expect(chunks).toHaveLength(1); // nothing lazily loaded
  const code = chunks[0]!.code;
  for (const token of [/\bfetch\b/, /XMLHttpRequest/, /WebSocket/, /EventSource/, /sendBeacon/, /importScripts/,
    /\bimport\(/, /\brequire\(/, /\bprocess\.env\b/]) expect(code).not.toMatch(token);
  expect(code).toContain("Run this procedure now. Answer only with the JSON object.");
  // Recorded in the H1 report; a jump here means a Pi upgrade pulled in more than the agent loop.
  expect(code.length).toBeLessThan(260_000);
  expect(gzipSync(code).length).toBeLessThan(70_000);
}, 60_000);
