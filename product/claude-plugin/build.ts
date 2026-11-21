// Ozzie's plugin for Claude's directory. The folder next to this file, `ozzie/`, is what the directory lists: a plugin
// bundle read from the public repository (Anthropic's developer portal, claude.ai/directory/manage). It holds guidance
// for Claude and one line that starts the read-only helper inside Ozzie for Mac (core/docs/mcp.md); no program of its own.
//
// This script checks that folder against the directory's written rules (claude.com/docs/plugins/pre-submission-checklist.md,
// read 2026-11-21) and Ozzie's own, keeps its version equal to the app's, runs Claude Code's own validator when Claude
// Code is installed, and zips the folder for claude.ai's Customize > Plugins > Upload plugin.
//
//   node product/claude-plugin/build.ts                  check, validate, zip into product/claude-plugin/dist/
//   node product/claude-plugin/build.ts --sync-version   first set plugin.json's version to the app's
//   options: --out <dir> (zip somewhere else), --no-claude (skip Claude Code's validator)
//
// It writes only plugin.json (with --sync-version) and the zip, and reads no church data. Run it on the pinned Node
// (.node-version), which runs TypeScript as it is.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PLUGIN_DIR = join(HERE, "ozzie");
export const REPO = resolve(HERE, "..", "..");
/** The one program the plugin starts: the read-only helper inside Ozzie for Mac, run with nothing added. */
export const HELPER = "/Applications/Ozzie.app/Contents/MacOS/ozzie-share";
export const SKILL = "ozzie-last-check";
/**
 * Every file the plugin holds. A new file is a deliberate change to what the directory reviews: no hooks, agents,
 * commands, scripts or programs ride along unnoticed.
 */
export const PLUGIN_FILES = Object.freeze([
  ".claude-plugin/plugin.json", ".mcp.json", "LICENSE", "README.md", "icon.png", `skills/${SKILL}/SKILL.md`,
]);

/** The app's version, from the desktop app's Tauri configuration (the release's own number). */
export function appVersion(repo = REPO): string {
  const version = (JSON.parse(readFileSync(join(repo, "product/desktop/src-tauri/tauri.conf.json"), "utf8")) as { version?: unknown }).version;
  if (typeof version !== "string" || !version) throw new Error("tauri.conf.json has no version");
  return version;
}

interface Entry { path: string; kind: "file" | "dir" | "other"; size: number }
/** Everything under `dir`, as plugin-relative paths with "/", without following links (a link is "other"). */
function walk(dir: string, prefix = ""): Entry[] {
  const out: Entry[] = [];
  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(join(dir, path));
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
    out.push({ path, kind, size: stat.size });
    if (kind === "dir") out.push(...walk(dir, path));
  }
  return out;
}

const JUNK = new Set([".ds_store", "thumbs.db", "desktop.ini", "__macosx"]);
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const PACKAGE_FILES = new Set(["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", ".npmrc", "bunfig.toml", "uv.toml"]);
const FONT = /\.(?:ttf|otf|woff2?)$/iu;
const KIB = 1024;
/** The manifest keys Claude Code's manifest reference lists (code.claude.com/docs/en/plugins/manifest-reference, read 2026-11-21). */
const MANIFEST_KEYS = new Set(["$schema", "name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords", "metadata",
  "icon", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl", "defaultEnabled", "engines", "dependencies", "network", "userConfig", "types",
  "channels", "skills", "commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles", "workflows", "experimental"]);
/** Keys that add parts beyond the default layout. Ozzie's plugin uses only the default files. */
const COMPONENT_KEYS = ["skills", "commands", "agents", "hooks", "mcpServers", "lspServers", "outputStyles", "workflows", "experimental", "userConfig", "channels", "dependencies"];
const URL_KEYS = ["homepage", "documentationUrl", "supportUrl", "privacyPolicyUrl", "termsOfServiceUrl"];
const RESERVED = new Set(["claude", "anthropic", "anthropics", "official", "plugin", "mcp", "test", "claude-code", "claude-mods"]);
/** Product language (AGENTS.md): words that never appear in what a person reads, outside `code` spans and links. */
export const NOT_PLAIN = /\b(?:MCP|connectors?|tools?|servers?|skills?|sessions?|agents?|logs?|harness)\b/iu;
/** Package launchers and shells (the checklist's "package launcher", plus running a program through a shell). */
const LAUNCHER = /^(?:npx|bunx|pnpm|yarn|uvx|pipx|uv|npm|sh|bash|zsh|env)$/u;
const SECRET = /\b(?:sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/u;

const isPng = (b: Buffer) => b.length > 20 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.subarray(-8, -4).toString("latin1") === "IEND";
const isJpeg = (b: Buffer) => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9;
const isGif = (b: Buffer) => /^GIF8[79]a/u.test(b.subarray(0, 6).toString("latin1")) && b.at(-1) === 0x3b;
const isWebp = (b: Buffer) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
const isImage = (b: Buffer) => isPng(b) || isJpeg(b) || isGif(b) || isWebp(b);
/** Text the directory reads as text: UTF-8 without a NUL byte. */
function isText(b: Buffer): boolean {
  if (b.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}
const httpsUrl = (v: unknown) => { try { return typeof v === "string" && new URL(v).protocol === "https:"; } catch { return false; } };
const printableAscii = (v: unknown) => typeof v === "string" && /^[\x20-\x7e]+$/u.test(v);
/** Words a person reads: `code` spans, fenced blocks and links taken out. */
export const readableWords = (text: string) => text.replace(/```[\s\S]*?```/gu, " ").replace(/`[^`\n]*`/gu, " ").replace(/https?:\/\/\S+/gu, " ").replace(/\S+@\S+\.\w+/gu, " ");

/** A skill's front matter: the lines between the opening and closing `---`, as key to raw value; null when there is none. */
export function frontMatter(text: string): Map<string, string> | null {
  const m = /^---\n([\s\S]*?)\n---\n/u.exec(text);
  if (!m) return null;
  const out = new Map<string, string>();
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z][\w-]*):(?:\s(.*))?$/u.exec(line);
    if (!kv) return null;
    out.set(kv[1]!, (kv[2] ?? "").trim());
  }
  return out;
}

function readJson(file: string, problems: string[], label: string): Record<string, unknown> | null {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); } catch { problems.push(`${label} isn't valid JSON`); return null; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) { problems.push(`${label} isn't a JSON object`); return null; }
  return value as Record<string, unknown>;
}

/**
 * What would stop or hold the plugin in the directory's checks, or break Ozzie's own rules for it, in plain sentences.
 * Empty means every check written here passes. The portal's own Validate and its security scan run more checks than these.
 */
export function pluginProblems(dir = PLUGIN_DIR, version = appVersion()): string[] {
  const problems: string[] = [];
  const entries = walk(dir);
  const files = entries.filter(e => e.kind === "file");

  // Repository and folder layout.
  for (const e of entries) {
    const base = e.path.split("/").at(-1)!;
    if (e.kind === "other") problems.push(`${e.path} is a link or special file; the directory takes only regular files and folders`);
    if (JUNK.has(base.toLowerCase())) problems.push(`${e.path} is a macOS or Windows system file; remove it`);
    if (base.includes(":") || /[. ]$/u.test(base) || DEVICE.test(base) || /[\u0000-\u001f\u007f\\]/u.test(base)) problems.push(`${e.path} isn't a name both Windows and macOS accept`);
    if (PACKAGE_FILES.has(base)) problems.push(`${e.path} is a package-manager file; the plugin installs nothing`);
    if (/\.(?:mcpb|dxt)$/iu.test(base)) problems.push(`${e.path} is a bundle the directory holds for a reviewer; the plugin names the helper instead`);
  }
  const lower = new Map<string, string>();
  for (const e of entries) {
    const key = e.path.toLowerCase();
    if (lower.has(key)) problems.push(`${e.path} and ${lower.get(key)} differ only by capitalization`);
    lower.set(key, e.path);
  }
  if (entries.some(e => e.path === "bin")) problems.push("a top-level bin folder stops claude.ai and Cowork from installing the plugin");
  const listed = files.map(f => f.path).sort();
  if (JSON.stringify(listed) !== JSON.stringify([...PLUGIN_FILES].sort())) problems.push(`the plugin holds ${listed.join(", ")}; it should hold exactly ${[...PLUGIN_FILES].sort().join(", ")}`);
  if (files.length > 512) problems.push("more than 512 files");

  // Files: text, complete images or fonts only; sizes; no credentials.
  for (const f of files) {
    const bytes = readFileSync(join(dir, f.path));
    const image = isImage(bytes);
    if (!image && !FONT.test(f.path) && !isText(bytes)) problems.push(`${f.path} is neither text nor a complete PNG, JPEG, GIF or WebP image`);
    if (f.size > 5 * KIB * KIB) problems.push(`${f.path} is over 5 MiB`);
    if (!image && !FONT.test(f.path) && f.size > 256 * KIB) problems.push(`${f.path} is over 256 KiB, which the directory holds for a reviewer`);
    if (isText(bytes)) {
      const text = bytes.toString("utf8");
      if (SECRET.test(text)) problems.push(`${f.path} holds something that looks like a credential`);
      if (/[–—]/u.test(text)) problems.push(`${f.path} has a dash Ozzie's writing doesn't use (an en or em dash)`);
    }
  }

  // Manifest and plugin name.
  const manifest = readJson(join(dir, ".claude-plugin/plugin.json"), problems, ".claude-plugin/plugin.json");
  if (manifest) {
    const name = manifest["name"];
    if (typeof name !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(name)) problems.push("the name must be lowercase letters, digits and hyphens, up to 64 characters, starting and ending with a letter or digit");
    else if (RESERVED.has(name) || /^(?:claude|anthropics?|cc-plugin)-/u.test(name) || /(?:^|-)(?:claude|anthropics?)(?:-|$)/u.test(name)) problems.push(`the name "${name}" is reserved or reads as Anthropic's own`);
    if (!printableAscii(manifest["displayName"])) problems.push("displayName must be plain letters, digits and punctuation");
    const author = manifest["author"] as { name?: unknown; url?: unknown } | undefined;
    if (typeof author !== "object" || author === null || !printableAscii(author.name)) problems.push("author must have a name in plain letters, digits and punctuation");
    else if (author.url !== undefined && !httpsUrl(author.url)) problems.push("author.url must be an https:// address");
    if (typeof manifest["description"] !== "string" || !manifest["description"]) problems.push("description is missing");
    if (manifest["version"] !== version) problems.push(`version is ${JSON.stringify(manifest["version"])}; the app is ${version} (run with --sync-version)`);
    if (manifest["license"] !== "Apache-2.0") problems.push("license must be Apache-2.0, as the repository's");
    for (const key of Object.keys(manifest)) if (!MANIFEST_KEYS.has(key)) problems.push(`plugin.json has a key Claude Code doesn't know: ${key}`);
    for (const key of COMPONENT_KEYS) if (key in manifest) problems.push(`plugin.json sets ${key}; Ozzie's plugin uses only its default files`);
    for (const key of URL_KEYS) if (key in manifest && !httpsUrl(manifest[key])) problems.push(`${key} must be an https:// address`);
    // Said out loud for the directory's scan: the plugin and the helper it starts reach no host at all.
    if (JSON.stringify(manifest["network"]) !== JSON.stringify({ hosts: [] })) problems.push("plugin.json must declare network.hosts as an empty list: the plugin reaches no host");
    const icon = manifest["icon"];
    if (typeof icon !== "string" || !/^\.\/[\w.-]+\.png$/u.test(icon) || !files.some(f => f.path === icon.slice(2)) || !isPng(readFileSync(join(dir, icon.slice(2))))) {
      problems.push("icon must name a PNG inside the plugin, such as ./icon.png");
    }
    for (const field of ["displayName", "description"] as const) {
      const text = manifest[field];
      if (typeof text === "string" && NOT_PLAIN.test(readableWords(text))) problems.push(`plugin.json ${field} uses a word Ozzie doesn't show people: ${NOT_PLAIN.exec(readableWords(text))![0]}`);
    }
  }

  // README and license.
  if (files.some(f => f.path === "README.md")) {
    const readme = readFileSync(join(dir, "README.md"), "utf8");
    const words = readme.replace(/```[\s\S]*?```/gu, " ").split(/\s+/u).filter(w => /[A-Za-z0-9]/u.test(w));
    if (words.length < 40) problems.push(`README.md has ${words.length} words; the directory needs at least 40 outside code blocks`);
    const odd = NOT_PLAIN.exec(readableWords(readme));
    if (odd) problems.push(`README.md uses a word Ozzie doesn't show people: ${odd[0]}`);
  } else problems.push("README.md is missing");
  if (!files.some(f => f.path === "LICENSE")) problems.push("LICENSE is missing");

  // What the plugin runs: one local program, the helper, with nothing added.
  const mcp = readJson(join(dir, ".mcp.json"), problems, ".mcp.json");
  if (mcp) {
    const servers = mcp["mcpServers"];
    if (Object.keys(mcp).join() !== "mcpServers" || typeof servers !== "object" || servers === null || Array.isArray(servers)) problems.push(".mcp.json must hold only mcpServers");
    else {
      const entries = Object.entries(servers as Record<string, unknown>);
      for (const [key, value] of entries) {
        const s = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
        const command = s["command"];
        if (typeof s["url"] === "string" && !/^(?:https|wss):\/\//u.test(s["url"])) problems.push(`${key}: a remote address must be https:// or wss://`);
        if (typeof command === "string") {
          if (LAUNCHER.test(command.split("/").at(-1) ?? "")) problems.push(`${key}: starts through a launcher or shell (${command})`);
          if (/\$(?!\{CLAUDE_PLUGIN_ROOT\})|`|[*?[\]]/u.test(command)) problems.push(`${key}: the command has a variable, substitution or wildcard`);
        }
      }
      const only = entries.length === 1 && entries[0]![0] === "ozzie" ? entries[0]![1] as Record<string, unknown> : null;
      if (!only || JSON.stringify(only) !== JSON.stringify({ command: HELPER, args: [] })) {
        problems.push(`.mcp.json must start exactly one thing, "ozzie": ${HELPER} with no arguments and nothing else`);
      }
    }
  }

  // Skills: front matter that parses, a name equal to its folder, a description that is one line of text.
  for (const f of files.filter(x => /^skills\/[^/]+\/SKILL\.md$/u.test(x.path))) {
    const folder = f.path.split("/")[1]!;
    const text = readFileSync(join(dir, f.path), "utf8");
    const fm = frontMatter(text);
    if (!fm) { problems.push(`${f.path} has no front matter that parses`); continue; }
    if (fm.get("name") !== folder) problems.push(`${f.path}: name must be "${folder}", its folder`);
    const description = fm.get("description") ?? "";
    if (!description || /^[[\-|>]/u.test(description)) problems.push(`${f.path}: description must be one line of text`);
    const odd = NOT_PLAIN.exec(readableWords(text.replace(/^---\n[\s\S]*?\n---\n/u, `${description}\n`)));
    if (odd) problems.push(`${f.path} uses a word Ozzie doesn't show people: ${odd[0]}`);
  }
  return problems;
}

/** Sets plugin.json's version, writing it in the one layout this script writes (two spaces, a final newline). */
export function syncVersion(dir = PLUGIN_DIR, version = appVersion()): boolean {
  const file = join(dir, ".claude-plugin/plugin.json");
  const text = readFileSync(file, "utf8");
  const manifest = JSON.parse(text) as Record<string, unknown>;
  const next = `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
  if (next === text) return false;
  writeFileSync(file, next);
  return true;
}

/** Claude Code's own validator (`claude plugin validate --strict`), or null when Claude Code isn't installed here. */
export function claudeValidate(dir = PLUGIN_DIR): { version: string; ok: boolean; output: string } | null {
  const v = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (v.error || v.status !== 0) return null;
  const run = spawnSync("claude", ["plugin", "validate", dir, "--strict"], { encoding: "utf8", timeout: 120_000 });
  return { version: v.stdout.trim(), ok: run.status === 0, output: `${run.stdout ?? ""}${run.stderr ?? ""}`.trim() };
}

/** Zips the plugin's files (the folder's contents at the zip's root) and returns the names inside, as unzip lists them. */
export function zipPlugin(outFile: string, dir = PLUGIN_DIR): string[] {
  mkdirSync(dirname(outFile), { recursive: true });
  rmSync(outFile, { force: true });
  const zip = spawnSync("/usr/bin/zip", ["-q", "-X", "-D", outFile, ...PLUGIN_FILES], { cwd: dir, encoding: "utf8" });
  if (zip.status !== 0) throw new Error(`zip failed: ${zip.stderr || zip.error?.message}`);
  const list = spawnSync("/usr/bin/unzip", ["-Z1", outFile], { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`unzip couldn't read it back: ${list.stderr}`);
  return list.stdout.split("\n").filter(Boolean).sort();
}

function main(args: string[]): number {
  const version = appVersion();
  if (args.includes("--sync-version")) console.log(syncVersion(PLUGIN_DIR, version) ? `plugin.json now says ${version}` : `plugin.json already says ${version}`);
  const problems = pluginProblems(PLUGIN_DIR, version);
  if (problems.length) {
    console.error(`The plugin isn't ready (${problems.length}):\n${problems.map(p => `- ${p}`).join("\n")}`);
    return 1;
  }
  console.log(`Ozzie's checks: passed (${PLUGIN_FILES.length} files, version ${version}).`);
  if (!args.includes("--no-claude")) {
    const claude = claudeValidate();
    if (!claude) console.log("Claude Code isn't installed here, so its validator was skipped.");
    else {
      console.log(`Claude Code ${claude.version}, claude plugin validate --strict:\n${claude.output}`);
      if (!claude.ok) return 1;
    }
  }
  const at = args.indexOf("--out");
  const outDir = at >= 0 && args[at + 1] ? resolve(args[at + 1]!) : join(HERE, "dist");
  const outFile = join(outDir, `ozzie-plugin-${version}.zip`);
  const inside = zipPlugin(outFile);
  console.log(`Zipped for Upload plugin: ${outFile}\n${inside.map(n => `  ${n}`).join("\n")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
