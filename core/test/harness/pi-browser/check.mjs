#!/usr/bin/env node
// H1 go/no-go: build entry.ts (PiLoop + pinned Pi) for the browser with Vite, failing on any Node built-in,
// serve it locally under the desktop app's own CSP (from tauri.conf.json), run it in headless Chrome and
// check the scripted outcomes. Fictional data only; no provider, no Planning Center, no credentials.
// Usage: node core/test/harness/pi-browser/check.mjs [outDir]
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "vite";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = join(here, "../../../..");
const outDir = process.argv[2] ?? mkdtempSync(join(tmpdir(), "pi-browser-"));
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const csp = JSON.parse(readFileSync(join(repo, "product/desktop/src-tauri/tauri.conf.json"), "utf8")).app.security.csp;

const builtins = new Set([...builtinModules, ...builtinModules.map(name => `node:${name}`)]);
const guard = { name: "no-node-builtins", enforce: "pre",
  resolveId(id, importer) { if (builtins.has(id) || id.startsWith("node:")) throw new Error(`Node built-in ${id} from ${importer}`); return null; } };
await build({ configFile: false, root: here, base: "./", logLevel: "warn", plugins: [guard],
  build: { outDir, emptyOutDir: true, minify: true } });

const assets = readdirSync(join(outDir, "assets")).filter(name => name.endsWith(".js"));
const sizes = assets.map(name => { const code = readFileSync(join(outDir, "assets", name));
  return { name, bytes: code.length, gzip: gzipSync(code).length }; });

const types = { ".html": "text/html", ".js": "text/javascript" };
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const file = join(outDir, path === "/" ? "index.html" : path);
  if (!file.startsWith(outDir)) { response.writeHead(403).end(); return; }
  try {
    const body = readFileSync(file);
    response.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "content-security-policy": csp });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const profile = mkdtempSync(join(tmpdir(), "pi-browser-profile-"));
const dom = await new Promise((resolve, reject) => execFile(chrome, ["--headless=new", "--disable-gpu", "--no-first-run",
  "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", `--user-data-dir=${profile}`,
  "--virtual-time-budget=15000", "--dump-dom", url], { timeout: 60_000, maxBuffer: 8 << 20 },
(error, stdout) => error ? reject(error) : resolve(stdout)));
server.close();
rmSync(profile, { recursive: true, force: true });

const text = /<pre id="result">([\s\S]*?)<\/pre>/.exec(dom)?.[1] ?? "";
const result = JSON.parse(text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
const checks = {
  verified: result.verified?.status === "verified" && result.verified.answer === "[Role 1] is open." && result.verified.evidence === 1,
  denied: result.verified?.events?.includes("tool unknown:denied"),
  offeredExactly: JSON.stringify(result.verified?.tools) === JSON.stringify(["sunday.open_needs"]),
  limit: result.limited?.status === "failed" && result.limited.code === "limit" && result.limited.modelSteps === 6,
  cancelled: result.cancelled?.status === "cancelled" && result.cancelled.modelSignalAborted === true,
  noNetwork: Array.isArray(result.network) && result.network.length === 0,
  cspApplied: result.evalBlocked === true,
  onlyOwnScripts:Array.isArray(result.resources) && result.resources.every(path => path.startsWith("/assets/")),
};
console.log(JSON.stringify({ csp, sizes, result, checks }, null, 2));
const pass = Object.values(checks).every(Boolean);
console.log(pass ? "PI BROWSER CHECK: PASS" : "PI BROWSER CHECK: FAIL");
process.exit(pass ? 0 : 1);
